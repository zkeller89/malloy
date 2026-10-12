/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

/**
 * Resolution of a query against a date_spine source.
 *
 * A date_spine is not a table; it is a plan. Given the first stage of a
 * query, this works out the grain (from `group_by: dspine.<unit>`), the
 * other grouping keys, and which tethered measures are used, then builds
 * one pre-aggregation query per (member, tether date) pair, grouped by
 * exactly the query's keys. The SQL compiler joins those onto a generated
 * date series (see the `date_spine` case in `getStructSourceSQL`).
 *
 * Because each pre-aggregation runs at the query's own grain, every output
 * row of the outer query matches exactly one spine row, so a tethered
 * measure is just `max(<pre-aggregated column>)`. That is exact for every
 * aggregate, including count distinct and average.
 *
 * Row-level `where:` filters (on dspine and shared dimensions) are pushed
 * into every pre-aggregation and removed from the outer stage, so a filter
 * on dspine applies to each event's own date, not the spine period.
 */

import type {
  AtomicFieldDef,
  AtomicTypeDef,
  DateSpinePreAgg,
  DateSpineSourceDef,
  DateSpineTether,
  DateUnit,
  Expr,
  ExprWithKids,
  FieldDef,
  FilterCondition,
  PipeSegment,
  Query,
  QueryFieldDef,
  RefSummary,
  ReduceSegment,
  TimestampUnit,
} from '../model/malloy_types';
import {
  exprHasE,
  exprHasKids,
  expressionIsAggregate,
  expressionIsScalar,
  isAtomic,
  isDateUnit,
  mkFieldDef,
  mkTemporal,
  TD,
} from '../model/malloy_types';
import {exprWalk} from '../model/utils';
import {
  computeQueryGivenUsage,
  getExpandedSegment,
  hasCompositesAnywhere,
  mergeRefSummaries,
  resolveCompositeSources,
} from './composite-source-utils';
import {
  DATE_SPINE_DATE,
  dateSpineMemberFieldName,
} from './ast/source-elements/date-spine-source';
import type {MalloyElement} from './ast/types/malloy-element';

/** Pre-aggregation output column names, shared with the SQL compiler */
export const DS_DATE_COL = '__ds_date';
export function dsKeyCol(i: number): string {
  return `__ds_k${i}`;
}
export function dsMeasureCol(tether: string): string {
  return `__ds_m_${tether}`;
}

class DateSpineQueryError extends Error {}

/**
 * A copy of `e` with `f` applied to each direct child. Unlike `exprMap`,
 * `f` is not applied to `e` itself, so `f` can recurse through this.
 */
function mapKids(e: Expr, f: (e: Expr) => Expr): Expr {
  let ret = {...e};
  if (exprHasKids(e)) {
    const parent: ExprWithKids = {...e, kids: {}};
    for (const [name, kid] of Object.entries(e.kids)) {
      if (Array.isArray(kid)) {
        parent.kids[name] = kid.map(k => f(k));
      } else if (kid !== null) {
        parent.kids[name] = f(kid);
      }
    }
    ret = parent as Expr;
  }
  if (exprHasE(ret)) {
    ret.e = f(ret.e);
  }
  return ret;
}

function fail(message: string): never {
  throw new DateSpineQueryError(message);
}

const GRAIN_ORDER: DateUnit[] = ['day', 'week', 'month', 'quarter', 'year'];

interface Key {
  /** output name of the group_by, also the column name on the spine */
  name: string;
  type: AtomicTypeDef;
  /** the expression with derived dimensions inlined to shared dims */
  row: Expr;
}

export interface ResolvedDateSpine {
  sourceDef: DateSpineSourceDef;
  stage: PipeSegment;
}

/**
 * Resolve `spine` for a query whose first stage is `stage`. Logs to `logTo`
 * and returns undefined if the query cannot run on a date_spine.
 */
export function resolveDateSpine(
  spine: DateSpineSourceDef,
  stage: PipeSegment,
  logTo: MalloyElement
): ResolvedDateSpine | undefined {
  try {
    return resolve(spine, stage);
  } catch (e) {
    if (e instanceof DateSpineQueryError) {
      logTo.logError('date-spine-invalid-query', e.message);
      return undefined;
    }
    throw e;
  }
}

