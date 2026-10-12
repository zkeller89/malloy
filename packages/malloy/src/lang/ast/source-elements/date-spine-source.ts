/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import type {
  AnnotationsDef,
  AtomicFieldDef,
  DateSpineSourceDef,
  Expr,
  FieldDef,
  SourceDef,
} from '../../../model/malloy_types';
import {
  expressionIsAggregate,
  expressionIsScalar,
  isAtomic,
  mkFieldDef,
  TD,
} from '../../../model/malloy_types';
import {exprWalk} from '../../../model/utils';

import type {ParameterSpace} from '../field-space/parameter-space';
import {StaticSourceSpace} from '../field-space/static-space';
import type {HasParameter} from '../parameters/has-parameter';
import type {
  DimensionFieldDeclaration,
  MeasureFieldDeclaration,
} from '../query-items/field-declaration';
import type {ExpressionDef} from '../types/expression-def';
import type {FieldSpace} from '../types/field-space';
import {MalloyElement} from '../types/malloy-element';
import {Source} from './source';

export const DATE_SPINE_DATE = 'dspine';

/** Name of a from-block field once it is added to its member */
export function dateSpineMemberFieldName(
  kind: 'dim' | 'tether',
  name: string
): string {
  return kind === 'dim' ? `__ds_d_${name}` : `__ds_t_${name}`;
}

/**
 * `date_spine(a, b, ...)`. The only field is the spine date; everything
 * else is added by `from` blocks in an `extend`.
 */
export class DateSpineSource extends Source {
  elementType = 'dateSpineSource';
  currentAnnotation?: AnnotationsDef;

  constructor(readonly members: {name: string; source: Source}[]) {
    super({members: members.map(m => m.source)});
  }

  getSourceDef(parameterSpace: ParameterSpace | undefined): SourceDef {
    return this.withParameters(parameterSpace, []);
  }

  withParameters(
    _parameterSpace: ParameterSpace | undefined,
    _pList: HasParameter[] | undefined
  ): SourceDef {
    const members: DateSpineSourceDef['members'] = [];
    const seen = new Set<string>();
    let connection: string | undefined;
    let dialect = '';
    for (const m of this.members) {
      const def = m.source.getSourceDef(undefined);
      if (seen.has(m.name)) {
        m.source.logError(
          'date-spine-invalid-member',
          `'${m.name}' appears more than once in this date_spine`
        );
        continue;
      }
      seen.add(m.name);
      if (def.type === 'date_spine') {
        m.source.logError(
          'date-spine-invalid-member',
          'A date_spine cannot be a member of another date_spine'
        );
        continue;
      }
      if (Object.keys(def.parameters ?? {}).length > 0) {
        m.source.logError(
          'date-spine-member-has-parameters',
          `date_spine member '${m.name}' has parameters, which are not supported`
        );
        continue;
      }
      if (connection === undefined) {
        connection = def.connection;
        dialect = def.dialect;
      } else if (def.connection !== connection) {
        m.source.logError(
          'date-spine-connection-mismatch',
          `All date_spine members must share one connection; '${def.connection}' differs from '${connection}'`
        );
      }
      members.push({name: m.name, def});
    }
    return {
      type: 'date_spine',
      name: 'date_spine',
      connection: connection ?? '',
      dialect,
      members,
      tethers: [],
      sharedDims: [],
      fields: [{type: 'date', name: DATE_SPINE_DATE}],
    };
  }
}

export interface DateSpineTetherDecl {
  decl: MeasureFieldDeclaration;
  at?: ExpressionDef;
  default?: ExpressionDef;
}

/**
 * `from member { dimension: ...  measure: x is agg() at date_field }`
 */
export class DateSpineFrom extends MalloyElement {
  elementType = 'dateSpineFrom';

  constructor(
    readonly memberName: string,
    readonly dimensions: DimensionFieldDeclaration[],
    readonly measures: DateSpineTetherDecl[]
  ) {
    super();
    this.has({dimensions});
    this.has({measures: measures.map(m => m.decl)});
    this.has({
      tetherDates: measures.flatMap(m => (m.at ? [m.at] : [])),
      tetherDefaults: measures.flatMap(m => (m.default ? [m.default] : [])),
    });
  }
}

