/*
 * Copyright 2023 Google LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files
 * (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software,
 * and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import type {
  Annotation,
  AtomicFieldDef,
  CompositeSourceDef,
  Expr,
  FieldDef,
  JoinFieldDef,
  Parameter,
  SourceDef,
  SpineFactJoin,
  SpineGroupField,
  SpineJoinDef,
  StructDef,
} from '../../../model/malloy_types';
import {
  expressionIsAggregate,
  isAtomic,
  isPersistableSourceDef,
  isSourceDef,
  isTimeLiteral,
  mkFieldDef,
  mkSafeRecord,
} from '../../../model/malloy_types';
import {mkSourceID} from '../../../model/source_def_utils';
import {ErrorFactory} from '../error-factory';
import type {HasParameter} from '../parameters/has-parameter';
import type {ConstantExpression} from '../expressions/constant-expression';
import type {DocStatement, Document} from '../types/malloy-element';
import {MalloyElement, DocStatementList} from '../types/malloy-element';
import type {Noteable} from '../types/noteable';
import {extendNoteMethod} from '../types/noteable';
import type {SourceQueryElement} from '../source-query-elements/source-query-element';
import {getPartitionCompositeDesc} from '../../composite-source-utils';

export class DefineSource
  extends MalloyElement
  implements DocStatement, Noteable
{
  elementType = 'defineSource';
  constructor(
    readonly name: string,
    readonly sourceExpr: SourceQueryElement | undefined,
    readonly exported: boolean,
    readonly parameters?: HasParameter[] | undefined
  ) {
    super();
    if (sourceExpr) {
      this.has({sourceExpr});
    }
    if (parameters) {
      this.has({parameters});
    }
  }
  readonly isNoteableObj = true;
  extendNote = extendNoteMethod;
  note?: Annotation;

  execute(doc: Document): void {
    if (doc.modelEntry(this.name)) {
      this.logError(
        'source-definition-name-conflict',
        `Cannot redefine '${this.name}'`
      );
      return;
    }
    const theSource = this.sourceExpr?.getSource();
    if (theSource === undefined) {
      return;
    }
    const parameters = this.deduplicatedParameters();
    const structDef = theSource.withParameters(undefined, this.parameters);
    this.validateParameterShadowing(parameters, structDef);
    if (ErrorFactory.didCreate(structDef)) {
      return;
    }
    const entry: StructDef = {
      ...structDef,
      as: this.name,
      location: this.location,
    };
    if (isPersistableSourceDef(entry)) {
      entry.sourceID = mkSourceID(this.name, this.location?.url);
    }
    if (this.note) {
      entry.annotation = structDef.annotation
        ? {...this.note, inherits: structDef.annotation}
        : this.note;
    }
    entry.partitionComposite =
      getPartitionCompositeDesc(
        this.note,
        structDef,
        this.sourceExpr ?? this
      ) ?? structDef.partitionComposite;
    doc.setEntry(this.name, {entry, exported: this.exported});
  }

  private deduplicatedParameters(): HasParameter[] {
    if (this.parameters === undefined) return [];
    const exists = {};
    const out: HasParameter[] = [];
    for (const parameter of this.parameters) {
      if (parameter.name in exists) {
        parameter.logError(
          'parameter-name-conflict',
          `Cannot redefine parameter \`${parameter.name}\``
        );
      }
      exists[parameter.name] = true;
      out.push(parameter);
    }
    return out;
  }

  private validateParameterShadowing(
    parameters: HasParameter[],
    structDef: StructDef
  ) {
    for (const parameter of parameters) {
      if (
        structDef.fields.find(
          field => (field.as ?? field.name) === parameter.name
        )
      ) {
        parameter.logError(
          'parameter-shadowing-field',
          `Illegal shadowing of field \`${parameter.name}\` by parameter with the same name`
        );
      }
    }
  }
}

export class DefineSourceList extends DocStatementList {
  elementType = 'defineSources';
  constructor(sourceList: DefineSource[]) {
    super(sourceList);
  }
}

/** One spine_join: entry as parsed from the grammar. */
export interface SpineJoinSpec {
  alias: string;    // user-facing name (from 'spine_join: alias is source' or defaults to sourceRef)
  sourceRef: string;
  dateField: string; // value of spine_date: (physical column name)
  groupFields: SpineGroupField[]; // spine_group: entries with alias + column
}

