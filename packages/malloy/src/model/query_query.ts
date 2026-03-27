/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import type {DialectFieldList} from '../dialect';
import {exprToSQL, expandFunctionCall} from './expression_compiler';
import type {
  Expr,
  TurtleDef,
  IndexFieldDef,
  IndexSegment,
  RefToField,
  QueryResultDef,
  StructDef,
  ResultStructMetadataDef,
  ResultMetadataDef,
  PipeSegment,
  QuerySegment,
  QueryFieldDef,
  SegmentFieldDef,
  FieldDef,
  RepeatedRecordDef,
  RecordDef,
  TemporalTypeDef,
  NestSourceDef,
  FinalizeSourceDef,
  OrderBy,
  Expression,
  TurtleDefPlusFilters,
  UniqueKeyRequirement,
  Query,
  PrepareResultOptions,
  SpineJoinDef,
  SpineFactJoin,
  SpineGroupField,
  StringLiteralNode,
  NumberLiteralNode,
  GenericSQLExpr,
  FunctionCallNode,
  BinaryExpr,
  UnaryExpr,
  FieldnameNode,
  SourceDef,
  AggregateExpr,
  JoinBase,
} from './malloy_types';
import {
  isRawSegment,
  isSourceDef,
  isQuerySegment,
  hasExpression,
  isAtomic,
  expressionIsAggregate,
  expressionIsCalculation,
  expressionIsScalar,
  getIdentifier,
  isJoinedSource,
  isBasicArray,
  isIndexSegment,
  isBaseTable,
  expressionIsAnalytic,
  isTemporalType,
  safeRecordGet,
} from './malloy_types';
import {
  AndChain,
  indent,
  getDialectFieldList,
  groupingKey,
  caseGroup,
} from './utils';
import type {JoinInstance} from './join_instance';
import {
  QueryStruct,
  isBasicAggregate,
  isBasicCalculation,
  isBasicScalar,
  isScalarField,
  QueryAtomicField,
  QueryFieldBoolean,
  QueryFieldStruct,
  QueryField,
} from './query_node';
import {StageWriter} from './stage_writer';
import type {FieldInstance} from './field_instance';
import {
  FieldInstanceField,
  FieldInstanceResult,
  FieldInstanceResultRoot,
  sqlFullChildReference,
} from './field_instance';
import type * as Malloy from '@malloydata/malloy-interfaces';
import {getCompiledSQL} from './sql_compiled';
import {mkBuildID} from './source_def_utils';

function pathToCol(path: string[]): string {
  return path.map(el => encodeURIComponent(el)).join('/');
}

interface OutputPipelinedSQL {
  sqlFieldName: string;
  pipelineSQL: string;
}

type StageGroupMaping = {fromGroup: number; toGroup: number};

type StageOutputContext = {
  sql: string[]; // sql expressions
  lateralJoinSQLExpressions: string[];
  dimensionIndexes: number[]; // which indexes are dimensions
  fieldIndex: number;
  groupsAggregated: StageGroupMaping[]; // which groups were aggregated
  outputPipelinedSQL: OutputPipelinedSQL[]; // secondary stages for turtles.
};

interface DialectFieldArg {
  fieldDef: FieldDef;
  sqlExpression: string;
  sqlOutputName: string;
  rawName: string;
}

function pushDialectField(dl: DialectFieldList, f: DialectFieldArg) {
  const {sqlExpression, sqlOutputName, rawName} = f;
  if (isAtomic(f.fieldDef)) {
    dl.push({typeDef: f.fieldDef, sqlExpression, sqlOutputName, rawName});
  }
}

