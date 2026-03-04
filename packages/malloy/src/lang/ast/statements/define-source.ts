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
  Parameter,
  SpineSourceDef,
  SpineCompositeDef,
  SpineFactJoin,
  SpineGroupSource,
  StructDef,
  FieldDef,
  AtomicFieldDef,
  AggregateExpr,
  Expr,
} from '../../../model/malloy_types';
import {
  isPersistableSourceDef,
  isSourceDef,
  isSpineSourceDef,
  isTemporalType,
  expressionIsAggregate,
  expressionIsScalar,
  mkFieldDef,
  mkSafeRecord,
} from '../../../model/malloy_types';
import {composeSQLExpr} from '../../../model/utils';
import type {SQLExprElement} from '../../../model/utils';
import {annotationToTag} from '../../../annotation';
import type {ConstantExpression} from '../expressions/constant-expression';
import {mkSourceID} from '../../../model/source_def_utils';
import {ErrorFactory} from '../error-factory';
import type {HasParameter} from '../parameters/has-parameter';
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

export class DefineSpineSource
  extends MalloyElement
  implements DocStatement, Noteable
{
  elementType = 'defineSpineSource';
  readonly isNoteableObj = true;
  extendNote = extendNoteMethod;
  note?: Annotation;

  constructor(
    readonly name: string,
    readonly exported: boolean,
    readonly startExpr?: ConstantExpression,
    readonly endExpr?: ConstantExpression,
    readonly parameters?: HasParameter[]
  ) {
    super();
    if (startExpr) this.has({startExpr});
    if (endExpr) this.has({endExpr});
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
    if (!this.startExpr) {
      this.logError('spine-missing-start', 'spine_source requires a start: property');
      return;
    }
    if (!this.endExpr) {
      this.logError('spine-missing-end', 'spine_source requires an end: property');
      return;
    }
    const startVal = this.startExpr.constantValue();
    if (!isTemporalType(startVal.type)) {
      this.startExpr.logError(
        'spine-start-must-be-temporal',
        'start: must be a date or timestamp literal'
      );
      return;
    }
    const endVal = this.endExpr.constantValue();
    if (!isTemporalType(endVal.type)) {
      this.endExpr.logError(
        'spine-end-must-be-temporal',
        'end: must be a date or timestamp literal'
      );
      return;
    }
    const entry: SpineSourceDef = {
      type: 'spine',
      name: this.name,
      fields: [mkFieldDef({type: 'timestamp'}, 'spine_date')],
      location: this.location,
      // connection/dialect are not known at definition time; resolved at query time
      connection: '',
      dialect: '',
      spineStart: startVal.value,
      spineEnd: endVal.value,
    };
    if (this.parameters && this.parameters.length > 0) {
      const params = mkSafeRecord<Parameter>();
      for (const p of this.parameters) {
        params[p.name] = p.parameter();
      }
      entry.parameters = params;
    }
    if (this.note) {
      entry.annotation = this.note;
    }
    doc.setEntry(this.name, {entry, exported: this.exported});
  }
}