function fieldName(f: FieldDef): string {
  return f.as ?? f.name;
}

function resolve(
  spine: DateSpineSourceDef,
  stage: PipeSegment
): ResolvedDateSpine {
  if (stage.type !== 'reduce' && stage.type !== 'partial') {
    fail(
      'Queries on a date_spine must group_by and aggregate; select: and index: are not supported'
    );
  }
  if (stage.extendSource && stage.extendSource.length > 0) {
    fail('extend: in a query on a date_spine is not supported');
  }

  const fieldsByName = new Map(spine.fields.map(f => [fieldName(f), f]));
  const tethersByName = new Map(spine.tethers.map(t => [t.name, t]));
  const sharedNames = new Set(spine.sharedDims.map(d => d.name));

  /**
   * Inline derived dimensions until the only field references left are
   * the spine date and shared dimensions.
   */
  function inlineRow(e: Expr): Expr {
    if (e.node === 'field') {
      const name = e.path.length === 1 ? e.path[0] : undefined;
      if (name === DATE_SPINE_DATE || (name && sharedNames.has(name))) {
        return e;
      }
      const f = name ? fieldsByName.get(name) : undefined;
      if (f && isAtomic(f) && f.e && expressionIsScalar(f.expressionType)) {
        return inlineRow(f.e);
      }
      fail(`'${e.path.join('.')}' cannot be used as a dimension here`);
    }
    if (
      e.node === 'aggregate' ||
      e.node === 'dateSpineMeasure' ||
      e.node === 'outputField'
    ) {
      fail('Measures cannot be used as dimensions');
    }
    return mapKids(e, inlineRow);
  }

  function usesSpineDate(e: Expr): boolean {
    for (const node of exprWalk(e)) {
      if (node.node === 'field' && node.path[0] === DATE_SPINE_DATE) {
        return true;
      }
    }
    return false;
  }

  function sharedDimsIn(e: Expr): string[] {
    const ret: string[] = [];
    for (const node of exprWalk(e)) {
      if (node.node === 'field' && sharedNames.has(node.path[0])) {
        ret.push(node.path[0]);
      }
    }
    return ret;
  }

  function grainOf(row: Expr): TimestampUnit {
    if (row.node === 'field') {
      return 'day';
    }
    if (
      row.node === 'trunc' &&
      row.e.node === 'field' &&
      row.e.path[0] === DATE_SPINE_DATE
    ) {
      return row.units;
    }
    fail(
      `${DATE_SPINE_DATE} can only be grouped by itself or a truncation such as ${DATE_SPINE_DATE}.month`
    );
  }

  // Tethered measures used by aggregates, found through derived measures
  const usedTethers = new Set<string>();
  const scanned = new Set<string>();
  function scanAggregate(e: Expr) {
    for (const node of exprWalk(e)) {
      switch (node.node) {
        case 'dateSpineMeasure':
          usedTethers.add(node.name);
          break;
        case 'field':
        case 'outputField': {
          const name = node.node === 'field' ? node.path[0] : node.name;
          if (tethersByName.has(name)) {
            usedTethers.add(name);
          } else if (!scanned.has(name)) {
            scanned.add(name);
            const f = fieldsByName.get(name);
            if (
              f &&
              isAtomic(f) &&
              f.e &&
              expressionIsAggregate(f.expressionType)
            ) {
              scanAggregate(f.e);
            }
          }
          break;
        }
        case 'aggregate':
          fail(
            'Aggregates on a date_spine must use tethered measures; define new measures in a `from` block with `at`'
          );
          break;
        case 'filteredExpr':
          fail('Filtered measures are not supported on a date_spine yet');
          break;
        case 'all':
        case 'exclude':
          fail('all() and exclude() are not supported on a date_spine yet');
      }
    }
  }

  // Classify the query fields
  const grains = new Set<TimestampUnit>();
  const keys: Key[] = [];
  const queryFields: QueryFieldDef[] = [];
  for (const qf of stage.queryFields) {
    if (qf.type === 'turtle') {
      fail('nest: is not supported in a query on a date_spine');
    }
    let outName: string;
    let def: AtomicFieldDef;
    if (qf.type === 'fieldref') {
      outName = qf.path[qf.path.length - 1];
      const f = qf.path.length === 1 ? fieldsByName.get(qf.path[0]) : undefined;
      if (f === undefined || !isAtomic(f)) {
        fail(`'${qf.path.join('.')}' is not available on this date_spine`);
      }
      def = f;
    } else {
      outName = fieldName(qf);
      def = qf;
    }
    const e: Expr = def.e ?? {node: 'field', path: [fieldName(def)]};
    if (expressionIsScalar(def.expressionType)) {
      const row = inlineRow(e);
      if (usesSpineDate(row)) {
        if (sharedDimsIn(row).length > 0) {
          fail(
            `'${outName}' mixes ${DATE_SPINE_DATE} with other dimensions, which is not supported`
          );
        }
        grains.add(grainOf(row));
        queryFields.push(qf);
      } else {
        keys.push({name: outName, type: TD.atomicDef(def), row});
        queryFields.push(
          qf.type === 'fieldref'
            ? qf
            : {
                ...qf,
                e: {node: 'field', path: [outName]},
                refSummary: {fieldUsage: [{path: [outName]}]},
              }
        );
      }
    } else {
      if (expressionIsAggregate(def.expressionType)) {
        scanAggregate(e);
      }
      queryFields.push(qf);
    }
  }

  // Filters: row-level ones are pushed into every pre-aggregation
  const pushed: {fc: FilterCondition; row: Expr}[] = [];
  const kept: FilterCondition[] = [];
  for (const fc of [...(spine.filterList ?? []), ...(stage.filterList ?? [])]) {
    if (expressionIsScalar(fc.expressionType)) {
      pushed.push({fc, row: inlineRow(fc.e)});
    } else {
      if (expressionIsAggregate(fc.expressionType)) {
        scanAggregate(fc.e);
      }
      kept.push(fc);
    }
  }

  if (usedTethers.size === 0) {
    fail('A query on a date_spine needs at least one tethered measure');
  }

  const grain = pickGrain(grains);

  // Shared dimensions every used member must map
  const sharedUsed = new Set<string>();
  for (const k of keys) sharedDimsIn(k.row).forEach(n => sharedUsed.add(n));
  for (const p of pushed) sharedDimsIn(p.row).forEach(n => sharedUsed.add(n));

  // One pre-aggregation per (member, tether date)
  const groups = new Map<string, DateSpineTether[]>();
  for (const t of spine.tethers) {
    if (!usedTethers.has(t.name)) continue;
    const gk = `${t.member}:${JSON.stringify(t.at)}`;
    groups.set(gk, [...(groups.get(gk) ?? []), t]);
    for (const dim of sharedUsed) {
      const sd = spine.sharedDims.find(d => d.name === dim);
      if (!sd?.mappedIn.includes(t.member)) {
        fail(
          `Shared dimension '${dim}' is not mapped in '${
            spine.members[t.member].name
          }', which '${t.name}' comes from`
        );
      }
    }
  }

  const queryTimezone = stage.queryTimezone ?? spine.queryTimezone;
  if (queryTimezone === undefined) {
    const zones = new Set(spine.members.map(m => m.def.queryTimezone ?? ''));
    if (zones.size > 1) {
      fail(
        'date_spine members have different timezones; set one with `timezone:` on the date_spine or the query'
      );
    }
  }

  const preaggs: DateSpinePreAgg[] = [...groups.values()].map(tethers =>
    buildPreAgg(spine, tethers, grain, keys, pushed, queryTimezone)
  );

  const sourceDef = resolvedSourceDef(spine, {
    grain,
    keys,
    usedTethers,
    preaggs,
    inlineRow,
    usesSpineDate,
  });

  const resolvedNames = new Set(sourceDef.fields.map(f => fieldName(f)));
  const fieldUsage = (stage.refSummary?.fieldUsage ?? []).filter(fu =>
    resolvedNames.has(fu.path[0])
  );
  const newStage: PipeSegment = {
    ...stage,
    queryFields,
    filterList: kept,
    refSummary: mergeRefSummaries(
      {fieldUsage, givenUsage: stage.refSummary?.givenUsage},
      {fieldUsage: keys.map(k => ({path: [k.name]}))}
    ),
  };
  return {sourceDef, stage: newStage};
}

