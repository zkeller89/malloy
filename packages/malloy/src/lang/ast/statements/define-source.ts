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
  Parameter,
  SpineFactJoin,
  SpineGroupField,
  SpineJoinDef,
  StructDef,
} from '../../../model/malloy_types';
import {
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
      factJoins.push({
        sourceRef: spec.sourceRef,
        alias: spec.alias,
        dateField: spec.dateField,
        groupFields: spec.groupFields,
      });
      for (const gf of spec.groupFields) {
        seenGroupAliases.add(gf.alias);
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
    const compositeFields: AtomicFieldDef[] = spineJoinDef.fields.map(f => ({
      ...(f as AtomicFieldDef),
      e: {node: 'compositeField' as const},
    }));
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
