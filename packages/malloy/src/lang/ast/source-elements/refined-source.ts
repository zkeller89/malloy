/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import type {
  AccessModifierLabel,
  AnnotationsDef,
  SourceDef,
} from '../../../model/malloy_types';
import {
  expressionIsCalculation,
  isPersistableSourceDef,
} from '../../../model/malloy_types';

import {RefinedSpace} from '../field-space/refined-space';
import type {HasParameter} from '../parameters/has-parameter';
import {DeclareFields} from '../query-properties/declare-fields';
import {Filter} from '../query-properties/filters';
import {FieldListEdit} from '../source-properties/field-list-edit';
import {PrimaryKey} from '../source-properties/primary-key';
import {Views} from '../source-properties/views';
import type {SourceDesc} from '../types/source-desc';
import {Source} from './source';
import {TimezoneStatement} from '../source-properties/timezone-statement';
import {ObjectAnnotation} from '../types/annotation-elements';
import {Renames} from '../source-properties/renames';
import type {MakeEntry} from '../types/space-entry';
import {
  applyDateSpineMembers,
  checkDateSpineFields,
  DateSpineFrom,
  DateSpineRange,
} from './date-spine-source';
import {ParameterSpace} from '../field-space/parameter-space';
import {JoinStatement} from '../source-properties/join';
import type {IncludeItem} from '../source-query-elements/include-item';
import {
  getIncludeStateForJoin,
  processIncludeList,
} from '../field-space/include-utils';

/**
 * A Source made from a source reference and a set of refinements
 */
export class RefinedSource extends Source {
  elementType = 'refinedSource';
  currentAnnotation?: AnnotationsDef;

  constructor(
    readonly source: Source,
    readonly refinement: SourceDesc,
    readonly includeList: IncludeItem[] | undefined
  ) {
    super({source, refinement});
    if (includeList) {
      this.has({includeList});
    }
  }

  getSourceDef(parameterSpace: ParameterSpace | undefined): SourceDef {
    return this.withParameters(parameterSpace, []);
  }

  withParameters(
    parameterSpace: ParameterSpace | undefined,
    pList: HasParameter[] | undefined
  ): SourceDef {
    let primaryKey: PrimaryKey | undefined;
    let fieldListEdit: FieldListEdit | undefined;
    const fields: MakeEntry[] = [];
    const filters: Filter[] = [];
    let newTimezone: string | undefined;
    const spineFroms: DateSpineFrom[] = [];
    let spineRange: DateSpineRange | undefined;

    const inlineAccessModifiers: {
      access: AccessModifierLabel;
      fields: string[];
    }[] = [];
    for (const el of this.refinement.list) {
      if (el instanceof ObjectAnnotation) {
        // Treat lone annotations as comments
        continue;
      }
      const errTo = el;
      if (el instanceof PrimaryKey) {
        if (primaryKey) {
          const code = 'multiple-primary-keys';
          primaryKey.logError(code, 'Primary key already defined');
          el.logError(code, 'Primary key redefined');
        }
        primaryKey = el;
      } else if (el instanceof FieldListEdit) {
        if (fieldListEdit) {
          const code = 'multiple-field-list-edits';
          fieldListEdit.logError(code, 'Too many accept/except statements');
          el.logError(code, 'Too many accept/except statements');
        }
        fieldListEdit = el;
      } else if (
        el instanceof DeclareFields ||
        el instanceof JoinStatement ||
        el instanceof Views ||
        el instanceof Renames
      ) {
        fields.push(...el.list);
        if (el.accessModifier) {
          inlineAccessModifiers.push({
            fields: el.delarationNames,
            access: el.accessModifier,
          });
        }
      } else if (el instanceof Filter) {
        filters.push(el);
      } else if (el instanceof TimezoneStatement) {
        newTimezone = el.timezoneName();
      } else if (el instanceof DateSpineFrom) {
        spineFroms.push(el);
      } else if (el instanceof DateSpineRange) {
        if (spineRange) {
          el.logError('date-spine-range-invalid', 'spine_range: already set');
        }
        spineRange = el;
      } else {
        errTo.logError(
          'unexpected-source-property',
          `Unexpected source property: '${errTo.elementType}'`
        );
      }
    }

    const paramSpace = pList ? new ParameterSpace(pList) : undefined;
    let baseSourceDef = this.source.getSourceDef(paramSpace);
    if (baseSourceDef.type === 'date_spine') {
      for (const el of this.refinement.list) {
        if (el instanceof JoinStatement) {
          el.logError(
            'date-spine-invalid-member',
            'A date_spine cannot have joins; add sources to date_spine(...) instead'
          );
        }
      }
      baseSourceDef = applyDateSpineMembers(
        baseSourceDef,
        spineFroms,
        spineRange
      );
    } else {
      for (const el of [...spineFroms, ...(spineRange ? [spineRange] : [])]) {
        el.logError(
          'date-spine-from-requires-date-spine',
          `'${el instanceof DateSpineFrom ? 'from' : 'spine_range:'}' can only be used when extending a date_spine`
        );
      }
    }
    // Track the sourceID of the base source for extends tracking
    const baseSourceID = isPersistableSourceDef(baseSourceDef)
      ? baseSourceDef.sourceID
      : undefined;
    const from = {...baseSourceDef};
    const includeState = processIncludeList(this.includeList, from);
    const thisIncludeState = getIncludeStateForJoin([], includeState);
    for (const modifier of inlineAccessModifiers) {
      for (const field of modifier.fields) {
        thisIncludeState.modifiers.set(field, modifier.access);
      }
    }
    // Note that this is explicitly not:
    // const from = this.source.withParameters(parameterSpace, pList);
    // Because the parameters are added to the resulting struct, not the base struct
    if (primaryKey) {
      from.primaryKey = primaryKey.field.name;
    }
    const fs = RefinedSpace.filteredFrom(
      from,
      fieldListEdit,
      includeState,
      paramSpace
    );
    if (newTimezone) {
      fs.setTimezone(newTimezone);
    }
    if (pList) {
      fs.addParameters(pList);
    }
    fs.pushFields(...fields);
    if (primaryKey) {
      const keyDef = primaryKey.field.getField(fs);
      if (keyDef.error) {
        primaryKey.logError(keyDef.error.code, keyDef.error.message);
      }
    }
    fs.addAccessModifiers(thisIncludeState.modifiers);
    fs.addNotes(thisIncludeState.notes);
    const retStruct = fs.structDef();
    if (retStruct.type === 'date_spine') {
      const baseNames = new Set(baseSourceDef.fields.map(f => f.as ?? f.name));
      checkDateSpineFields(
        retStruct.fields.filter(f => !baseNames.has(f.as ?? f.name)),
        this.refinement
      );
    }

    // Clone the filterList to avoid mutating the original source's filters
    const filterList = retStruct.filterList ? [...retStruct.filterList] : [];
    let moreFilters = false;
    for (const filter of filters) {
      for (const el of filter.list) {
        const fc = el.filterCondition(fs);
        if (expressionIsCalculation(fc.expressionType)) {
          el.logError(
            'aggregate-in-source-filter',
            "Can't use aggregate computations in top level filters"
          );
        } else {
          filterList.push({
            ...fc,
            isSourceFilter: true,
          });
          moreFilters = true;
        }
      }
    }
    // Track extension relationship for persistence dependency tracking
    // If the base source has a sourceID, record it in extends
    if (baseSourceID && isPersistableSourceDef(retStruct)) {
      retStruct.extends = baseSourceID;
    }

    if (moreFilters) {
      return {...retStruct, filterList};
    }
    return retStruct;
  }
}