export class DefineSpineComposite
  extends MalloyElement
  implements DocStatement, Noteable
{
  elementType = 'defineSpineComposite';
  readonly isNoteableObj = true;
  extendNote = extendNoteMethod;
  note?: Annotation;

  constructor(
    readonly name: string,
    readonly exported: boolean,
    readonly startExpr: ConstantExpression,
    readonly endExpr: ConstantExpression,
    readonly joinSpecs: SpineJoinSpec[],
    readonly parameters?: HasParameter[]
  ) {
    super();
    this.has({startExpr, endExpr});
    if (parameters) this.has({parameters});
  }

  execute(doc: Document): void {
    if (doc.modelEntry(this.name)) {
      this.logError(
        'source-definition-name-conflict',
        `Cannot redefine '${this.name}'`
      );
      return;
    }

    // 1. Validate spine_start / spine_end are time literals
    const startVal = this.startExpr.constantValue();
    if (!isTimeLiteral(startVal.value)) {
      this.startExpr.logError(
        'spine-composite-bad-start',
        'spine_composite spine_start: must be a date or timestamp literal'
      );
      return;
    }
    const endVal = this.endExpr.constantValue();
    if (!isTimeLiteral(endVal.value)) {
      this.endExpr.logError(
        'spine-composite-bad-end',
        'spine_composite spine_end: must be a date or timestamp literal'
      );
      return;
    }

    // 2. Resolve dialect + connection from the first referenced fact source
    let dialect = '';
    let connection = '';
    for (const spec of this.joinSpecs) {
      const factEntry = doc.modelEntry(spec.sourceRef);
      const factDef = factEntry?.entry;
      if (!factDef || !isSourceDef(factDef)) {
        this.logError(
          'spine-composite-bad-fact',
          `spine_join source '${spec.sourceRef}' is not defined or not a source`
        );
        return;
      }
      if (dialect === '') {
        dialect = factDef.dialect;
        connection = factDef.connection;
      }
    }

    // 3. Build parameters (grain::string etc.)
    const parameters = mkSafeRecord<Parameter>();
    if (this.parameters) {
      for (const p of this.parameters) {
        parameters[p.name] = p.parameter();
      }
    }

    // 3. Convert SpineJoinSpec[] → SpineFactJoin[]; collect group field aliases
    const factJoins: SpineFactJoin[] = [];
    const seenGroupAliases = new Set<string>();

    for (const spec of this.joinSpecs) {
      const factDef = doc.modelEntry(spec.sourceRef)?.entry as SourceDef | undefined;
      const resolvedGroupFields: SpineGroupField[] = spec.groupFields.map(gf => {
        if (factDef && isSourceDef(factDef)) {
          const field = factDef.fields.find(
            f => isAtomic(f) && ((f as AtomicFieldDef).as ?? f.name) === gf.column
          ) as AtomicFieldDef | undefined;
          if (field?.e) {
            return {alias: gf.alias, column: gf.column, fieldExpr: field.e};
          }
        }
        return {alias: gf.alias, column: gf.column};
      });
      factJoins.push({
        sourceRef: spec.sourceRef,
        alias: spec.alias,
        dateField: spec.dateField,
        groupFields: resolvedGroupFields,
      });
      for (const gf of spec.groupFields) {
        seenGroupAliases.add(gf.alias);
      }
    }

    // Warn when fact joins have different alias sets — SQL gen uses Cartesian product strategy
    const joinsWithGroups = factJoins.filter(fj => fj.groupFields.length > 0);
    if (joinsWithGroups.length > 1) {
      const firstFingerprint = joinsWithGroups[0].groupFields
        .map(gf => gf.alias)
        .sort()
        .join(',');
      const hasNonUniform = joinsWithGroups.some(
        fj => fj.groupFields.map(gf => gf.alias).sort().join(',') !== firstFingerprint
      );
      if (hasNonUniform) {
        this.logWarning(
          'spine-composite-mismatched-group-aliases',
          `spine_composite '${this.name}': spine_join entries have different spine_group alias sets. ` +
            `The base grid will be a Cartesian product of per-alias distinct values. ` +
            `Fact joins that lack a group alias will have their values duplicated across all values of the missing dimension.`
        );
      }
    }

    // 4. Build the composite field list:
    //    spine_date + one string dim per unique group alias + no measures yet
    //    (measures come from fact sources via composite resolution)
    const groupFieldDefs = [...seenGroupAliases].map(alias =>
      mkFieldDef({type: 'string'}, alias)
    );

    // 5. Build SpineJoinDef — concrete resolved source, handles SQL gen
    const spineJoinDef: SpineJoinDef = {
      type: 'spine_join',
      name: this.name,
      dialect,
      connection,
      spineStart: startVal.value.literal,
      spineEnd: endVal.value.literal,
      spineFactJoins: factJoins,
      fields: [
        mkFieldDef({type: 'timestamp'}, 'spine_date'),
        ...groupFieldDefs,
      ],
      parameters,
    };
    if (this.note) spineJoinDef.annotation = this.note;

    // 6. Wrap in CompositeSourceDef — composite_sources machinery selects SpineJoinDef.
    // The CompositeSourceDef.fields must use {node: 'compositeField'} so that
    // getNonCompositeFields() returns [] and avoids duplicating fields from SpineJoinDef
    // when composite resolution merges nonCompositeFields with sub-source fields.
    // Start with composite versions of the atomic spine fields (spine_date + group dims).
    const compositeFields: FieldDef[] = spineJoinDef.fields.map(f => ({
      ...(f as AtomicFieldDef),
      e: {node: 'compositeField' as const},
    }));

    // 6b. Add each fact join as a JoinFieldDef in SpineJoinDef.fields so that
    //     dep_flights.field is resolvable in the field space.  Aggregate fields are
    //     redefined to SUM(__preagg_<name>) so they match the pre-aggregated subquery
    //     generated at SQL-gen time (no fan-out, correct values).
    for (const spec of this.joinSpecs) {
      const factDef = doc.modelEntry(spec.sourceRef)?.entry as SourceDef;
      if (!factDef || !isSourceDef(factDef)) continue;

      // Build the redefined field list for the join:
      //   - Dimensions: kept as-is
      //   - Aggregate measures: replaced with SUM(__preagg_<name>) pair
      //   - __preagg_count: intrinsic COUNT(*) shadow column for anonymous count()
      const redefinedFields: FieldDef[] = [];
      // Intrinsic shadow column for anonymous count() — maps to COUNT(*) AS __preagg_count
      // in the pre-agg subquery. generateCountFragment detects isSpinePreAgg and emits
      // COALESCE(SUM(__preagg_count), 0) instead of COUNT(DISTINCT __distinct_key).
      redefinedFields.push({type: 'number', name: '__preagg_count'} as AtomicFieldDef);
      for (const f of factDef.fields) {
        if (!isAtomic(f)) continue;
        const af = f as AtomicFieldDef;
        if (expressionIsAggregate(af.expressionType)) {
          // Intrinsic (no expression) shadow column that the pre-agg subquery outputs
          const preaggName = `__preagg_${af.as ?? af.name}`;
          redefinedFields.push({type: af.type, name: preaggName} as AtomicFieldDef);
          // Measure defined as SUM of the shadow column — avoids self-referential recursion
          redefinedFields.push({
            ...af,
            e: {
              node: 'aggregate',
              function: 'sum',
              e: {node: 'field', path: [preaggName]},
            } as Expr,
          });
        } else {
          redefinedFields.push(af);
        }
      }

      // JoinFieldDef embedded in SpineJoinDef.fields for field-space resolution
      const joinField = {
        ...factDef,
        name: spec.alias,
        as: undefined,
        join: 'many' as const,
        matrixOperation: 'left' as const,
        onExpression: undefined,
        primaryKey: undefined,
        // ^ Prevents the fact source's primary key from being used in COUNT(DISTINCT pk) —
        // that column is absent from the pre-aggregated subquery.
        isSpinePreAgg: true,
        // ^ Signals generateCountFragment to use COALESCE(SUM(__preagg_count), 0)
        // for anonymous count() calls, returning true row counts instead of 0/1.
        fields: redefinedFields,
      } as JoinFieldDef;
      spineJoinDef.fields.push(joinField as FieldDef);

      // Composite mirror: type:'composite' ensures getNonCompositeFields() skips it
      // so composite resolution doesn't double-add the join's fields.
      const compositeJoinField = {
        ...factDef,
        type: 'composite' as const,
        name: spec.alias,
        as: undefined,
        join: 'many' as const,
        matrixOperation: 'left' as const,
        onExpression: undefined,
        sources: [],
        fields: factDef.fields
          .filter(isAtomic)
          .map(f => ({
            ...(f as AtomicFieldDef),
            e: {node: 'compositeField' as const},
          })),
      } as FieldDef;
      compositeFields.push(compositeJoinField);
    }
    const entry: CompositeSourceDef = {
      type: 'composite',
      name: this.name,
      dialect,
      connection,
      sources: [spineJoinDef],
      fields: compositeFields,
      parameters,
    };
    if (this.note) entry.annotation = this.note;
    doc.setEntry(this.name, {entry, exported: this.exported});
  }
}