function pickGrain(grains: Set<TimestampUnit>): DateUnit | undefined {
  if (grains.size === 0) {
    return undefined;
  }
  for (const g of grains) {
    if (!isDateUnit(g)) {
      fail(`${DATE_SPINE_DATE} is a date and cannot be grouped by ${g}`);
    }
  }
  // Weeks don't nest in months, quarters or years
  if (
    grains.has('week') &&
    [...grains].some(g => g !== 'week' && g !== 'day')
  ) {
    fail(`${DATE_SPINE_DATE}.week cannot be mixed with month, quarter or year`);
  }
  return GRAIN_ORDER.find(g => grains.has(g));
}

function fieldPaths(e: Expr): {path: string[]}[] {
  const ret: {path: string[]}[] = [];
  for (const node of exprWalk(e)) {
    if (node.node === 'field') {
      ret.push({path: node.path});
    }
  }
  return ret;
}

function buildPreAgg(
  spine: DateSpineSourceDef,
  tethers: DateSpineTether[],
  grain: DateUnit | undefined,
  keys: Key[],
  pushed: {fc: FilterCondition; row: Expr}[],
  queryTimezone: string | undefined
): DateSpinePreAgg {
  const {member, at, atType, atRefSummary} = tethers[0];
  const memberDef = spine.members[member].def;

  // The tether date as a civil date, cast in the query timezone
  const asDate = mkTemporal(
    atType === 'date'
      ? at
      : {
          node: 'cast',
          safe: false,
          e: at,
          dstType: {type: 'date'},
          srcType: {type: atType},
        },
    'date'
  );

  function toMember(e: Expr): Expr {
    if (e.node === 'field') {
      if (e.path[0] === DATE_SPINE_DATE) {
        return asDate;
      }
      return {...e, path: [dateSpineMemberFieldName('dim', e.path[0])]};
    }
    return mapKids(e, toMember);
  }

  function refsOf(e: Expr): RefSummary | undefined {
    return mergeRefSummaries({fieldUsage: fieldPaths(e)}, atRefSummary);
  }

  const queryFields: QueryFieldDef[] = [];
  if (grain) {
    const dateKey: Expr =
      grain === 'day' ? asDate : {node: 'trunc', e: asDate, units: grain};
    queryFields.push({
      type: 'date',
      name: DS_DATE_COL,
      expressionType: 'scalar',
      e: dateKey,
      refSummary: refsOf(dateKey),
    });
  }
  keys.forEach((k, i) => {
    const e = toMember(k.row);
    queryFields.push({
      ...mkFieldDef(k.type, dsKeyCol(i)),
      expressionType: 'scalar',
      e,
      refSummary: refsOf(e),
    });
  });
  for (const t of tethers) {
    queryFields.push({
      type: 'fieldref',
      path: [dateSpineMemberFieldName('tether', t.name)],
    });
  }

  // A row without a tether date is not an event on the spine
  const hasDate: FilterCondition = {
    node: 'filterCondition',
    code: 'tether date is not null',
    e: {node: 'is-not-null', e: at},
    expressionType: 'scalar',
    refSummary: refsOf(at),
    isSourceFilter: false,
  };
  const filterList: FilterCondition[] = [hasDate];
  for (const p of pushed) {
    const e = toMember(p.row);
    filterList.push({
      node: 'filterCondition',
      code: p.fc.code,
      e,
      expressionType: 'scalar',
      refSummary: mergeRefSummaries(refsOf(e), {
        fieldUsage: [],
        givenUsage: p.fc.refSummary?.givenUsage,
      }),
      isSourceFilter: false,
    });
  }

  const segment: ReduceSegment = {
    type: 'reduce',
    queryFields,
    filterList,
    orderBy: [],
    isRepeated: false,
    queryTimezone,
    refSummary: mergeRefSummaries(
      ...queryFields.map(qf =>
        qf.type === 'fieldref'
          ? {fieldUsage: [{path: qf.path}]}
          : qf.type === 'turtle'
            ? undefined
            : qf.refSummary
      ),
      ...filterList.map(f => f.refSummary)
    ),
    outputStruct: {
      type: 'query_result',
      name: '__ds_preagg',
      connection: memberDef.connection,
      dialect: memberDef.dialect,
      fields: [],
    },
  };
  const expanded = getExpandedSegment(segment, memberDef);
  const query: Query = {
    type: 'query',
    structRef: memberDef,
    pipeline: [expanded],
    givenUsage: computeQueryGivenUsage([expanded]),
  };
  if (hasCompositesAnywhere(memberDef)) {
    query.compositeResolvedSourceDef = resolveCompositeSources(
      memberDef,
      expanded
    ).sourceDef;
  }
  return {
    query,
    measureCols: tethers.map(t => ({
      tether: t.name,
      col: dateSpineMemberFieldName('tether', t.name),
    })),
  };
}