export class DefineSpineSourceList extends DocStatementList {
  elementType = 'defineSpineSources';
  constructor(sourceList: DefineSpineSource[]) {
    super(sourceList);
  }
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
    readonly spineRef: string,
    readonly joinRefs: string[],
    readonly parameters?: HasParameter[]
  ) {
    super();
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

    const spineEntry = doc.modelEntry(this.spineRef)?.entry;
    if (!spineEntry || !isSpineSourceDef(spineEntry)) {
      this.logError(
        'spine-composite-bad-spine',
        `'${this.spineRef}' is not a spine_source`
      );
      return;
    }

    if (this.joinRefs.length === 0) {
      this.logError(
        'spine-composite-missing-spine',
        'spine_composite requires at least one spine_join:'
      );
      return;
    }

    const factJoins: SpineFactJoin[] = [];
    const groupSources: SpineGroupSource[] = [];
    const allGroupFieldNames = new Set<string>();
    // Map from fieldName → FieldDef, first source wins for dedup
    const groupFieldDefs = new Map<string, FieldDef>();
    const measuresAdded = new Set<string>();
    // joinEntries: one per SpineFactJoin (a joined table source for the query model)
    const joinEntries: FieldDef[] = [];
    // modifiedMeasures: measures with expressions scoped to the join alias
    const modifiedMeasures: FieldDef[] = [];
    // Inherit connection/dialect from the first fact source
    let inheritedConnection = '';
    let inheritedDialect = '';

    for (const ref of this.joinRefs) {
      const entry = doc.modelEntry(ref)?.entry;
      if (!entry || !isSourceDef(entry)) {
        this.logError(
          'spine-composite-bad-fact',
          `Cannot find source '${ref}'`
        );
        return;
      }

      // Inherit connection/dialect from the first fact source that has one
      if (inheritedConnection === '' && 'connection' in entry && entry.connection) {
        inheritedConnection = entry.connection as string;
        inheritedDialect = (entry as {dialect: string}).dialect ?? '';
      }

      const groupFields: string[] = [];
      // Map dateField → list of measure FieldDefs
      const byDateField = new Map<string, AtomicFieldDef[]>();

      for (const field of entry.fields) {
        if (!('type' in field && 'name' in field)) continue;
        const fieldName = (field as AtomicFieldDef).as ?? field.name;

        if (expressionIsScalar((field as AtomicFieldDef).expressionType)) {
          const tag = annotationToTag((field as AtomicFieldDef).annotation).tag;
          if (tag.has('spine', 'group')) {
            groupFields.push(fieldName);
            allGroupFieldNames.add(fieldName);
            if (!groupFieldDefs.has(fieldName)) {
              groupFieldDefs.set(fieldName, field);
            }
          }
        }

        if (expressionIsAggregate((field as AtomicFieldDef).expressionType)) {
          const tag = annotationToTag((field as AtomicFieldDef).annotation).tag;
          const dateField = tag.text('spine', 'date');
          if (dateField) {
            const dateFieldDef = entry.fields.find(
              f => ((f as AtomicFieldDef).as ?? f.name) === dateField
            );
            if (!dateFieldDef || !isTemporalType(dateFieldDef.type)) {
              this.logError(
                'spine-composite-bad-date-field',
                `## spine.date: '${dateField}' not found or not temporal in '${ref}'`
              );
              continue;
            }
            const measureList = byDateField.get(dateField) ?? [];
            measureList.push(field as AtomicFieldDef);
            byDateField.set(dateField, measureList);
          }
        }
      }

      // One SpineFactJoin per unique dateField used in this source
      for (const [dateField, measureFields] of byDateField) {
        const alias = `${ref}__${dateField}`;
        const measures = measureFields.map(f => f.as ?? f.name);
        factJoins.push({
          sourceRef: ref,
          alias,
          dateField,
          measures,
          groupFields,
        });

        // Build the ON expression for the LEFT JOIN using IR field references so
        // the expression compiler resolves the join alias correctly at SQL-gen time
        // (getAliasIdentifier() appends _0 etc., so raw SQL strings would be wrong).
        // DATE_TRUNC(<grain>, alias.dateField) = spine_date [AND alias.g = g ...]
        const onSrc: SQLExprElement[] = [
          'DATE_TRUNC(',
          {node: 'parameter', path: ['grain']} as Expr,
          ', ',
          {node: 'field', path: [alias, dateField]} as Expr,
          ') = ',
          {node: 'field', path: ['spine_date']} as Expr,
        ];
        for (const g of groupFields) {
          onSrc.push(' AND ');
          onSrc.push({node: 'field', path: [alias, g]} as Expr);
          onSrc.push(' = ');
          onSrc.push({node: 'field', path: [g]} as Expr);
        }
        const onExpression = composeSQLExpr(onSrc);

        // Minimal field defs for the join struct so that
        // {node: 'field', path: [alias, fieldName]} can be resolved by the
        // expression compiler (getFieldByName navigates into the join's nameMap).
        // Re-look up dateFieldDef here (it was scoped to the inner field loop).
        const dateFieldDefForJoin = entry.fields.find(
          f => ((f as AtomicFieldDef).as ?? f.name) === dateField
        ) as AtomicFieldDef;
        const joinFields: FieldDef[] = [
          {type: dateFieldDefForJoin.type, name: dateField} as FieldDef,
          ...groupFields.map(g => {
            const gDef = entry.fields.find(
              f => ((f as AtomicFieldDef).as ?? f.name) === g
            ) as AtomicFieldDef;
            return {type: gDef.type, name: g} as FieldDef;
          }),
        ];

        // Join entry: copy the fact source's struct def so getStructSourceSQL
        // can reconstruct the correct SQL (e.g. inline SQL subquery for sql_select).
        // Override name/as with the alias and add join properties.
        const joinEntry: FieldDef = {
          ...entry,
          name: alias,
          as: alias,
          join: 'many',
          matrixOperation: 'left',
          onExpression,
          fields: joinFields,
        } as unknown as FieldDef;
        joinEntries.push(joinEntry);

        // Modified measures: convert count() to sum(CASE WHEN dateField IS NOT NULL THEN 1 ELSE 0 END)
        // Other aggregates: keep their function but scope field references to the join alias
        for (const measureField of measureFields) {
          const measureName = measureField.as ?? measureField.name;
          if (measuresAdded.has(measureName)) continue;
          measuresAdded.add(measureName);

          const origExpr = measureField.e as AggregateExpr | undefined;
          let newExpr: Expr;
          if (origExpr && origExpr.node === 'aggregate' && origExpr.function === 'count') {
            // Convert count() to sum(CASE WHEN alias.dateField IS NOT NULL THEN 1 ELSE 0 END)
            newExpr = {
              node: 'aggregate',
              function: 'sum',
              structPath: [alias],
              e: {
                node: 'case',
                kids: {
                  caseWhen: [composeSQLExpr([{node: 'field', path: [alias, dateField]} as Expr, ' IS NOT NULL']) as Expr],
                  caseThen: [{node: 'numberLiteral', literal: '1'} as Expr],
                  caseElse: {node: 'numberLiteral', literal: '0'} as Expr,
                },
              },
            } as Expr;
          } else if (origExpr && origExpr.node === 'aggregate') {
            // For other aggregates (sum, avg, etc.), add structPath to scope to the join alias
            newExpr = {
              ...origExpr,
              structPath: [alias],
            } as Expr;
          } else {
            newExpr = origExpr as Expr;
          }

          const modifiedMeasure: AtomicFieldDef = {
            ...measureField,
            e: newExpr,
            // fieldUsage tells the query model which join this measure depends on
            fieldUsage: [{path: [alias], uniqueKeyRequirement: {isCount: false}}],
          };
          modifiedMeasures.push(modifiedMeasure);
        }
      }

      if (groupFields.length > 0) {
        groupSources.push({sourceRef: ref, groupFields});
      }
    }

    const fields: FieldDef[] = [
      mkFieldDef({type: 'timestamp'}, 'spine_date'),
      // Group fields are bare columns in the base (spine × groups) subquery.
      // Strip expressions so the compiler generates a plain column reference
      // rather than trying to evaluate e.g. `carrier_raw` in the composite space.
      ...[...allGroupFieldNames].map(name => {
        const orig = groupFieldDefs.get(name)! as AtomicFieldDef;
        return {type: orig.type, name} as FieldDef;
      }),
      ...joinEntries,
      ...modifiedMeasures,
    ];

    const compositeEntry: SpineCompositeDef = {
      type: 'spine_composite',
      name: this.name,
      fields,
      location: this.location,
      connection: inheritedConnection,
      dialect: inheritedDialect,
      spineSourceRef: this.spineRef,
      spineFactJoins: factJoins,
      spineGroupSources: groupSources,
    };

    if (this.parameters && this.parameters.length > 0) {
      const params = mkSafeRecord<Parameter>();
      for (const p of this.parameters) {
        params[p.name] = p.parameter();
      }
      compositeEntry.parameters = params;
    }

    if (this.note) {
      compositeEntry.annotation = this.note;
    }

    doc.setEntry(this.name, {entry: compositeEntry, exported: this.exported});
  }
}

export class DefineSpineCompositeList extends DocStatementList {
  elementType = 'defineSpineComposites';
  constructor(compositeList: DefineSpineComposite[]) {
    super(compositeList);
  }
}