/** `spine_range: @2020-01-01 to @2026-12-31` */
export class DateSpineRange extends MalloyElement {
  elementType = 'dateSpineRange';

  constructor(
    readonly from: ExpressionDef,
    readonly to: ExpressionDef
  ) {
    super({from, to});
  }

  /** ISO dates, or undefined (with an error logged) */
  getRange(fs: FieldSpace): {from: string; to: string} | undefined {
    const from = literalDate(this.from.getExpression(fs).value);
    const to = literalDate(this.to.getExpression(fs).value);
    if (from === undefined || to === undefined) {
      this.logError(
        'date-spine-range-invalid',
        'spine_range: needs two date literals, e.g. `spine_range: @2020-01-01 to @2026-12-31`'
      );
      return undefined;
    }
    if (from > to) {
      this.logError(
        'date-spine-range-invalid',
        `spine_range: start ${from} is after end ${to}`
      );
      return undefined;
    }
    return {from, to};
  }
}

function literalDate(value: Expr): string | undefined {
  if (
    value.node === 'dateLiteral' ||
    value.node === 'timestampLiteral' ||
    value.node === 'timestamptzLiteral'
  ) {
    return value.literal.slice(0, 10);
  }
  return undefined;
}

/**
 * Compile the `from` blocks of an `extend` on a date_spine. Each block's
 * dimensions and tethered measures are compiled in the member's namespace
 * and added to the member under internal names (so `hires is hires at
 * hire_date` is not a redefinition), and the date_spine gains a shared
 * dimension column or a tethered-measure placeholder for each.
 */