const SPINE_VALID_GRAINS = new Set([
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);

function validateSpineGrain(grain: string): void {
  if (!SPINE_VALID_GRAINS.has(grain)) {
    throw new Error(
      `Invalid spine grain '${grain}'. ` +
        `Valid values are: ${[...SPINE_VALID_GRAINS].join(', ')}`
    );
  }
}

/** Query builder object. */
export class QueryQuery extends QueryField {
  fieldDef: TurtleDef;
  firstSegment: PipeSegment;
  prepared = false;
  maxDepth = 0;
  maxGroupSet = 0;
  rootResult: FieldInstanceResultRoot;
  resultStage: string | undefined;
  stageWriter: StageWriter | undefined;
  isJoinedSubquery: boolean; // this query is a joined subquery.
  // circularity breaker, we pass a lambda in to look up struct names, so
  // query_query doesn't have to include query_model because query_model
  // needs to include query_query. don't love this solution
  protected structRefToQueryStruct: (name: string) => QueryStruct | undefined;
  // Maps spine pre-agg join QueryStruct → raw column names that need SUM(col) AS __preagg_col
  // in the pre-agg subquery. Populated by scanForSpineRawColSums() before SQL generation.
  private spineExtraRawCols?: Map<QueryStruct, Set<string>>;
  // Maps spine pre-agg join QueryStruct → raw column names that need SUM+COUNT injected
  // for decomposed AVG: SUM(col) AS __preagg_sum_col, COUNT(col) AS __preagg_count_col.
  // Populated by scanForSpineRawColAvgs() before SQL generation.
  private spineExtraRawColAvgs?: Map<QueryStruct, Set<string>>;

  constructor(
    fieldDef: TurtleDef,
    parent: QueryStruct,
    stageWriter: StageWriter | undefined,
    isJoinedSubquery: boolean,
    lookupStruct: (name: string) => QueryStruct | undefined
  ) {
    super(fieldDef, parent);
    this.fieldDef = fieldDef;
    this.rootResult = new FieldInstanceResultRoot(fieldDef);
    this.stageWriter = stageWriter;
    // do some magic here to get the first segment.
    this.firstSegment = fieldDef.pipeline[0] as QuerySegment;
    this.isJoinedSubquery = isJoinedSubquery;
    this.structRefToQueryStruct = lookupStruct;
  }

  static makeQuery(
    fieldDef: TurtleDef,
    parentStruct: QueryStruct,
    stageWriter: StageWriter | undefined = undefined,
    isJoinedSubquery: boolean,
    lookupStruct: (name: string) => QueryStruct | undefined
  ): QueryQuery {
    let parent = parentStruct;

    let turtleWithFilters =
      parentStruct.applyStructFiltersToTurtleDef(fieldDef);
    const firstStage = turtleWithFilters.pipeline[0];
    const sourceDef = parentStruct.structDef;

    // if we are generating code
    //  and have extended declaration, we need to make a new QueryStruct
    //  copy the definitions into a new structdef
    //  edit the declations from the pipeline
    if (
      stageWriter !== undefined &&
      isQuerySegment(firstStage) &&
      firstStage.extendSource !== undefined
    ) {
      parent = new QueryStruct(
        {
          ...sourceDef,
          fields: [...sourceDef.fields, ...firstStage.extendSource],
        },
        parentStruct.sourceArguments,
        parent.parent ? {struct: parent} : {model: parent.getModel()},
        parent.prepareResultOptions
      );
      turtleWithFilters = {
        ...turtleWithFilters,
        pipeline: [
          {
            ...firstStage,
            extendSource: undefined,
          },
          ...turtleWithFilters.pipeline.slice(1),
        ],
      };
    }

    if (
      isSourceDef(sourceDef) &&
      sourceDef.queryTimezone &&
      isQuerySegment(firstStage) &&
      firstStage.queryTimezone === undefined
    ) {
      firstStage.queryTimezone = sourceDef.queryTimezone;
    }

    switch (firstStage.type) {
      case 'reduce':
        return new QueryQueryReduce(
          turtleWithFilters,
          parent,
          stageWriter,
          isJoinedSubquery,
          lookupStruct
        );
      case 'project':
        return new QueryQueryProject(
          turtleWithFilters,
          parent,
          stageWriter,
          isJoinedSubquery,
          lookupStruct
        );
      case 'index':
        return new QueryQueryIndex(
          turtleWithFilters,
          parent,
          stageWriter,
          isJoinedSubquery,
          lookupStruct
        );
      case 'raw':
        return new QueryQueryRaw(
          turtleWithFilters,
          parent,
          stageWriter,
          isJoinedSubquery,
          lookupStruct
        );
      case 'partial':
        throw new Error('Attempt to make query out of partial stage');
    }
  }

  inNestedPipeline(): boolean {
    return this.parent.structDef.type === 'nest_source';
  }

  // get a field ref and expand it.
  expandField(f: QueryFieldDef) {
    const field =
      f.type === 'fieldref'
        ? this.parent.getQueryFieldReference(f)
        : this.parent.makeQueryField(f);
    const as = field.getIdentifier();
    return {as, field};
  }

  private addDependantPath(
    path: string[],
    uniqueKeyRequirement: UniqueKeyRequirement
  ) {
    const node = this.parent.getFieldByName(path);
    const joinableParent =
      node instanceof QueryFieldStruct
        ? node.queryStruct.getJoinableParent()
        : node.parent.getJoinableParent();
    this.rootResult.addStructToJoin(joinableParent, uniqueKeyRequirement);
  }

  private dependenciesFromFieldUsage() {
    const resultRoot = this.rootResult;
    // Only QuerySegment and IndexSegment have fieldUsage, RawSegment does not
    if (
      this.firstSegment.type === 'raw' ||
      this.firstSegment.type === 'partial'
    ) {
      throw new Error('QueryQuery attempt to load a raw or partial segment');
    }

    for (const joinUsage of this.firstSegment.activeJoins || []) {
      this.addDependantPath(joinUsage.path, undefined);
    }
    for (const usage of this.firstSegment.expandedFieldUsage || []) {
      if (usage.analyticFunctionUse) {
        resultRoot.queryUsesPartitioning = true;

        // BigQuery-specific handling
        if (
          this.parent.dialect.cantPartitionWindowFunctionsOnExpressions &&
          resultRoot.firstSegment.type === 'reduce'
        ) {
          // force the use of a lateral_join_bag
          resultRoot.isComplexQuery = true;
          resultRoot.queryUsesPartitioning = true;
        }
        continue;
      }
      if (usage.uniqueKeyRequirement) {
        if (usage.path.length === 0) {
          resultRoot.addStructToJoin(this.parent, usage.uniqueKeyRequirement);
        } else {
          this.addDependantPath(usage.path, usage.uniqueKeyRequirement);
        }
      }
    }

    const expandedUngroupings =
      'expandedUngroupings' in this.firstSegment
        ? this.firstSegment.expandedUngroupings || []
        : [];

    for (const ungrouping of expandedUngroupings) {
      resultRoot.isComplexQuery = true;
      resultRoot.queryUsesPartitioning = true;

      // Navigate to correct result struct using ungrouping's path
      let destResult: FieldInstanceResult = resultRoot;
      for (const pathSegment of ungrouping.path) {
        const nextStruct = destResult.allFields.get(pathSegment);
        if (!(nextStruct instanceof FieldInstanceResult)) {
          throw new Error(
            `Ungroup path ${ungrouping.path.join(
              '.'
            )} segment '${pathSegment}' is not a nested query`
          );
        }
        destResult = nextStruct;
      }

      destResult.resultUsesUngrouped = true;

      if (ungrouping.refFields && ungrouping.refFields.length > 0) {
        const refType = ungrouping.exclude ? 'exclude' : 'all';
        const key = groupingKey(refType, ungrouping.refFields);
        if (destResult.ungroupedSets.get(key) === undefined) {
          destResult.ungroupedSets.set(key, {
            type: refType,
            fields: ungrouping.refFields,
            groupSet: -1,
          });
        }
      }

      destResult.resultUsesUngrouped = true;

      if (ungrouping.refFields && ungrouping.refFields.length > 0) {
        const refType = ungrouping.exclude ? 'exclude' : 'all';
        const key = groupingKey(refType, ungrouping.refFields);
        if (destResult.ungroupedSets.get(key) === undefined) {
          destResult.ungroupedSets.set(key, {
            type: refType,
            fields: ungrouping.refFields,
            groupSet: -1,
          });
        }
      }
    }
  }

  getSegmentFields(resultStruct: FieldInstanceResult): SegmentFieldDef[] {
    const fs = resultStruct.firstSegment;
    return fs.type === 'index'
      ? fs.indexFields
      : isQuerySegment(fs)
        ? fs.queryFields
        : [];
  }

  private getDrillExpression(f: QueryFieldDef): Malloy.Expression | undefined {
    if (isAtomic(f) || f.type === 'fieldref') return f.drillExpression;
    return undefined;
  }

  expandFields(resultStruct: FieldInstanceResult) {
    let resultIndex = 1;
    for (const f of this.getSegmentFields(resultStruct)) {
      const {as, field} = this.expandField(f);
      const drillExpression = this.getDrillExpression(f);

      if (field instanceof QueryQuery) {
        if (this.firstSegment.type === 'project') {
          throw new Error(
            `Nested views cannot be used in select - '${field.fieldDef.name}'`
          );
        }
        const fir = new FieldInstanceResult(
          field.fieldDef as TurtleDef,
          resultStruct
        );
        this.expandFields(fir);
        resultStruct.add(as, fir);
      } else if (field instanceof QueryAtomicField) {
        resultStruct.addField(
          as,
          field,
          {
            resultIndex,
            type: 'result',
          },
          drillExpression
        );

        if (
          hasExpression(field.fieldDef) &&
          expressionIsAnalytic(field.fieldDef.expressionType) &&
          this.parent.dialect.cantPartitionWindowFunctionsOnExpressions &&
          resultStruct.firstSegment.type === 'reduce'
        ) {
          resultStruct.root().isComplexQuery = true;
          resultStruct.root().queryUsesPartitioning = true;
        }

        if (isBasicAggregate(field)) {
          if (this.firstSegment.type === 'project') {
            throw new Error(
              `Aggregate Fields cannot be used in select - '${field.fieldDef.name}'`
            );
          }
        }
      } else if (field instanceof QueryFieldStruct) {
        resultStruct.addField(
          as,
          field,
          {
            resultIndex,
            type: 'result',
          },
          drillExpression
        );
      }
      resultIndex++;
    }
  }

  /**
   * Recursively walks the input QueryStruct tree and sets up lazy expression
   * compilation for all records with computed expressions, so that records with
   * expression values have the correct context for evaluating them if needed.
   *
   * @param resultStruct - The FieldInstanceResult containing compilation context
   * @param source - The QueryStruct to traverse (initially the query's parent/input)
   */
  expandRecordExpressions(
    resultStruct: FieldInstanceResult,
    source: QueryStruct
  ) {
    for (const field of source.nameMap.values()) {
      if (field instanceof QueryFieldStruct) {
        const qs = field.queryStruct;

        // Set up closure if this is a record with expression
        if (
          qs.structDef.type === 'record' &&
          hasExpression(qs.structDef) &&
          qs.parent
        ) {
          const parent = qs.parent;
          const e = qs.structDef.e;
          qs.computeRecordExpression = () => exprToSQL(resultStruct, parent, e);
        }

        // Recurse into this structure
        this.expandRecordExpressions(resultStruct, qs);
      }
    }
  }

  generateSQLFilters(
    resultStruct: FieldInstanceResult,
    which: 'where' | 'having'
    // filterList: FilterCondition[] | undefined = undefined
  ): AndChain {
    const resultFilters = new AndChain();
    const list = resultStruct.firstSegment.filterList;
    if (list === undefined) {
      return resultFilters;
    }
    // Go through the filters and make or find dependant fields
    //  add them to the field index. Place the individual filters
    // in the correct catgory.
    for (const cond of list || []) {
      const context = this.parent;

      if (
        (which === 'having' && expressionIsCalculation(cond.expressionType)) ||
        (which === 'where' && expressionIsScalar(cond.expressionType))
      ) {
        const sqlClause = exprToSQL(resultStruct, context, cond.e, undefined);
        resultFilters.add(sqlClause);
      }
    }
    return resultFilters;
  }

  prepare(_stageWriter: StageWriter | undefined) {
    if (!this.prepared) {
      this.expandRecordExpressions(this.rootResult, this.parent);
      // Add the root base join to the joins map
      this.rootResult.addStructToJoin(this.parent, undefined);

      // Expand fields (just adds them to result, no dependency tracking)
      this.expandFields(this.rootResult);

      // Process all dependencies from translator's fieldUsage
      this.dependenciesFromFieldUsage();

      // Handle always joins
      this.addAlwaysJoins();

      // Calculate symmetric aggregates based on the joins
      this.rootResult.calculateSymmetricAggregates();

      this.prepared = true;
    }
  }

  private findJoins(resultStruct: FieldInstanceResult): void {
    for (const dim of resultStruct.fields()) {
      if (!(dim.f instanceof QueryFieldStruct)) {
        resultStruct.addStructToJoin(dim.f.getJoinableParent(), undefined);
      }
    }

    for (const s of resultStruct.structs()) {
      this.findJoins(s);
    }
  }

  addAlwaysJoins() {
    const stage = this.fieldDef.pipeline[0];
    if (stage.type !== 'raw') {
      const alwaysJoins = stage.alwaysJoins ?? [];
      for (const joinName of alwaysJoins) {
        const qs = this.parent.getChildByName(joinName);
        if (qs instanceof QueryFieldStruct) {
          this.rootResult.addStructToJoin(qs.queryStruct, undefined);
        }
      }
    }
  }

  // get the source fieldname and filters associated with the field (so we can drill later)
  getResultMetadata(
    fi: FieldInstance
  ): ResultStructMetadataDef | ResultMetadataDef | undefined {
    if (fi instanceof FieldInstanceField) {
      if (fi.fieldUsage.type === 'result') {
        // const fieldDef = fi.f.fieldDef as AtomicField;
        const fieldDef = fi.f.fieldDef;
        let filterList;
        const sourceField =
          fi.f.parent.getFullOutputName() +
          (fieldDef.name || fieldDef.as || 'undefined');
        const sourceExpression = hasExpression(fieldDef)
          ? fieldDef.code
          : undefined;
        const sourceClasses = [sourceField];
        const referenceId = fi.f.referenceId;
        const drillExpression = fi.drillExpression;
        const base = {
          sourceField,
          sourceExpression,
          sourceClasses,
          referenceId,
          drillExpression,
        };
        if (isBasicCalculation(fi.f)) {
          filterList = fi.f.getFilterList();
          return {
            ...base,
            filterList,
            fieldKind: 'measure',
          };
        }
        if (isBasicScalar(fi.f)) {
          return {
            ...base,
            filterList,
            fieldKind: 'dimension',
          };
        } else {
          return undefined;
        }
      }
      return undefined;
    } else if (fi instanceof FieldInstanceResult) {
      const sourceField = fi.turtleDef.name || fi.turtleDef.as;
      const sourceClasses = sourceField ? [sourceField] : [];
      const filterList = fi.firstSegment.filterList;

      const lastSegment =
        fi.turtleDef.pipeline[fi.turtleDef.pipeline.length - 1];
      const limit = isRawSegment(lastSegment) ? undefined : lastSegment.limit;
      let orderBy: OrderBy[] | undefined = undefined;
      const drillable: boolean =
        isQuerySegment(lastSegment) && fi.turtleDef.pipeline.length === 1;
      if (isQuerySegment(lastSegment)) {
        orderBy = lastSegment.orderBy;
      }

      if (sourceField) {
        return {
          sourceField,
          filterList,
          sourceClasses,
          fieldKind: 'struct',
          limit,
          orderBy,
          drillable,
        };
      }
    }
    return undefined;
  }

  /**  returns a fields and primary key of a struct for this query */
  getResultStructDef(
    resultStruct: FieldInstanceResult = this.rootResult,
    isRoot = true
  ): QueryResultDef {
    const fields: FieldDef[] = [];
    let primaryKey;
    this.prepare(undefined);

    let dimCount = 0;
    for (const [name, fi] of resultStruct.allFields) {
      const resultMetadata = this.getResultMetadata(fi);
      if (fi instanceof FieldInstanceResult) {
        const {structDef, repeatedResultType} = this.generateTurtlePipelineSQL(
          fi,
          new StageWriter(true, undefined),
          '<nosource>'
        );

        // Get the timezone from the nested query
        const nestedQueryInfo = fi.getQueryInfo();
        const queryTimezone = nestedQueryInfo.queryTimezone;

        if (repeatedResultType === 'nested') {
          const multiLineNest: RepeatedRecordDef = {
            type: 'array',
            elementTypeDef: {type: 'record_element'},
            join: 'many',
            name,
            fields: structDef.fields,
            ...(structDef.annotation && {annotation: structDef.annotation}),
            ...(structDef.modelAnnotation && {
              modelAnnotation: structDef.modelAnnotation,
            }),
            resultMetadata,
            ...(queryTimezone && {queryTimezone}),
          };
          fields.push(multiLineNest);
        } else {
          const oneLineNest: RecordDef = {
            type: 'record',
            join: 'one',
            name,
            fields: structDef.fields,
            ...(structDef.annotation && {annotation: structDef.annotation}),
            ...(structDef.modelAnnotation && {
              modelAnnotation: structDef.modelAnnotation,
            }),
            resultMetadata,
            ...(queryTimezone && {queryTimezone}),
          };
          fields.push(oneLineNest);
        }
      } else if (fi instanceof FieldInstanceField) {
        if (fi.fieldUsage.type === 'result') {
          // if there is only one dimension, it is the primaryKey
          //  if there are more, primaryKey is undefined.
          if (isBasicScalar(fi.f)) {
            if (dimCount === 0 && isRoot) {
              primaryKey = name;
            } else {
              primaryKey = undefined;
            }
            dimCount++;
          }

          // Remove computations because they are all resolved
          let fOut = fi.f.fieldDef;
          if (hasExpression(fOut)) {
            fOut = {...fOut};
            // "as" because delete needs the property to be optional
            delete (fOut as Expression).e;
            delete (fOut as Expression).code;
            delete (fOut as Expression).expressionType;
          }

          const location = fOut.location;
          const annotation = fOut.annotation;

          const common = {
            resultMetadata,
            location,
            annotation,
          };

          // build out the result fields...
          switch (fOut.type) {
            case 'boolean':
            case 'json':
            case 'string':
              fields.push({
                name,
                type: fOut.type,
                ...common,
              });
              break;
            case 'date':
            case 'timestamp':
            case 'timestamptz': {
              const timeframe = fOut.timeframe;
              const fd: TemporalTypeDef = {type: fOut.type};
              if (timeframe) {
                fd.timeframe = timeframe;
              }
              fields.push({
                name,
                ...fd,
                ...common,
              });
              break;
            }
            case 'number':
              fields.push({
                name,
                numberType: fOut.numberType,
                type: 'number',
                ...common,
              });
              break;
            case 'sql native':
            case 'record':
            case 'array': {
              fields.push({...fOut, ...common});
              break;
            }
            default:
              throw new Error(
                `unknown Field Type in query ${JSON.stringify(fOut)}`
              );
          }
        }
      }
    }
    const outputStruct: StructDef = {
      type: 'query_result',
      name: this.resultStage || 'result',
      fields,
      dialect: this.parent.dialect.name,
      primaryKey,
      connection: this.parent.connectionName,
      resultMetadata: this.getResultMetadata(this.rootResult),
      queryTimezone: resultStruct.getQueryInfo().queryTimezone,
    };
    if (this.parent.structDef.modelAnnotation) {
      outputStruct.modelAnnotation = this.parent.structDef.modelAnnotation;
    }

    return outputStruct;
  }

  getStructSourceSQL(qs: QueryStruct, stageWriter: StageWriter): string {
    switch (qs.structDef.type) {
      case 'table':
        return this.parent.dialect.quoteTablePath(qs.structDef.tablePath);
      case 'composite':
        // TODO: throw an error here; not simple because we call into this
        // code currently before the composite source is resolved in some cases
        return '{COMPOSITE SOURCE}';
      case 'spine_join': {
        const def = qs.structDef as SpineJoinDef;
        // Extract grain from runtime arguments (defaults to 'day')
        const grainArg = qs.arguments()['grain'];
        const grainVal = grainArg?.value;
        const grain =
          grainVal &&
          'node' in grainVal &&
          (grainVal as StringLiteralNode).node === 'stringLiteral'
            ? (grainVal as StringLiteralNode).literal
            : 'day';
        validateSpineGrain(grain);

        const spineSQL = this.parent.dialect.sqlDateSpineSQL(
          def.spineStart,
          def.spineEnd,
          grain
        );

        // Collect unique group aliases across all fact joins
        const seenAliases = new Set<string>();
        for (const fj of def.spineFactJoins) {
          for (const gf of fj.groupFields) seenAliases.add(gf.alias);
        }
        const allGroupAliases = [...seenAliases];

        // Determine whether all non-empty fact joins share the same alias set
        const joinsWithGroups = def.spineFactJoins.filter(
          fj => fj.groupFields.length > 0
        );
        const allAliasesFingerprint = allGroupAliases.slice().sort().join(',');
        const uniformAliasSet = joinsWithGroups.every(
          fj =>
            fj.groupFields
              .map(gf => gf.alias)
              .sort()
              .join(',') === allAliasesFingerprint
        );

        // Build spine × groups CROSS JOIN (grid only; fact joins are outer LEFT JOINs)
        let baseSQL: string;
        if (allGroupAliases.length === 0) {
          // No group dims — bare date spine
          baseSQL = `SELECT spine_date FROM (${spineSQL}) AS __spine`;
        } else if (uniformAliasSet) {
          // Strategy A: same alias set across all joins — UNION preserves co-occurring tuples
          const groupUnions = joinsWithGroups.map(fj => {
            const factStruct = this.structRefToQueryStruct(fj.sourceRef);
            if (!factStruct) {
              throw new Error(
                `spine_composite: unknown source '${fj.sourceRef}'`
              );
            }
            const factSQL = this.getStructSourceSQL(factStruct, stageWriter);
            const cols = fj.groupFields
              .map(gf => `${this.spineGroupDimSQL(gf, factStruct)} AS ${gf.alias}`)
              .join(', ');
            return `SELECT DISTINCT ${cols} FROM ${factSQL}`;
          });
          baseSQL =
            `SELECT __spine.spine_date, __groups.*\n` +
            `FROM (${spineSQL}) AS __spine\n` +
            `CROSS JOIN (\n${groupUnions.join('\nUNION\n')}\n) AS __groups`;
        } else {
          // Strategy B: different alias sets — one per-alias SELECT DISTINCT + CROSS JOIN.
          // Produces Cartesian product of distinct values for each alias independently.
          // Fact joins that don't declare an alias join only on their own group fields,
          // causing their values to be duplicated across all values of the missing alias.
          const perAliasCrossJoins = allGroupAliases.map(alias => {
            const subqueryParts = joinsWithGroups
              .filter(fj => fj.groupFields.some(gf => gf.alias === alias))
              .map(fj => {
                const factStruct = this.structRefToQueryStruct(fj.sourceRef);
                if (!factStruct) {
                  throw new Error(
                    `spine_composite: unknown source '${fj.sourceRef}'`
                  );
                }
                const factSQL = this.getStructSourceSQL(factStruct, stageWriter);
                const gf = fj.groupFields.find(g => g.alias === alias)!;
                return `SELECT DISTINCT ${this.spineGroupDimSQL(gf, factStruct)} AS ${alias} FROM ${factSQL}`;
              });
            return `CROSS JOIN (\n${subqueryParts.join('\nUNION\n')}\n) AS __grp_${alias}`;
          });
          const selectCols = allGroupAliases.map(a => `__grp_${a}.${a}`).join(', ');
          baseSQL =
            `SELECT __spine.spine_date, ${selectCols}\n` +
            `FROM (${spineSQL}) AS __spine\n` +
            perAliasCrossJoins.join('\n');
        }

        return `(\n${baseSQL}\n)`;
      }
      case 'finalize':
        return qs.structDef.name;
      case 'sql_select':
        return `(${getCompiledSQL(
          qs.structDef,
          qs.prepareResultOptions ?? {},
          path => this.parent.dialect.quoteTablePath(path),
          (query, opts) => {
            // Compile query to isolated SQL (not into parent's stageWriter)
            const ret = this.compileQueryToStages(
              query,
              opts ?? {},
              undefined,
              false
            );
            return ret.sql!;
          }
        )})`;
      case 'nest_source':
        return qs.structDef.pipeSQL;
      case 'query_source': {
        const {buildManifest, connectionDigests, strictPersist} =
          qs.prepareResultOptions ?? {};

        // Check manifest for this source
        if (buildManifest && connectionDigests) {
          const connDigest = safeRecordGet(
            connectionDigests,
            qs.structDef.connection
          );
          if (connDigest) {
            // Compile with empty opts to get manifest-ignorant SQL for BuildID
            const fullRet = this.compileQueryToStages(
              qs.structDef.query,
              {},
              undefined,
              false
            );
            const buildId = mkBuildID(connDigest, fullRet.sql!);
            const entry = buildManifest[buildId];

            if (entry) {
              // Found in manifest - use persisted table
              return this.parent.dialect.quoteTablePath(entry.tableName);
            }

            if (strictPersist) {
              throw new Error(
                `Persist source '${qs.structDef.sourceID}' not found in manifest (buildId: ${buildId})`
              );
            }
          }
        }

        // Not in manifest - compile normally
        const ret = this.compileQueryToStages(
          qs.structDef.query,
          qs.prepareResultOptions,
          stageWriter,
          qs.parent !== undefined
        );
        return ret.lastStageName;
      }
      default:
        throw new Error(
          `Cannot create SQL StageWriter from '${getIdentifier(
            qs.structDef
          )}' type '${qs.structDef.type}`
        );
    }
  }

  /**
   * Compile a Query into SQL stages. Used by both query_source compilation
   * and getCompiledSQL for interpolated sources.
   *
   * @param query The query to compile
   * @param prepareResultOptions Options including manifest for substitution
   * @param stageWriter If provided, stages are added to this writer and lastStageName is returned.
   *                    If undefined, a new isolated writer is created and full SQL is returned.
   * @param isJoinedSubquery Whether this is a joined subquery
   * @returns { lastStageName, stageWriter, sql } - sql is only set if stageWriter was undefined
   */
  compileQueryToStages(
    query: Query,
    prepareResultOptions: PrepareResultOptions,
    stageWriter: StageWriter | undefined,
    isJoinedSubquery: boolean
  ): {lastStageName: string; stageWriter: StageWriter; sql?: string} {
    const turtleDef: TurtleDefPlusFilters = {
      type: 'turtle',
      name: 'ignoreme',
      pipeline: query.pipeline,
      filterList: query.filterList,
    };

    const structRef = query.compositeResolvedSourceDef ?? query.structRef;

    let sourceStruct: QueryStruct;
    if (typeof structRef === 'string') {
      const struct = this.structRefToQueryStruct(structRef);
      if (!struct) {
        throw new Error(
          `Unexpected reference to an undefined source '${structRef}'`
        );
      }
      sourceStruct = struct;
    } else {
      sourceStruct = new QueryStruct(
        structRef,
        query.sourceArguments,
        {model: this.parent.getModel()},
        prepareResultOptions
      );
    }

    // Create isolated stageWriter if none provided
    const isolated = stageWriter === undefined;
    // When isPartialQuery is set (e.g., SQL interpolation), don't use CTEs
    // for dialects that don't support them in subqueries
    const noCTE =
      prepareResultOptions.isPartialQuery &&
      !sourceStruct.dialect.supportsCTEinCoorelatedSubQueries;
    const writer = stageWriter ?? new StageWriter(!noCTE, undefined);

    const q = QueryQuery.makeQuery(
      turtleDef,
      sourceStruct,
      writer,
      isJoinedSubquery,
      this.structRefToQueryStruct
    );

    const ret = q.generateSQLFromPipeline(writer);

    return {
      lastStageName: ret.lastStageName,
      stageWriter: writer,
      sql: isolated ? writer.generateSQLStages() : undefined,
    };
  }

  /**
   * Build pre-aggregated SELECT column expressions for a spine fact join.
   * For each aggregate field in the fact source, generates a SQL aggregate
   * expression aliased as __preagg_<fieldName> (the shadow column consumed by
   * the redefined SUM measures in the SpineJoinDef JoinFieldDef).
   */
  /**
   * Returns the SQL expression for a spine group dimension in the context of the
   * flat pre-agg subquery (single FROM, no joins). For physical columns, returns
   * the bare column name. For computed dimensions, walks the Expr tree and emits
   * unqualified SQL — column references become bare identifiers, not table.column.
   */
  spineGroupDimSQL(gf: SpineGroupField, factStruct: QueryStruct): string {
    if (!gf.fieldExpr) return gf.column;
    return this.flatDimExprToSQL(gf.fieldExpr, factStruct.dialect.name);
  }

  /**
   * Walk an Expr tree and produce unqualified SQL for use inside a flat
   * single-table subquery (no joins, so no table prefix needed).
   */
  private flatDimExprToSQL(expr: Expr, dialectName: string): string {
    switch (expr.node) {
      case 'field': {
        const fn = expr as FieldnameNode;
        // Use last path segment as the bare column name
        return fn.path[fn.path.length - 1];
      }
      case 'genericSQLExpr': {
        const gse = expr as GenericSQLExpr;
        let result = '';
        for (let i = 0; i < gse.src.length; i++) {
          result += gse.src[i];
          if (i < gse.kids.args.length) {
            result += this.flatDimExprToSQL(gse.kids.args[i], dialectName);
          }
        }
        return result;
      }
      case 'function_call': {
        const fc = expr as FunctionCallNode;
        const expanded = expandFunctionCall(dialectName, fc.overload, fc.kids.args, '', undefined);
        return this.flatDimExprToSQL(expanded, dialectName);
      }
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case 'and':
      case 'or':
      case '=':
      case '!=':
      case '>':
      case '<':
      case '>=':
      case '<=':
      case 'like':
      case '!like': {
        const b = expr as BinaryExpr;
        const op = expr.node === '!like' ? 'NOT LIKE' : expr.node.toUpperCase();
        return `(${this.flatDimExprToSQL(b.kids.left, dialectName)} ${op} ${this.flatDimExprToSQL(b.kids.right, dialectName)})`;
      }
      case '()': {
        const u = expr as UnaryExpr;
        return `(${this.flatDimExprToSQL(u.e, dialectName)})`;
      }
      case 'not': {
        const u = expr as UnaryExpr;
        return `NOT ${this.flatDimExprToSQL(u.e, dialectName)}`;
      }
      case 'unary-': {
        const u = expr as UnaryExpr;
        return `-${this.flatDimExprToSQL(u.e, dialectName)}`;
      }
      case 'is-null': {
        const u = expr as UnaryExpr;
        return `${this.flatDimExprToSQL(u.e, dialectName)} IS NULL`;
      }
      case 'is-not-null': {
        const u = expr as UnaryExpr;
        return `${this.flatDimExprToSQL(u.e, dialectName)} IS NOT NULL`;
      }
      case 'stringLiteral':
        return `'${(expr as StringLiteralNode).literal}'`;
      case 'numberLiteral':
        return (expr as NumberLiteralNode).literal;
      case 'true':
        return 'TRUE';
      case 'false':
        return 'FALSE';
      case 'null':
        return 'NULL';
      default:
        throw new Error(
          `spine_group: unsupported expression type '${expr.node}' in computed dimension. Use a simpler expression or a physical column name.`
        );
    }
  }

  buildSpinePreAggCols(factDef: SourceDef, _factJoin: SpineFactJoin): string[] {
    const cols: string[] = [];
    for (const f of factDef.fields) {
      if (!isAtomic(f)) continue;
      // AtomicFieldDef has Expression fields (e, expressionType) from FieldBase
      const af = f as FieldDef & {
        name: string;
        as?: string;
        expressionType?: import('./malloy_types').ExpressionType;
        e?: {
          node: string;
          function?: string;
          e?: {node: string; path?: string[]};
        };
      };
      if (!expressionIsAggregate(af.expressionType)) continue;
      const colName = af.as ?? af.name;
      const preaggName = `__preagg_${colName}`;
      const e = af.e;
      if (!e) continue;
      if (e.node === 'aggregate') {
        if (e.function === 'count') {
          cols.push(`COUNT(*) AS ${preaggName}`);
        } else if (e.function === 'sum' || e.function === 'avg') {
          const innerE = e.e;
          if (
            innerE?.node === 'field' &&
            Array.isArray(innerE.path) &&
            innerE.path.length === 1
          ) {
            const fn = e.function.toUpperCase();
            cols.push(`${fn}(${innerE.path[0]}) AS ${preaggName}`);
          }
        }
        // max/min/distinct: skip — too complex for simple pre-agg SQL
      }
    }
    return cols;
  }

  /**
   * Walk an Expr tree looking for `sum(structPath.col)` calls on spine pre-agg
   * joins where `col` is a raw (non-preagg) column. Registers found columns in
   * `spineExtraRawCols` so `generateSQLJoinBlock` can include them in the pre-agg SELECT.
   */
  private walkExprForSpineRawSums(expr: Expr | undefined): void {
    if (!expr) return;
    if (expr.node === 'aggregate' && (expr as AggregateExpr).function === 'sum') {
      const agg = expr as AggregateExpr;
      if (agg.e?.node === 'field') {
        const path = (agg.e as FieldnameNode).path;
        if (path && path.length >= 1) {
          const col = path[path.length - 1];
          if (!col.startsWith('__preagg_')) {
            const structPath =
              agg.structPath && agg.structPath.length > 0
                ? agg.structPath
                : path.length >= 2
                  ? path.slice(0, -1)
                  : undefined;
            let struct: QueryStruct | undefined;
            if (structPath) {
              try { struct = this.parent.getStructByName(structPath); } catch { /* ignore */ }
            }
            if (struct && (struct.structDef as JoinBase).isSpinePreAgg) {
              if (!this.spineExtraRawCols) this.spineExtraRawCols = new Map();
              let set = this.spineExtraRawCols.get(struct);
              if (!set) {
                set = new Set();
                this.spineExtraRawCols.set(struct, set);
              }
              set.add(col);
            }
          }
        }
      }
    }
    // Recurse into standard child expression slots
    const e = expr as unknown as Record<string, unknown>;
    const inner = e['e'];
    if (inner && typeof inner === 'object' && 'node' in (inner as object)) {
      this.walkExprForSpineRawSums(inner as Expr);
    }
    const kids = e['kids'];
    if (kids && typeof kids === 'object') {
      for (const child of Object.values(kids as Record<string, unknown>)) {
        if (child && typeof child === 'object' && 'node' in (child as object)) {
          this.walkExprForSpineRawSums(child as Expr);
        }
      }
    }
  }

  /** Pre-scan all result fields for raw column .sum() calls on spine pre-agg joins. */
  private scanForSpineRawColSums(): void {
    for (const [, fi] of this.rootResult.allFields) {
      if (fi instanceof FieldInstanceField) {
        this.walkExprForSpineRawSums((fi.f.fieldDef as {e?: Expr}).e);
      }
    }
  }

  /**
   * Walk an Expr tree looking for `avg(structPath.col)` calls on spine pre-agg
   * joins where `col` is a raw (non-preagg) column. Registers found columns in
   * `spineExtraRawColAvgs` so `generateSQLJoinBlock` can include the decomposed
   * SUM(col) AS __preagg_sum_col and COUNT(col) AS __preagg_count_col columns.
   */
  private walkExprForSpineRawAvgs(expr: Expr | undefined): void {
    if (!expr) return;
    if (expr.node === 'aggregate' && (expr as AggregateExpr).function === 'avg') {
      const agg = expr as AggregateExpr;
      if (agg.e?.node === 'field') {
        const path = (agg.e as FieldnameNode).path;
        if (path && path.length >= 1) {
          const col = path[path.length - 1];
          if (!col.startsWith('__preagg_')) {
            const structPath =
              agg.structPath && agg.structPath.length > 0
                ? agg.structPath
                : path.length >= 2
                  ? path.slice(0, -1)
                  : undefined;
            let struct: QueryStruct | undefined;
            if (structPath) {
              try { struct = this.parent.getStructByName(structPath); } catch { /* ignore */ }
            }
            if (struct && (struct.structDef as JoinBase).isSpinePreAgg) {
              if (!this.spineExtraRawColAvgs) this.spineExtraRawColAvgs = new Map();
              let set = this.spineExtraRawColAvgs.get(struct);
              if (!set) {
                set = new Set();
                this.spineExtraRawColAvgs.set(struct, set);
              }
              set.add(col);
            }
          }
        }
      }
    }
    // Recurse into standard child expression slots
    const e = expr as unknown as Record<string, unknown>;
    const inner = e['e'];
    if (inner && typeof inner === 'object' && 'node' in (inner as object)) {
      this.walkExprForSpineRawAvgs(inner as Expr);
    }
    const kids = e['kids'];
    if (kids && typeof kids === 'object') {
      for (const child of Object.values(kids as Record<string, unknown>)) {
        if (child && typeof child === 'object' && 'node' in (child as object)) {
          this.walkExprForSpineRawAvgs(child as Expr);
        }
      }
    }
  }

  /** Pre-scan all result fields for raw column .avg() calls on spine pre-agg joins. */
  private scanForSpineRawColAvgs(): void {
    for (const [, fi] of this.rootResult.allFields) {
      if (fi instanceof FieldInstanceField) {
        this.walkExprForSpineRawAvgs((fi.f.fieldDef as {e?: Expr}).e);
      }
    }
  }

  generateSQLJoinBlock(
    stageWriter: StageWriter,
    ji: JoinInstance,
    depth: number
  ): string {
    let s = '';
    const qs = ji.queryStruct;
    const qsDef = qs.structDef;

    // Intercept spine fact joins: generate a pre-aggregated subquery LEFT JOIN
    // instead of the raw table join, avoiding fan-out when multiple fact joins are used.
    const parentStructDef = qs.parent?.structDef;
    if (parentStructDef?.type === 'spine_join') {
      const spineDef = parentStructDef as SpineJoinDef;
      const factJoin = spineDef.spineFactJoins.find(
        fj => fj.alias === getIdentifier(qsDef)
      );
      if (factJoin) {
        // Extract grain (same grain parameter as the composite source)
        const grainArg = qs.parent!.arguments()['grain'];
        const grainVal = grainArg?.value;
        const grain =
          grainVal &&
          'node' in grainVal &&
          (grainVal as StringLiteralNode).node === 'stringLiteral'
            ? (grainVal as StringLiteralNode).literal
            : 'day';

        // Original fact source SQL (unwrapped table / SQL select)
        const factStruct = this.structRefToQueryStruct(factJoin.sourceRef);
        if (!factStruct) {
          throw new Error(
            `spine_composite: unknown source '${factJoin.sourceRef}'`
          );
        }
        const rawFactSQL = this.getStructSourceSQL(factStruct, stageWriter);
        const factDef = factStruct.structDef as SourceDef;

        // Build pre-aggregated SELECT:
        //   DATE_TRUNC(grain, dateField) AS spine_date
        //   group dimension columns
        //   __preagg_<measure> aggregate expressions
        //   1 AS __distinct_key  (so count() yields 0 or 1 per grid cell)
        // __distinct_key is a presence sentinel (always 1 when a fact row matched).
        // __preagg_count is COUNT(*) per pre-agg cell; anonymous count() on a spine fact
        // join uses COALESCE(SUM(__preagg_count), 0) for true row counts (see
        // generateCountFragment in expression_compiler.ts).
        const truncExpr = this.parent.dialect.sqlDateTruncToGrain(
          grain,
          factJoin.dateField
        );
        const preaggCols = this.buildSpinePreAggCols(factDef, factJoin);
        // Extra raw columns registered by scanForSpineRawColSums() for this join
        const extraRawCols = this.spineExtraRawCols?.get(qs) ?? new Set<string>();
        const extraPreaggCols = [...extraRawCols].map(
          col => `SUM(${col}) AS __preagg_${col}`
        );
        // Extra raw columns registered by scanForSpineRawColAvgs() for this join.
        // AVG is not decomposable (AVG(AVG(x)) ≠ AVG(x)), so we carry both
        // SUM(col) and COUNT(col) per cell and divide in the outer query.
        const extraAvgCols = this.spineExtraRawColAvgs?.get(qs) ?? new Set<string>();
        const extraPreaggAvgCols = [...extraAvgCols].flatMap(col => [
          `SUM(${col}) AS __preagg_sum_${col}`,
          `COUNT(${col}) AS __preagg_count_${col}`,
        ]);
        const selectCols = [
          `${truncExpr} AS spine_date`,
          ...factJoin.groupFields.map(gf => `${this.spineGroupDimSQL(gf, factStruct)} AS ${gf.alias}`),
          ...preaggCols,
          ...extraPreaggCols,
          ...extraPreaggAvgCols,
          `COUNT(*) AS __preagg_count`,
          `1 AS __distinct_key`,
        ];
        const groupCols = [
          'spine_date',
          ...factJoin.groupFields.map(gf => gf.alias),
        ];
        const preAggSQL =
          `(SELECT ${selectCols.join(', ')}\n` +
          `FROM ${rawFactSQL}\n` +
          `GROUP BY ${groupCols.join(', ')})`;

        // Parent alias is the spine base grid's SQL alias
        const parentAlias = ji.parent?.alias ?? '';
        const dateCond = `${ji.alias}.spine_date = ${parentAlias}.spine_date`;
        const groupConds = factJoin.groupFields
          .map(gf => `${ji.alias}.${gf.alias} = ${parentAlias}.${gf.alias}`)
          .join(' AND ');
        const onCond = [dateCond, groupConds].filter(Boolean).join(' AND ');

        qs.eventStream?.emit('join-used', {name: getIdentifier(qsDef)});
        qs.maybeEmitParameterizedSourceUsage();
        return ` LEFT JOIN ${preAggSQL} AS ${ji.alias}\n  ON ${onCond}\n`;
      }
    }

    qs.eventStream?.emit('join-used', {name: getIdentifier(qsDef)});
    qs.maybeEmitParameterizedSourceUsage();
    if (isJoinedSource(qsDef)) {
      let structSQL = this.getStructSourceSQL(qs, stageWriter);
      const matrixOperation = (qsDef.matrixOperation || 'left').toUpperCase();
      if (!this.parent.dialect.supportsFullJoin && matrixOperation === 'FULL') {
        throw new Error('FULL JOIN not supported');
      }
      if (ji.makeUniqueKey) {
        const passKeys = this.generateSQLPassthroughKeys(qs);
        structSQL = `(SELECT ${qs.dialect.sqlGenerateUUID()} as ${qs.dialect.sqlMaybeQuoteIdentifier(
          '__distinct_key'
        )}, x.* ${passKeys} FROM ${structSQL} as x)`;
      }
      let onCondition = '';
      if (qs.parent === undefined) {
        throw new Error('Expected joined struct to have a parent.');
      }
      if (qsDef.onExpression) {
        // Create a temporary field instance to generate the SQL
        const boolField = new QueryFieldBoolean(
          {
            type: 'boolean',
            name: 'ignoreme',
            e: qsDef.onExpression,
          },
          qs.parent
        );
        const tempInstance = new FieldInstanceField(
          boolField,
          {type: 'where'}, // It's used in a WHERE-like context
          this.rootResult,
          undefined
        );
        onCondition = tempInstance.generateExpression();
      } else {
        onCondition = '1=1';
      }
      let filters = '';
      let conditions: string[] | undefined = undefined;
      if (ji.joinFilterConditions) {
        conditions = ji.joinFilterConditions.map(qf => {
          const tempInstance = new FieldInstanceField(
            qf,
            {type: 'where'},
            this.rootResult,
            undefined
          );
          return tempInstance.generateExpression();
        });
      }

      if (
        ji.children.length === 0 ||
        conditions === undefined ||
        !this.parent.dialect.supportsComplexFilteredSources
      ) {
        // LTNOTE: need a check here to see the children's where: conditions are local
        //  to the source and not to any of it's joined children.
        //  In Presto, we're going to get a SQL error if in this case
        //  for now.  We need to inspect the 'condition' of each of the children
        //  to see if they reference subchildren and blow up if they do
        //  or move them to the where clause with a (x.distnct_key is NULL or (condition))
        //
        // const childrenFiltersAreComplex = somethign(conditions)
        // if (conditions && childrenFiltersAreComplex !this.parent.dialect.supportsComplexFilteredSources) {
        //   throw new Error(
        //     'Cannot join a source with a complex filter on a joined source'
        //   );
        // }

        if (conditions !== undefined && conditions.length >= 1) {
          filters = ` AND (${conditions.join(' AND ')})`;
        }
        s += ` ${matrixOperation} JOIN ${structSQL} AS ${ji.alias}\n  ON ${onCondition}${filters}\n`;
      } else {
        let select = `SELECT ${ji.alias}.*`;
        let joins = '';
        for (const childJoin of ji.children) {
          joins += this.generateSQLJoinBlock(stageWriter, childJoin, depth + 1);
          select += `, ${this.parent.dialect.sqlSelectAliasAsStruct(
            childJoin.alias,
            getDialectFieldList(childJoin.queryStruct.structDef)
          )} AS ${childJoin.alias}`;
        }
        select += `\nFROM ${structSQL} AS ${
          ji.alias
        }\n${joins}\nWHERE ${conditions?.join(' AND ')}\n`;
        s += `${matrixOperation} JOIN (\n${indent(select)}) AS ${
          ji.alias
        }\n  ON ${onCondition}\n`;
        return s;
      }
    } else if (qsDef.type === 'array') {
      if (qs.parent === undefined || ji.parent === undefined) {
        throw new Error('Internal Error, nested structure with no parent.');
      }
      // We need an SQL expression which results in the array for us to pass to un-nest
      let arrayExpression: string;

      if (hasExpression(qsDef)) {
        // If this array is NOT contained in the parent, but a computed entity
        // then the thing we are joining is not "parent.childName", but
        // the expression which is built in that namespace
        arrayExpression = exprToSQL(this.rootResult, qs.parent, qsDef.e);
      } else {
        // If this is a reference through an expression at the top level,
        // need to generate the expression because the expression is written
        // in the top level, this call is being used to generate the join.
        // Below the top level, the expression will have been written into
        // a join at the top level, and the name will exist.
        // ... not sure this is the right way to do this
        // ... the test for this is called "source repeated record containing an array"
        arrayExpression = sqlFullChildReference(
          qs.parent,
          qsDef.name,
          depth === 0 ? {result: this.rootResult, field: this} : undefined
        );
      }
      // we need to generate primary key.  If parent has a primary key combine
      // console.log(ji.alias, fieldExpression, this.inNestedPipeline());
      s += `${this.parent.dialect.sqlUnnestAlias(
        arrayExpression,
        ji.alias,
        ji.getDialectFieldList(),
        ji.makeUniqueKey,
        isBasicArray(qsDef),
        this.inNestedPipeline()
      )}\n`;
    } else if (qsDef.type === 'record') {
      throw new Error(
        'Internal Error: records should never appear in join trees'
      );
    } else {
      throw new Error(`Join type not implemented ${qs.structDef.type}`);
    }
    for (const childJoin of ji.children) {
      s += this.generateSQLJoinBlock(stageWriter, childJoin, depth + 1);
    }
    return s;
  }

  // BigQuery has wildcard psudo columns that are treated differently
  //  SELECT * FROM xxx doesn't include these psuedo columns but we need them so
  //  filters can get pushed down properly when generating a UNIQUE key.
  //  No other dialect really needs this so we are coding here but maybe someday
  //  this makes its way into the dialect.
  generateSQLPassthroughKeys(qs: QueryStruct): string {
    let ret = '';
    if (qs.dialect.name === 'standardsql') {
      const psudoCols = [
        '_TABLE_SUFFIX',
        '_PARTITIONDATE',
        '_PARTITIONTIME',
      ].filter(element => qs.getChildByName(element) !== undefined);
      if (psudoCols.length > 0) {
        ret = ', ' + psudoCols.join(', ');
      }
    }
    return ret;
  }

  generateSQLJoins(stageWriter: StageWriter): string {
    let s = '';
    // get the first value from the map (weird, I know)
    const [[, ji]] = this.rootResult.joins;
    const qs = ji.queryStruct;
    // Joins
    let structSQL = this.getStructSourceSQL(qs, stageWriter);
    if (isIndexSegment(this.firstSegment)) {
      structSQL = this.parent.dialect.sqlSampleTable(
        structSQL,
        this.firstSegment.sample
      );
      if (this.firstSegment.sample) {
        structSQL = stageWriter.addStage(
          `SELECT * from ${structSQL} as x limit 100000 `
        );
      }
    }
    if (isBaseTable(qs.structDef)) {
      if (ji.makeUniqueKey) {
        const passKeys = this.generateSQLPassthroughKeys(qs);
        structSQL = `(SELECT ${qs.dialect.sqlGenerateUUID()} as ${qs.dialect.sqlMaybeQuoteIdentifier(
          '__distinct_key'
        )}, x.* ${passKeys} FROM ${structSQL} as x)`;
      }
      s += `FROM ${structSQL} as ${ji.alias}\n`;
    } else {
      throw new Error('Internal Error, queries must start from a basetable');
    }

    // Sort children to ensure array joins are processed before table joins that might reference them
    //
    const sortedChildren = [...ji.children].sort((a, b) => {
      const aIsArray = a.queryStruct.structDef.type === 'array';
      const bIsArray = b.queryStruct.structDef.type === 'array';
      if (aIsArray && !bIsArray) return -1;
      if (!aIsArray && bIsArray) return 1;
      return 0;
    });

    for (const childJoin of sortedChildren) {
      s += this.generateSQLJoinBlock(stageWriter, childJoin, 0);
    }
    return s;
  }

  /**
   * Collect all array joins from the join tree in depth-first order.
   * This ordering ensures parent arrays are ordered before child arrays.
   */
  collectArrayJoins(ji: JoinInstance): JoinInstance[] {
    const result: JoinInstance[] = [];
    if (ji.queryStruct.structDef.type === 'array') {
      result.push(ji);
    }
    for (const child of ji.children) {
      result.push(...this.collectArrayJoins(child));
    }
    return result;
  }

  genereateSQLOrderBy(
    queryDef: QuerySegment,
    resultStruct: FieldInstanceResult
  ): string {
    let s = '';

    // Collect array joins for dialects that need explicit ordering.
    // Only for project queries - reduce queries aggregate rows so individual
    // row order doesn't matter, and we can't ORDER BY columns not in GROUP BY.
    let arrayJoins: JoinInstance[] = [];
    if (
      this.parent.dialect.requiresExplicitUnnestOrdering &&
      this.firstSegment.type === 'project'
    ) {
      const [[, rootJoin]] = this.rootResult.joins;
      arrayJoins = this.collectArrayJoins(rootJoin);
    }

    if (this.firstSegment.type === 'project' && !queryDef.orderBy) {
      // For project without explicit ordering, we still need array ordinality
      // ordering if the dialect requires it
      if (arrayJoins.length === 0) {
        return ''; // No default ordering for project.
      }
    }
    // Intermediate results (in a pipeline or join) that have no limit, don't need an orderby
    //  Some database don't have this optimization.
    if (this.fieldDef.pipeline.length > 1 && queryDef.limit === undefined) {
      return '';
    }
    // ignore orderby if all aggregates.
    if (resultStruct.getRepeatedResultType() === 'inline_all_numbers') {
      return '';
    }

    // if we are in the last stage of a query and the query is a subquery
    //  and has no limit, ORDER BY is superfluous
    if (
      this.isJoinedSubquery &&
      this.fieldDef.pipeline.length === 1 &&
      queryDef.limit === undefined
    ) {
      return '';
    }

    const orderBy = queryDef.orderBy || resultStruct.calculateDefaultOrderBy();
    const o: string[] = [];
    for (const f of orderBy) {
      if (typeof f.field === 'string') {
        // convert name to an index
        const fi = resultStruct.getField(f.field);
        if (fi && fi.fieldUsage.type === 'result') {
          if (this.parent.dialect.orderByClause === 'ordinal') {
            o.push(`${fi.fieldUsage.resultIndex} ${f.dir || 'ASC'}`);
          } else if (this.parent.dialect.orderByClause === 'output_name') {
            o.push(
              `${this.parent.dialect.sqlMaybeQuoteIdentifier(f.field)} ${
                f.dir || 'ASC'
              }`
            );
          } else if (this.parent.dialect.orderByClause === 'expression') {
            const fieldExpr = fi.getSQL();
            o.push(`${fieldExpr} ${f.dir || 'ASC'}`);
          }
        } else {
          throw new Error(`Unknown field in ORDER BY ${f.field}`);
        }
      } else {
        if (this.parent.dialect.orderByClause === 'ordinal') {
          o.push(`${f.field} ${f.dir || 'ASC'}`);
        } else if (this.parent.dialect.orderByClause === 'output_name') {
          const orderingField = resultStruct.getFieldByNumber(f.field);
          o.push(
            `${this.parent.dialect.sqlMaybeQuoteIdentifier(
              orderingField.name
            )} ${f.dir || 'ASC'}`
          );
        } else if (this.parent.dialect.orderByClause === 'expression') {
          const orderingField = resultStruct.getFieldByNumber(f.field);
          const fieldExpr = orderingField.fif.getSQL();
          o.push(`${fieldExpr} ${f.dir || 'ASC'}`);
        }
      }
    }

    // Add array ordinality ordering for dialects that require it
    for (const aj of arrayJoins) {
      o.push(`${aj.alias}_outer.__row_id ASC`);
    }

    if (o.length > 0) {
      s = this.parent.dialect.sqlOrderBy(o, 'query') + '\n';
    }
    return s;
  }

  generateSimpleSQL(stageWriter: StageWriter): string {
    let s = '';
    s += 'SELECT \n';
    const fields: string[] = [];

    for (const [name, field] of this.rootResult.allFields) {
      const fi = field as FieldInstanceField;
      const sqlName = this.parent.dialect.sqlMaybeQuoteIdentifier(name);
      if (fi.fieldUsage.type === 'result') {
        fields.push(` ${fi.generateExpression()} as ${sqlName}`);
      }
    }
    s += indent(fields.join(',\n')) + '\n';

    s += this.generateSQLJoins(stageWriter);
    s += this.generateSQLFilters(this.rootResult, 'where').sql('where');

    // group by
    if (this.firstSegment.type === 'reduce') {
      const n: string[] = [];
      for (const field of this.rootResult.fields()) {
        const fi = field as FieldInstanceField;
        if (fi.fieldUsage.type === 'result' && isScalarField(fi.f)) {
          n.push(fi.fieldUsage.resultIndex.toString());
        }
      }
      if (n.length > 0) {
        s += `GROUP BY ${n.join(',')}\n`;
      }
    }

    s += this.generateSQLFilters(this.rootResult, 'having').sql('having');

    // order by
    s += this.genereateSQLOrderBy(
      this.firstSegment as QuerySegment,
      this.rootResult
    );

    // limit
    if (!isRawSegment(this.firstSegment) && this.firstSegment.limit) {
      s += `LIMIT ${this.firstSegment.limit}\n`;
    }
    this.resultStage = stageWriter.addStage(s);
    return this.resultStage;
  }

  // This probably should be generated in a dialect independat way.
  //  but for now, it is just googleSQL.
  generatePipelinedStages(
    outputPipelinedSQL: OutputPipelinedSQL[],
    lastStageName: string,
    stageWriter: StageWriter
  ): string {
    if (outputPipelinedSQL.length === 0) {
      return lastStageName;
    }

    let retSQL: string;
    if (this.parent.dialect.supportsSelectReplace) {
      const pipelinesSQL = outputPipelinedSQL
        .map(o => `${o.pipelineSQL} as ${o.sqlFieldName}`)
        .join(',\n');
      retSQL = `SELECT * replace (${pipelinesSQL}) FROM ${lastStageName}
        `;
    } else {
      const pipelinesSQL = outputPipelinedSQL
        .map(o => `${o.pipelineSQL} as ${o.sqlFieldName}`)
        .join(',\n');
      const outputFields = outputPipelinedSQL.map(f => f.sqlFieldName);
      const allFields = Array.from(this.rootResult.allFields.keys()).map(f =>
        this.parent.dialect.sqlMaybeQuoteIdentifier(f)
      );
      const fields = allFields.filter(f => outputFields.indexOf(f) === -1);
      retSQL = `SELECT ${
        fields.length > 0 ? fields.join(', ') + ',' : ''
      } ${pipelinesSQL} FROM ${lastStageName}`;
    }
    return stageWriter.addStage(retSQL);
  }

  generateStage0Fields(
    resultSet: FieldInstanceResult,
    output: StageOutputContext,
    stageWriter: StageWriter
  ) {
    const scalarFields: [string, FieldInstanceField][] = [];
    const otherFields: [string, FieldInstance][] = [];
    for (const [name, fi] of resultSet.allFields) {
      if (fi instanceof FieldInstanceField && isScalarField(fi.f)) {
        scalarFields.push([name, fi]);
      } else {
        otherFields.push([name, fi]);
      }
    }
    const orderedFields = [...scalarFields, ...otherFields];

    for (const [name, fi] of orderedFields) {
      const outputName = this.parent.dialect.sqlMaybeQuoteIdentifier(
        `${name}__${resultSet.groupSet}`
      );
      if (fi instanceof FieldInstanceField) {
        if (fi.fieldUsage.type === 'result') {
          const exp = fi.getSQL();
          if (isScalarField(fi.f)) {
            if (
              this.parent.dialect.cantPartitionWindowFunctionsOnExpressions &&
              this.rootResult.queryUsesPartitioning &&
              resultSet.firstSegment.type === 'reduce'
            ) {
              // BigQuery can't partition aggregate function except when the field has no
              //  expression.  Additionally it can't partition by floats.  We stuff expressions
              //  and numbers as strings into a lateral join when the query has ungrouped expressions
              const outputFieldName = `__lateral_join_bag.${outputName}`;
              fi.analyticalSQL = outputFieldName;
              output.lateralJoinSQLExpressions.push(`${exp} as ${outputName}`);
              output.sql.push(outputFieldName);
              if (fi.f.fieldDef.type === 'number') {
                const outputNameString =
                  this.parent.dialect.sqlMaybeQuoteIdentifier(
                    `${name}__${resultSet.groupSet}_string`
                  );
                const outputFieldNameString = `__lateral_join_bag.${outputNameString}`;
                output.sql.push(outputFieldNameString);
                output.dimensionIndexes.push(output.fieldIndex++);
                output.lateralJoinSQLExpressions.push(
                  `CAST(${exp} as STRING) as ${outputNameString}`
                );
                fi.partitionSQL = outputFieldNameString;
              }
            } else {
              // just treat it like a regular field.
              output.sql.push(`${exp} as ${outputName}`);
            }
            output.dimensionIndexes.push(output.fieldIndex++);
          } else if (isBasicCalculation(fi.f)) {
            output.sql.push(`${exp} as ${outputName}`);
            output.fieldIndex++;
          }
        }
      } else if (fi instanceof FieldInstanceResult) {
        if (fi.firstSegment.type === 'reduce') {
          this.generateStage0Fields(fi, output, stageWriter);
        } else if (fi.firstSegment.type === 'project') {
          const s = this.generateTurtleSQL(
            fi,
            stageWriter,
            outputName,
            output.outputPipelinedSQL
          );
          output.sql.push(`${s} as ${outputName}`);
          output.fieldIndex++;
        }
      }
    }
    // LTNOTE: we could optimize here in the future.
    //  leaf turtles can have their having clauses in the main query
    //  turtles with leaves need to promote their state to their
    //  children.
    const having = this.generateSQLFilters(resultSet, 'having');
    if (!having.empty()) {
      // if we have no children, the having can run at the root level
      if (resultSet.childGroups.length === 1) {
        resultSet
          .root()
          .havings.add(
            `(group_set<>${resultSet.groupSet} OR (group_set=${
              resultSet.groupSet
            } AND ${having.sql()}))`
          );
      } else {
        resultSet.hasHaving = true;
        output.sql.push(
          `CASE WHEN group_set=${
            resultSet.groupSet
          } THEN CASE WHEN ${having.sql()} THEN 0 ELSE 1 END END as __delete__${
            resultSet.groupSet
          }`
        );
        output.fieldIndex++;
      }
    }
  }

  generateSQLWhereChildren(resultStruct: FieldInstanceResult): AndChain {
    const wheres = new AndChain();
    for (const [, field] of resultStruct.allFields) {
      if (field.type === 'query') {
        const fir = field as FieldInstanceResult;
        const turtleWhere = this.generateSQLFilters(fir, 'where');
        if (turtleWhere.present()) {
          const groupSets = fir.childGroups.join(',');
          wheres.add(
            `(group_set NOT IN (${groupSets})` +
              ` OR (group_set IN (${groupSets}) AND ${turtleWhere.sql()}))`
          );
        }
        wheres.addChain(this.generateSQLWhereChildren(fir));
      }
    }
    return wheres;
  }

  generateSQLWhereTurtled(): string {
    const wheres = this.generateSQLFilters(this.rootResult, 'where');
    wheres.addChain(this.generateSQLWhereChildren(this.rootResult));
    return wheres.sql('where');
  }

  // iterate over the nested queries looking for Havings and Limits
  //
  // Think of the result graph as a tree.
  //
  // Havings in leaves have already been removed in the stage0 queries we are only concerned with
  //. having in nodes with children
  //
  //  First step is to generate the partition and order by code for each of the relevent groupsets
  //
  //  Next we compute rows that are over the order by limit.  Nodes with children are additionally
  //    partitioned by having.
  //
  // Scan the parent for children.  If there are any nodes that need to be deleted, note them.
  //
  // Finally remove any node either over the limit or part of a parent's having.
  //
  generateSQLHavingLimit(
    stageWriter: StageWriter,
    lastStageName: string
  ): string {
    const havingFields: string[] = [];
    const limitExpressions: string[] = [];
    const limitValues: number[] = [];
    const limitComplexClauses: string[] = [];
    const limitSimpleFilters: string[] = [];
    const partitionSQL: string[] = [];
    let hasAnyLimits = false;
    let hasResultsWithChildren = false;

    const resultsWithHavingOrLimit = this.rootResult.selectStructs(
      [],
      (result: FieldInstanceResult) =>
        result.hasHaving || result.getLimit() !== undefined
    );

    if (resultsWithHavingOrLimit.length > 0) {
      // loop through an generate the partitions
      for (const result of this.rootResult.selectStructs(
        [],
        (_result: FieldInstanceResult) => true
      )) {
        const hasLimit = result.getLimit() !== undefined;
        hasResultsWithChildren ||=
          result.childGroups.length > 1 && (hasLimit || result.hasHaving);
        hasAnyLimits ||= hasLimit;

        // find all the parent dimension names.
        const dimensions: string[] = [];
        let r: FieldInstanceResult | undefined = result;
        while (r) {
          for (const name of r.fieldNames(fi => isScalarField(fi.f))) {
            dimensions.push(
              this.parent.dialect.sqlMaybeQuoteIdentifier(
                `${name}__${r.groupSet}`
              )
            );
          }
          r = r.parent;
        }

        let partition = '';
        if (dimensions.length > 0) {
          partition = 'PARTITION BY ';
          partition += dimensions
            .map(this.parent.dialect.castToString)
            .join(',');
        }
        partitionSQL[result.groupSet] = partition;
      }

      for (const result of resultsWithHavingOrLimit) {
        const limit = result.getLimit();
        // if we have a limit
        if (limit) {
          limitValues[result.groupSet] = limit;
          const obSQL: string[] = [];
          let orderingField;
          const orderByDef =
            (result.firstSegment as QuerySegment).orderBy ||
            result.calculateDefaultOrderBy();

          // Build up the ORDER BY clause from all ordering fields
          for (const ordering of orderByDef) {
            if (typeof ordering.field === 'string') {
              orderingField = {
                name: ordering.field,
                fif: result.getField(ordering.field),
              };
            } else {
              orderingField = result.getFieldByNumber(ordering.field);
            }
            obSQL.push(
              ' ' +
                this.parent.dialect.sqlMaybeQuoteIdentifier(
                  `${orderingField.name}__${result.groupSet}`
                ) +
                ` ${ordering.dir || 'ASC'}`
            );
          }

          // partition for a row number is the parent if it exists.
          let p = '';
          if (result.parent && partitionSQL[result.parent.groupSet]) {
            p = partitionSQL[result.parent.groupSet] + ', group_set';
          } else {
            p = 'PARTITION BY group_set';
          }

          // if this has nested data and a having, we want to partition by the 'having' so we don't count
          // deleted rows.
          if (result.hasHaving) {
            p = p + `, __delete__${result.groupSet}`;
          }

          // Generate a single ROW_NUMBER() with all ORDER BY fields
          limitExpressions.push(
            `CASE WHEN GROUP_SET=${result.groupSet} THEN
               ROW_NUMBER() OVER (${p} ORDER BY ${obSQL.join(
                 ','
               )}) END  as __row_number__${result.groupSet}`
          );

          // if the group set is a leaf, we can write a simple where clause.
          const filterClause = `(GROUP_SET = ${
            result.groupSet
          } AND __row_number__${result.groupSet} > ${
            limitValues[result.groupSet]
          })`;
          if (result.childGroups.length === 1) {
            limitSimpleFilters.push(filterClause);
          } else {
            // its a complex
            limitComplexClauses[result.groupSet] =
              `CASE WHEN ${filterClause} THEN 1 ELSE 0 END`;
          }
        }
      }
    }
    // generate over_limit flag
    if (resultsWithHavingOrLimit.length > 0) {
      if (limitExpressions.length > 0) {
        if (hasAnyLimits) {
          lastStageName = stageWriter.addStage(
            `SELECT\n  *,\n ${limitExpressions.join(
              ',\n'
            )} \nFROM ${lastStageName}\n`
          );
        }
      }
      let simpleLimits = '1=1';
      if (limitSimpleFilters.length > 0) {
        simpleLimits = ` NOT (${limitSimpleFilters.join('\n OR ')})`;
      }
      if (hasAnyLimits && !hasResultsWithChildren) {
        lastStageName = stageWriter.addStage(
          `SELECT * FROM ${lastStageName}\n WHERE ${simpleLimits}\n`
        );
      } else if (hasResultsWithChildren) {
        // we may or my not have any limits
        const havings = new AndChain();
        for (const result of resultsWithHavingOrLimit) {
          const testKey: string[] = [];
          // parent group
          if (result.hasHaving && result.childGroups.length > 1) {
            testKey.push(`__delete__${result.groupSet}`);
          }
          // limit
          if (limitComplexClauses[result.groupSet]) {
            testKey.push(limitComplexClauses[result.groupSet]);
          }

          if (testKey.length > 0 && result.childGroups.length > 1) {
            havingFields.push(
              `MAX(CASE WHEN group_set IN (${result.childGroups.join(
                ','
              )}) THEN ${testKey.join(' + ')}
               END) OVER(${partitionSQL[result.groupSet]}) as __shaving__${
                 result.groupSet
               }`
            );
            havings.add(
              `group_set IN (${result.childGroups.join(',')}) AND __shaving__${
                result.groupSet
              } > 0`
            );
          }
        }
        lastStageName = stageWriter.addStage(
          `SELECT\n  *,\n  ${havingFields.join(
            ',\n  '
          )} \nFROM ${lastStageName} WHERE ${simpleLimits}\n`
        );
        lastStageName = stageWriter.addStage(
          `SELECT *\nFROM ${lastStageName}\nWHERE NOT (${havings.sqlOr()})\n`
        );
      }
    }
    return lastStageName;
  }

  generateSQLStage0(stageWriter: StageWriter): string {
    let s = 'SELECT\n';
    let from = this.generateSQLJoins(stageWriter);
    const wheres = this.generateSQLWhereTurtled();

    const f: StageOutputContext = {
      dimensionIndexes: [1],
      fieldIndex: 2,
      sql: ['group_set'],
      lateralJoinSQLExpressions: [],
      groupsAggregated: [],
      outputPipelinedSQL: [],
    };
    this.generateStage0Fields(this.rootResult, f, stageWriter);

    if (
      this.firstSegment.type === 'project' &&
      !this.parent.modelCompilerFlags().has('unsafe_complex_select_query')
    ) {
      throw new Error('PROJECT cannot be used on queries with turtles');
    }

    const groupBy = 'GROUP BY ' + f.dimensionIndexes.join(',') + '\n';

    from += this.parent.dialect.sqlGroupSetTable(this.maxGroupSet) + '\n';

    s += indent(f.sql.join(',\n')) + '\n';

    // this should only happen on standard SQL,  BigQuery can't partition by expressions and
    //  aggregates.
    if (f.lateralJoinSQLExpressions.length > 0) {
      from += `LEFT JOIN UNNEST([STRUCT(${f.lateralJoinSQLExpressions.join(
        ',\n'
      )})]) as __lateral_join_bag\n`;
    }
    s += from + wheres + groupBy + this.rootResult.havings.sql('having');

    // generate the stage
    const resultStage = stageWriter.addStage(s);

    // generate stages for havings and limits
    this.resultStage = this.generateSQLHavingLimit(stageWriter, resultStage);

    this.resultStage = this.generatePipelinedStages(
      f.outputPipelinedSQL,
      this.resultStage,
      stageWriter
    );

    return this.resultStage;
  }

  generateDepthNFields(
    depth: number,
    resultSet: FieldInstanceResult,
    output: StageOutputContext,
    stageWriter: StageWriter
  ) {
    const groupsToMap: number[] = [];
    for (const [name, fi] of resultSet.allFields) {
      const sqlFieldName = this.parent.dialect.sqlMaybeQuoteIdentifier(
        `${name}__${resultSet.groupSet}`
      );
      if (fi instanceof FieldInstanceField) {
        if (fi.fieldUsage.type === 'result') {
          if (isScalarField(fi.f)) {
            const exp = caseGroup(
              resultSet.groupSet > 0 ? resultSet.childGroups : [],
              sqlFieldName
            );
            output.sql.push(`${exp} as ${sqlFieldName}`);
            output.dimensionIndexes.push(output.fieldIndex++);
          } else if (isBasicCalculation(fi.f)) {
            const exp = this.parent.dialect.sqlAnyValue(
              resultSet.groupSet,
              sqlFieldName
            );
            output.sql.push(`${exp} as ${sqlFieldName}`);
            output.fieldIndex++;
          }
        }
      } else if (fi instanceof FieldInstanceResult) {
        if (fi.depth > depth) {
          // ignore it, we've already dealt with it.
        } else if (fi.depth === depth) {
          const s = this.generateTurtleSQL(
            fi,
            stageWriter,
            sqlFieldName,
            output.outputPipelinedSQL
          );
          output.groupsAggregated.push({
            fromGroup: fi.groupSet,
            toGroup: resultSet.groupSet,
          });
          groupsToMap.push(fi.groupSet);
          output.sql.push(`${s} as ${sqlFieldName}`);
          output.fieldIndex++;
        } else {
          this.generateDepthNFields(depth, fi, output, stageWriter);
        }
      }
    }
    if (output.groupsAggregated.length > 0) {
      output.sql[0] = 'CASE ';
      for (const m of output.groupsAggregated) {
        output.sql[0] += `WHEN group_set=${m.fromGroup} THEN ${m.toGroup} `;
      }
      output.sql[0] += 'ELSE group_set END as group_set';
    }
  }

  generateSQLDepthN(
    depth: number,
    stageWriter: StageWriter,
    stageName: string
  ): string {
    let s = 'SELECT \n';
    const f: StageOutputContext = {
      dimensionIndexes: [1],
      fieldIndex: 2,
      sql: ['group_set'],
      lateralJoinSQLExpressions: [],
      groupsAggregated: [],
      outputPipelinedSQL: [],
    };
    this.generateDepthNFields(depth, this.rootResult, f, stageWriter);
    s += indent(f.sql.join(',\n')) + '\n';
    s += `FROM ${stageName}\n`;
    const where = this.rootResult.eliminateComputeGroupsSQL();
    if (where.length > 0) {
      s += `WHERE ${where}\n`;
    }
    if (f.dimensionIndexes.length > 0) {
      s += `GROUP BY ${f.dimensionIndexes.join(',')}\n`;
    }

    this.resultStage = stageWriter.addStage(s);

    this.resultStage = this.generatePipelinedStages(
      f.outputPipelinedSQL,
      this.resultStage,
      stageWriter
    );

    return this.resultStage;
  }

  genereateSQLCombineTurtles(
    stageWriter: StageWriter,
    stage0Name: string
  ): string {
    let s = 'SELECT\n';
    const fieldsSQL: string[] = [];
    let fieldIndex = 1;
    const outputPipelinedSQL: OutputPipelinedSQL[] = [];
    const dimensionIndexes: number[] = [];
    for (const [name, fi] of this.rootResult.allFields) {
      const sqlName = this.parent.dialect.sqlMaybeQuoteIdentifier(name);
      if (fi instanceof FieldInstanceField) {
        if (fi.fieldUsage.type === 'result') {
          if (isScalarField(fi.f)) {
            fieldsSQL.push(
              this.parent.dialect.sqlMaybeQuoteIdentifier(
                `${name}__${this.rootResult.groupSet}`
              ) + ` as ${sqlName}`
            );
            dimensionIndexes.push(fieldIndex++);
          } else if (isBasicCalculation(fi.f)) {
            fieldsSQL.push(
              this.parent.dialect.sqlAnyValueLastTurtle(
                this.parent.dialect.sqlMaybeQuoteIdentifier(
                  `${name}__${this.rootResult.groupSet}`
                ),
                this.rootResult.groupSet,
                sqlName
              )
            );
            fieldIndex++;
          }
        }
      } else if (fi instanceof FieldInstanceResult) {
        if (fi.firstSegment.type === 'reduce') {
          fieldsSQL.push(
            `${this.generateTurtleSQL(
              fi,
              stageWriter,
              sqlName,
              outputPipelinedSQL
            )} as ${sqlName}`
          );
          fieldIndex++;
        } else if (fi.firstSegment.type === 'project') {
          fieldsSQL.push(
            this.parent.dialect.sqlAnyValueLastTurtle(
              this.parent.dialect.sqlMaybeQuoteIdentifier(
                `${name}__${this.rootResult.groupSet}`
              ),
              this.rootResult.groupSet,
              sqlName
            )
          );
          fieldIndex++;
        }
      }
    }
    s += indent(fieldsSQL.join(',\n')) + `\nFROM ${stage0Name}\n`;

    const where = this.rootResult.eliminateComputeGroupsSQL();
    if (where.length > 0) {
      s += `WHERE ${where}\n`;
    }

    if (dimensionIndexes.length > 0) {
      s += `GROUP BY ${dimensionIndexes.join(',')}\n`;
    }

    // order by
    s += this.genereateSQLOrderBy(
      this.firstSegment as QuerySegment,
      this.rootResult
    );

    // limit
    if (!isRawSegment(this.firstSegment) && this.firstSegment.limit) {
      s += `LIMIT ${this.firstSegment.limit}\n`;
    }

    this.resultStage = stageWriter.addStage(s);
    this.resultStage = this.generatePipelinedStages(
      outputPipelinedSQL,
      this.resultStage,
      stageWriter
    );

    return this.resultStage;
  }

  // create a simplified version of the StructDef for dialects.
  buildDialectFieldList(resultStruct: FieldInstanceResult): DialectFieldList {
    const dialectFieldList: DialectFieldList = [];

    for (const [name, field] of resultStruct.allFields) {
      const sqlName = this.parent.dialect.sqlMaybeQuoteIdentifier(name);
      //
      if (
        resultStruct.firstSegment.type === 'reduce' &&
        field instanceof FieldInstanceResult
      ) {
        const {structDef, repeatedResultType} = this.generateTurtlePipelineSQL(
          field,
          new StageWriter(true, undefined),
          '<nosource>'
        );
        if (repeatedResultType === 'nested') {
          const multiLineNest: RepeatedRecordDef = {
            ...structDef,
            type: 'array',
            elementTypeDef: {type: 'record_element'},
            join: 'many',
            name,
          };
          dialectFieldList.push({
            typeDef: multiLineNest,
            sqlExpression: this.parent.dialect.sqlMaybeQuoteIdentifier(
              `${name}__${resultStruct.groupSet}`
            ),
            rawName: name,
            sqlOutputName: sqlName,
          });
        } else {
          const oneLineNest: RecordDef = {
            ...structDef,
            type: 'record',
            join: 'one',
            name,
          };
          dialectFieldList.push({
            typeDef: oneLineNest,
            sqlExpression: this.parent.dialect.sqlMaybeQuoteIdentifier(
              `${name}__${resultStruct.groupSet}`
            ),
            rawName: name,
            sqlOutputName: sqlName,
          });
        }
      } else if (
        resultStruct.firstSegment.type === 'reduce' &&
        field instanceof FieldInstanceField &&
        field.fieldUsage.type === 'result'
      ) {
        pushDialectField(dialectFieldList, {
          fieldDef: field.f.fieldDef,
          sqlExpression: this.parent.dialect.sqlMaybeQuoteIdentifier(
            `${name}__${resultStruct.groupSet}`
          ),
          rawName: name,
          sqlOutputName: sqlName,
        });
      } else if (
        resultStruct.firstSegment.type === 'project' &&
        field instanceof FieldInstanceField &&
        field.fieldUsage.type === 'result'
      ) {
        pushDialectField(dialectFieldList, {
          fieldDef: field.f.fieldDef,
          sqlExpression: field.generateExpression(),
          rawName: name,
          sqlOutputName: sqlName,
        });
      }
    }
    return dialectFieldList;
  }

  generateTurtleSQL(
    resultStruct: FieldInstanceResult,
    stageWriter: StageWriter,
    sqlFieldName: string,
    outputPipelinedSQL: OutputPipelinedSQL[]
  ): string {
    // let fieldsSQL: string[] = [];
    let orderBy = '';

    // calculate the ordering.
    const obSQL: string[] = [];
    let orderingField;
    const orderByDef =
      (resultStruct.firstSegment as QuerySegment).orderBy ||
      resultStruct.calculateDefaultOrderBy();
    for (const ordering of orderByDef) {
      if (typeof ordering.field === 'string') {
        orderingField = {
          name: ordering.field,
          fif: resultStruct.getField(ordering.field),
        };
      } else {
        orderingField = resultStruct.getFieldByNumber(ordering.field);
      }
      if (resultStruct.firstSegment.type === 'reduce') {
        obSQL.push(
          ' ' +
            this.parent.dialect.sqlMaybeQuoteIdentifier(
              `${orderingField.name}__${resultStruct.groupSet}`
            ) +
            ` ${ordering.dir || 'ASC'}`
        );
      } else if (resultStruct.firstSegment.type === 'project') {
        obSQL.push(
          ` ${orderingField.fif.generateExpression()} ${ordering.dir || 'ASC'}`
        );
      }
    }

    if (obSQL.length > 0) {
      orderBy = ' ' + this.parent.dialect.sqlOrderBy(obSQL, 'turtle');
    }

    const dialectFieldList = this.buildDialectFieldList(resultStruct);

    let resultType;
    let ret;
    if ((resultType = resultStruct.getRepeatedResultType()) !== 'nested') {
      if (resultType === 'inline_all_numbers') {
        ret = this.parent.dialect.sqlCoaleseMeasuresInline(
          resultStruct.groupSet,
          dialectFieldList
        );
      } else {
        ret = this.parent.dialect.sqlAnyValueTurtle(
          resultStruct.groupSet,
          dialectFieldList
        );
      }
    } else {
      ret = this.parent.dialect.sqlAggregateTurtle(
        resultStruct.groupSet,
        dialectFieldList,
        orderBy
      );
    }

    // If the turtle is a pipeline, generate a UDF to compute it.
    const newStageWriter = new StageWriter(
      this.parent.dialect.supportsCTEinCoorelatedSubQueries,
      stageWriter
    );
    const {structDef, pipeOut} = this.generateTurtlePipelineSQL(
      resultStruct,
      newStageWriter,
      this.parent.dialect.supportUnnestArrayAgg ? ret : sqlFieldName
    );

    // if there was a pipeline.
    if (pipeOut !== undefined) {
      const sql = newStageWriter.generateCoorelatedSubQuery(
        this.parent.dialect,
        structDef
      );

      if (this.parent.dialect.supportUnnestArrayAgg) {
        ret = `(${sql})`;
      } else {
        outputPipelinedSQL.push({
          sqlFieldName,
          pipelineSQL: `(${sql})`,
        });
      }
    }

    return ret;
    // return `${aggregateFunction}(CASE WHEN group_set=${
    //   resultStruct.groupSet
    // } THEN STRUCT(${fieldsSQL.join(",\n")}) END${tailSQL})`;
  }

  generateTurtlePipelineSQL(
    fi: FieldInstanceResult,
    stageWriter: StageWriter,
    sourceSQLExpression: string
  ) {
    let structDef = this.getResultStructDef(fi, false);
    const repeatedResultType = fi.getRepeatedResultType();
    const hasPipeline = fi.turtleDef.pipeline.length > 1;
    let pipeOut;
    let outputRepeatedResultType = repeatedResultType;
    if (hasPipeline) {
      const pipeline: PipeSegment[] = [...fi.turtleDef.pipeline];
      pipeline.shift();
      const newTurtle: TurtleDef = {
        type: 'turtle',
        name: 'starthere',
        pipeline,
      };
      const inputStruct: NestSourceDef = {
        type: 'nest_source',
        name: '~pipe~',
        pipeSQL: this.parent.dialect.sqlUnnestPipelineHead(
          repeatedResultType === 'inline_all_numbers',
          sourceSQLExpression,
          getDialectFieldList(structDef)
        ),
        fields: structDef.fields,
        connection: structDef.connection,
        dialect: structDef.dialect,
      };
      const qs = new QueryStruct(
        inputStruct,
        undefined,
        {model: this.parent.getModel()},
        this.parent.prepareResultOptions
      );
      const q = QueryQuery.makeQuery(
        newTurtle,
        qs,
        stageWriter,
        this.isJoinedSubquery,
        this.structRefToQueryStruct
      );
      pipeOut = q.generateSQLFromPipeline(stageWriter);
      outputRepeatedResultType = q.rootResult.getRepeatedResultType();
      // console.log(stageWriter.generateSQLStages());
      structDef = pipeOut.outputStruct;
    }
    structDef.annotation = fi.turtleDef.annotation;
    return {
      structDef,
      pipeOut,
      repeatedResultType: outputRepeatedResultType,
    };
  }

  generateComplexSQL(stageWriter: StageWriter): string {
    let stageName = this.generateSQLStage0(stageWriter);

    if (this.maxDepth > 1) {
      let i = this.maxDepth;
      while (i > 1) {
        stageName = this.generateSQLDepthN(i, stageWriter, stageName);
        i--;
      }
    }

    // nest the turtles.
    return this.genereateSQLCombineTurtles(stageWriter, stageName);
  }

  generateSQL(stageWriter: StageWriter): string {
    const r = this.rootResult.computeGroups(0, 0);
    this.maxDepth = r.maxDepth;
    this.maxGroupSet = r.nextGroupSetNumber - 1;

    this.rootResult.assignFieldsToGroups();

    this.rootResult.isComplexQuery ||= this.maxDepth > 0 || r.isComplex;
    // Pre-scan for raw column .sum() / .avg() calls on spine pre-agg joins so that
    // generateSQLJoinBlock can include the necessary pre-agg columns before any
    // SQL is emitted. .avg() needs SUM+COUNT (not AVG) for correct decomposition.
    this.scanForSpineRawColSums();
    this.scanForSpineRawColAvgs();
    if (this.rootResult.isComplexQuery) {
      return this.generateComplexSQL(stageWriter);
    } else {
      return this.generateSimpleSQL(stageWriter);
    }
  }

  generateSQLFromPipeline(stageWriter: StageWriter): {
    lastStageName: string;
    outputStruct: QueryResultDef;
  } {
    this.parent.maybeEmitParameterizedSourceUsage();
    this.prepare(stageWriter);
    let lastStageName = this.generateSQL(stageWriter);
    let outputStruct = this.getResultStructDef();
    const pipeline = [...this.fieldDef.pipeline];
    if (pipeline.length > 1) {
      // console.log(pretty(outputStruct));
      let structDef: FinalizeSourceDef = {
        ...outputStruct,
        name: lastStageName,
        type: 'finalize',
      };
      pipeline.shift();
      for (const transform of pipeline) {
        const parentArg = this.parent.parent
          ? {struct: this.parent.parent}
          : {model: this.parent.getModel()};
        const s = new QueryStruct(
          structDef,
          undefined,
          parentArg,
          this.parent.prepareResultOptions
        );
        const q = QueryQuery.makeQuery(
          {type: 'turtle', name: '~computeLastStage~', pipeline: [transform]},
          s,
          stageWriter,
          this.isJoinedSubquery,
          this.structRefToQueryStruct
        );
        q.prepare(stageWriter);
        lastStageName = q.generateSQL(stageWriter);
        outputStruct = q.getResultStructDef();
        structDef = {
          ...outputStruct,
          name: lastStageName,
          type: 'finalize',
        };
      }
    }
    return {lastStageName, outputStruct};
  }
}
//  wildcards have been expanded
//  nested repeated fields are safe to use.
class QueryQueryIndexStage extends QueryQuery {
  fieldDef: TurtleDef;
  indexPaths: Record<string, string[]> = {};
  constructor(
    fieldDef: TurtleDef,
    parent: QueryStruct,
    stageWriter: StageWriter | undefined,
    isJoinedSubquery: boolean,
    zz: (name: string) => QueryStruct | undefined
  ) {
    super(fieldDef, parent, stageWriter, isJoinedSubquery, zz);
    this.fieldDef = fieldDef;
  }

  expandField(f: IndexFieldDef) {
    const as = f.path.join('.');
    const field = this.parent.getQueryFieldByName(f.path);
    return {as, field};
  }

  expandFields(resultStruct: FieldInstanceResult) {
    let resultIndex = 1;
    const groupIndex = resultStruct.groupSet;
    this.maxGroupSet = groupIndex;

    for (const f of (this.firstSegment as IndexSegment).indexFields) {
      const {as, field} = this.expandField(f);
      const referencePath = f.path;
      this.indexPaths[as] = referencePath;

      resultStruct.addField(
        as,
        field as QueryField,
        {
          resultIndex,
          type: 'result',
        },
        undefined
      );
      resultIndex++;
    }
    const measure = (this.firstSegment as IndexSegment).weightMeasure;
    if (measure !== undefined) {
      const f = this.parent.getFieldByName([measure]) as QueryField;
      resultStruct.addField(
        measure,
        f,
        {
          resultIndex,
          type: 'result',
        },
        undefined
      );
    }
  }

  generateSQL(stageWriter: StageWriter): string {
    let measureSQL = 'COUNT(*)';
    const dialect = this.parent.dialect;
    const fieldNameColumn = dialect.sqlMaybeQuoteIdentifier('fieldName');
    const fieldPathColumn = dialect.sqlMaybeQuoteIdentifier('fieldPath');
    const fieldValueColumn = dialect.sqlMaybeQuoteIdentifier('fieldValue');
    const fieldTypeColumn = dialect.sqlMaybeQuoteIdentifier('fieldType');
    const fieldRangeColumn = dialect.sqlMaybeQuoteIdentifier('fieldRange');
    const weightColumn = dialect.sqlMaybeQuoteIdentifier('weight');
    const measureName = (this.firstSegment as IndexSegment).weightMeasure;
    if (measureName) {
      measureSQL = this.rootResult.getField(measureName).generateExpression();
    }

    const fields: Array<{
      name: string;
      path: string[];
      type: string;
      expression: string;
    }> = [];
    for (const [name, field] of this.rootResult.allFields) {
      const fi = field as FieldInstanceField;
      if (fi.fieldUsage.type === 'result' && isScalarField(fi.f)) {
        const expression = fi.generateExpression();
        const path = this.indexPaths[name] || [];
        fields.push({name, path, type: fi.f.fieldDef.type, expression});
      }
    }

    let s = 'SELECT\n  group_set,\n';

    s += '  CASE group_set\n';
    for (let i = 0; i < fields.length; i++) {
      s += `    WHEN ${i} THEN '${fields[i].name}'\n`;
    }
    s += `  END as ${fieldNameColumn},\n`;

    s += '  CASE group_set\n';
    for (let i = 0; i < fields.length; i++) {
      const path = pathToCol(fields[i].path);
      s += `    WHEN ${i} THEN '${path}'\n`;
    }
    s += `  END as ${fieldPathColumn},\n`;

    s += '  CASE group_set\n';
    for (let i = 0; i < fields.length; i++) {
      s += `    WHEN ${i} THEN '${fields[i].type}'\n`;
    }
    s += `  END as ${fieldTypeColumn},`;

    s += `  CASE group_set WHEN 99999 THEN ${dialect.castToString('NULL')}\n`;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].type === 'string') {
        s += `    WHEN ${i} THEN ${fields[i].expression}\n`;
      }
    }
    s += `  END as ${fieldValueColumn},\n`;

    s += ` ${measureSQL} as ${weightColumn},\n`;

    // just in case we don't have any field types, force the case statement to have at least one value.
    s += "  CASE group_set\n    WHEN 99999 THEN ''";
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].type === 'number') {
        s += `    WHEN ${i} THEN ${dialect.concat(
          `MIN(${dialect.castToString(fields[i].expression)})`,
          "' to '",
          dialect.castToString(`MAX(${fields[i].expression})`)
        )}\n`;
      }
      if (isTemporalType(fields[i].type)) {
        s += `    WHEN ${i} THEN ${dialect.concat(
          `MIN(${dialect.sqlDateToString(fields[i].expression)})`,
          "' to '",
          `MAX(${dialect.sqlDateToString(fields[i].expression)})`
        )}\n`;
      }
    }
    s += `  END as ${fieldRangeColumn}\n`;

    // CASE
    //   WHEN field_type = 'timestamp' or field_type = 'date'
    //     THEN MIN(field_value) || ' to ' || MAX(field_value)
    //   WHEN field_type = 'number'
    //     THEN
    // ELSE NULL
    // END as field_range\n`;

    s += this.generateSQLJoins(stageWriter);

    s += dialect.sqlGroupSetTable(fields.length) + '\n';

    s += this.generateSQLFilters(this.rootResult, 'where').sql('where');

    s += 'GROUP BY 1,2,3,4,5\n';

    // limit
    if (!isRawSegment(this.firstSegment) && this.firstSegment.limit) {
      s += `LIMIT ${this.firstSegment.limit}\n`;
    }
    // console.log(s);
    const resultStage = stageWriter.addStage(s);
    this.resultStage = stageWriter.addStage(
      `SELECT
  ${fieldNameColumn},
  ${fieldPathColumn},
  ${fieldTypeColumn},
  COALESCE(${fieldValueColumn}, ${fieldRangeColumn}) as ${fieldValueColumn},
  ${weightColumn}
FROM ${resultStage}\n`
    );
    return this.resultStage;
  }
}