function resolvedSourceDef(
  spine: DateSpineSourceDef,
  r: {
    grain: DateUnit | undefined;
    keys: Key[];
    usedTethers: Set<string>;
    preaggs: DateSpinePreAgg[];
    inlineRow: (e: Expr) => Expr;
    usesSpineDate: (e: Expr) => boolean;
  }
): DateSpineSourceDef {
  const fields: FieldDef[] = [];
  const keyNames = new Set(r.keys.map(k => k.name));
  if (r.grain) {
    fields.push({type: 'date', name: DATE_SPINE_DATE});
    // Dimensions computed only from the spine date still work
    for (const f of spine.fields) {
      const name = fieldName(f);
      if (
        name === DATE_SPINE_DATE ||
        keyNames.has(name) ||
        !isAtomic(f) ||
        !f.e ||
        !expressionIsScalar(f.expressionType)
      ) {
        continue;
      }
      try {
        const row = r.inlineRow(f.e);
        let dateOnly = r.usesSpineDate(row);
        for (const node of exprWalk(row)) {
          if (node.node === 'field' && node.path[0] !== DATE_SPINE_DATE) {
            dateOnly = false;
          }
        }
        if (dateOnly) {
          fields.push(f);
        }
      } catch (e) {
        if (!(e instanceof DateSpineQueryError)) throw e;
      }
    }
  }
  for (const k of r.keys) {
    fields.push(mkFieldDef(k.type, k.name));
  }
  for (const t of spine.tethers) {
    if (!r.usedTethers.has(t.name)) continue;
    const placeholder = spine.fields.find(f => fieldName(f) === t.name);
    if (placeholder === undefined || !isAtomic(placeholder)) continue;
    const col = dsMeasureCol(t.name);
    const type = TD.atomicDef(placeholder);
    fields.push({...mkFieldDef(type, col), accessModifier: 'private'});
    const max: Expr = {
      node: 'aggregate',
      function: 'max',
      e: {node: 'field', path: [col]},
    };
    fields.push({
      ...placeholder,
      e: t.default
        ? {node: 'coalesce', kids: {left: max, right: t.default}}
        : max,
      refSummary: {fieldUsage: [{path: [col]}]},
    });
  }
  // Measures and calculations built from tethered measures
  for (const f of spine.fields) {
    if (
      isAtomic(f) &&
      f.e &&
      f.e.node !== 'dateSpineMeasure' &&
      !expressionIsScalar(f.expressionType)
    ) {
      fields.push(f);
    }
  }
  return {
    ...spine,
    fields,
    filterList: [],
    plan: {
      grain: r.grain,
      keys: r.keys.map(k => k.name),
      preaggs: r.preaggs,
      range:
        r.grain && spine.spineRange
          ? {
              from: truncIsoDate(spine.spineRange.from, r.grain),
              to: truncIsoDate(spine.spineRange.to, r.grain),
            }
          : undefined,
    },
  };
}

/** Truncate an ISO date (YYYY-MM-DD) the way Malloy truncates dates */
export function truncIsoDate(iso: string, unit: DateUnit): string {
  const [y, m, d] = iso.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (unit) {
    case 'day':
      return iso;
    case 'week': {
      // Malloy weeks start on Sunday
      const dt = new Date(Date.UTC(y, m - 1, d));
      dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
      return dt.toISOString().slice(0, 10);
    }
    case 'month':
      return `${y}-${pad(m)}-01`;
    case 'quarter':
      return `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
    case 'year':
      return `${y}-01-01`;
  }
}