export function applyDateSpineMembers(
  spine: DateSpineSourceDef,
  froms: DateSpineFrom[],
  range: DateSpineRange | undefined
): DateSpineSourceDef {
  const members = spine.members.map(m => ({
    ...m,
    def: {...m.def, fields: [...m.def.fields]},
  }));
  const tethers = [...spine.tethers];
  const sharedDims = spine.sharedDims.map(d => ({
    ...d,
    mappedIn: [...d.mappedIn],
  }));
  const fields: FieldDef[] = [...spine.fields];
  const spineField = (name: string) => fields.find(f => f.name === name);

  for (const from of froms) {
    const memberIndex = members.findIndex(m => m.name === from.memberName);
    if (memberIndex < 0) {
      from.logError(
        'date-spine-member-not-found',
        `'${from.memberName}' is not a member of this date_spine`
      );
      continue;
    }
    const member = members[memberIndex];
    // Evaluate against the member as declared, not as extended by earlier
    // from blocks; the internal names are not for users to reference.
    const space = new StaticSourceSpace(
      spine.members[memberIndex]?.def ?? member.def,
      'public'
    );

    for (const dim of from.dimensions) {
      const name = dim.defineName;
      const fd = dim.queryFieldDef(
        space,
        dateSpineMemberFieldName('dim', name)
      );
      if (fd.type === 'error') {
        continue;
      }
      if (!expressionIsScalar(fd.expressionType)) {
        dim.logError(
          'date-spine-dimension-type-mismatch',
          `Shared dimension '${name}' must be a scalar expression`
        );
        continue;
      }
      if (name === DATE_SPINE_DATE) {
        dim.logError(
          'date-spine-duplicate-name',
          `'${DATE_SPINE_DATE}' is the spine date and cannot be redefined`
        );
        continue;
      }
      let shared = sharedDims.find(d => d.name === name);
      const existing = spineField(name);
      if (shared === undefined) {
        if (existing) {
          dim.logError(
            'date-spine-duplicate-name',
            `'${name}' is already defined in this date_spine`
          );
          continue;
        }
        shared = {name, mappedIn: []};
        sharedDims.push(shared);
        fields.push(mkFieldDef(TD.atomicDef(fd), name));
      } else {
        if (shared.mappedIn.includes(memberIndex)) {
          dim.logError(
            'date-spine-duplicate-name',
            `'${name}' is already mapped for member '${member.name}'`
          );
          continue;
        }
        if (existing && isAtomic(existing) && !TD.eq(existing, fd)) {
          dim.logError(
            'date-spine-dimension-type-mismatch',
            `Shared dimension '${name}' is ${fd.type} in '${member.name}' but ${existing.type} elsewhere`
          );
          continue;
        }
      }
      shared.mappedIn.push(memberIndex);
      member.def.fields.push(fd);
    }

    for (const m of from.measures) {
      const name = m.decl.defineName;
      const fd = m.decl.queryFieldDef(
        space,
        dateSpineMemberFieldName('tether', name)
      );
      if (fd.type === 'error') {
        continue;
      }
      if (!expressionIsAggregate(fd.expressionType)) {
        m.decl.logError(
          'date-spine-tether-not-aggregate',
          `Tethered measure '${name}' must be an aggregate`
        );
        continue;
      }
      if (m.at === undefined) {
        m.decl.logError(
          'date-spine-missing-at',
          `Tethered measure '${name}' needs a date to tether to, e.g. \`${name} is count() at created_at\``
        );
        continue;
      }
      const at = m.at.getExpression(space);
      if (at.type === 'error') {
        continue;
      }
      if (
        !(
          at.type === 'date' ||
          at.type === 'timestamp' ||
          at.type === 'timestamptz'
        ) ||
        !expressionIsScalar(at.expressionType)
      ) {
        m.at.logError(
          'date-spine-at-not-temporal',
          `'${name}' must be tethered to a date or timestamp dimension, not ${at.type}`
        );
        continue;
      }
      let defaultValue: Expr | undefined = undefined;
      if (m.default) {
        const dv = m.default.getExpression(space);
        if (dv.evalSpace !== 'constant' && dv.evalSpace !== 'literal') {
          m.default.logError(
            'date-spine-default-not-constant',
            `The default for '${name}' must be a constant`
          );
          continue;
        }
        if (dv.type !== 'null' && dv.type !== fd.type) {
          m.default.logError(
            'date-spine-default-type-mismatch',
            `The default for '${name}' is ${dv.type}, but the measure is ${fd.type}`
          );
          continue;
        }
        defaultValue = dv.value;
      }
      if (spineField(name)) {
        m.decl.logError(
          'date-spine-duplicate-name',
          `'${name}' is already defined in this date_spine`
        );
        continue;
      }
      member.def.fields.push(fd);
      tethers.push({
        name,
        member: memberIndex,
        at: at.value,
        atRefSummary: at.refSummary,
        atType: at.type,
        default: defaultValue,
      });
      const placeholder: AtomicFieldDef = {
        ...mkFieldDef(TD.atomicDef(fd), name),
        expressionType: 'aggregate',
        e: {node: 'dateSpineMeasure', name},
        refSummary: {fieldUsage: [{path: [name], at: m.decl.location}]},
      };
      if (fd.annotations) {
        placeholder.annotations = fd.annotations;
      }
      fields.push(placeholder);
    }
  }

  const ret: DateSpineSourceDef = {
    ...spine,
    members,
    tethers,
    sharedDims,
    fields,
  };
  const spineRange = range?.getRange(new StaticSourceSpace(ret, 'public'));
  if (spineRange) {
    ret.spineRange = spineRange;
  }
  return ret;
}

/**
 * Measures written on the date_spine itself may only combine tethered
 * measures; an aggregate computed directly on the spine has no rows to
 * aggregate over.
 */
export function checkDateSpineFields(
  newFields: FieldDef[],
  logTo: MalloyElement
): void {
  for (const f of newFields) {
    if (!isAtomic(f) || f.e === undefined) continue;
    for (const node of exprWalk(f.e)) {
      if (node.node === 'aggregate') {
        logTo.logError(
          'date-spine-untethered-aggregate',
          `'${f.name}' aggregates directly on the date_spine; define it in a \`from\` block with \`at\`, or combine tethered measures`
        );
        break;
      }
    }
  }
}