class QueryQueryIndex extends QueryQuery {
  fieldDef: TurtleDef;
  stages: RefToField[][] = [];

  constructor(
    fieldDef: TurtleDef,
    parent: QueryStruct,
    stageWriter: StageWriter | undefined,
    isJoinedSubquery: boolean,
    lookupStruct: (name: string) => QueryStruct | undefined
  ) {
    super(fieldDef, parent, stageWriter, isJoinedSubquery, lookupStruct);
    this.fieldDef = fieldDef;
    this.fieldsToStages();
  }

  fieldsToStages() {
    const indexSeg = this.firstSegment as IndexSegment;
    if (this.parent.dialect.dontUnionIndex) {
      this.stages = [indexSeg.indexFields];
      return;
    }

    // Collect the field references by unique path, the final
    // index will be a union indexes from each unique path
    const stageMap: Record<string, RefToField[]> = {};
    for (const fref of indexSeg.indexFields) {
      if (fref.path.length > 1) {
        const stageRoot = pathToCol(fref.path.slice(0, fref.path.length - 1));
        const stage = stageMap[stageRoot];
        if (stage === undefined) {
          const f = this.parent.nameMap.get(fref.path[0]);
          if (
            f instanceof QueryFieldStruct &&
            f.fieldDef.join === 'many' &&
            f.fieldDef.fields.length > 1
          ) {
            const toStage = [fref];
            stageMap[stageRoot] = toStage;
            this.stages.push(toStage);
            continue;
          }
        } else {
          stage.push(fref);
          continue;
        }
      }
      if (this.stages[0] === undefined) {
        this.stages[0] = [];
      }
      this.stages[0].push(fref);
    }
  }

  expandFields(_resultStruct: FieldInstanceResult) {}

  generateSQL(stageWriter: StageWriter): string {
    const indexSeg = this.firstSegment as IndexSegment;
    const outputStageNames: string[] = [];
    for (const fields of this.stages) {
      const q = new QueryQueryIndexStage(
        {
          ...this.fieldDef,
          pipeline: [
            {
              ...indexSeg,
              indexFields: fields,
            },
          ],
        },
        this.parent,
        stageWriter,
        this.isJoinedSubquery,
        this.structRefToQueryStruct
      );
      q.prepare(stageWriter);
      const lastStageName = q.generateSQL(stageWriter);
      outputStageNames.push(lastStageName);
    }
    if (outputStageNames.length === 1) {
      this.resultStage = outputStageNames[0];
    } else {
      this.resultStage = stageWriter.addStage(
        outputStageNames.map(n => `SELECT * FROM ${n}\n`).join(' UNION ALL \n')
      );
    }
    return this.resultStage;
  }

  /**
   * All Indexes have the same output schema.
   *   fieldName is deprecated, dots in fieldName may or may not be join nodes
   *   fieldPath is a URL encoded slash separated path
   */
  getResultStructDef(): QueryResultDef {
    const ret: StructDef = {
      type: 'query_result',
      name: this.resultStage || 'result',
      dialect: this.parent.dialect.name,
      fields: [
        {type: 'string', name: 'fieldName'},
        {type: 'string', name: 'fieldPath'},
        {type: 'string', name: 'fieldValue'},
        {type: 'string', name: 'fieldType'},
        {type: 'number', name: 'weight', numberType: 'integer'},
      ],
      connection: this.parent.connectionName,
    };
    if (this.parent.structDef.modelAnnotation) {
      ret.modelAnnotation = this.parent.structDef.modelAnnotation;
    }
    return ret;
  }
}

class QueryQueryProject extends QueryQuery {}

class QueryQueryRaw extends QueryQuery {
  generateSQL(stageWriter: StageWriter): string {
    if (this.parent.structDef.type !== 'sql_select') {
      throw new Error(
        'Invalid struct for QueryQueryRaw, currently only supports SQL'
      );
    }
    return stageWriter.addStage(
      getCompiledSQL(
        this.parent.structDef,
        this.parent.prepareResultOptions ?? {},
        path => this.parent.dialect.quoteTablePath(path),
        (query, opts) => {
          // Compile query to isolated SQL (not into parent's stageWriter)
          const ret = this.compileQueryToStages(
            query,
            opts ?? {},
            undefined,
            false
          );
          return ret.sql!;
        }
      )
    );
  }

  prepare() {
    // Do nothing!
  }

  getResultStructDef(): QueryResultDef {
    if (!isSourceDef(this.parent.structDef)) {
      throw new Error(`Result cannot be type ${this.parent.structDef.type}`);
    }
    return {...this.parent.structDef, type: 'query_result'};
  }

  getResultMetadata(
    _fi: FieldInstance
  ): ResultStructMetadataDef | ResultMetadataDef | undefined {
    return undefined;
  }
}

class QueryQueryReduce extends QueryQuery {}
