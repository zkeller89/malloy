/* eslint-disable no-console */
/**
 * show-ast.ts - Display the Malloy AST or IR for a .malloy file
 *
 * Modes:
 *   --ast (default)  MalloyElement tree produced by MalloyToAST (one level
 *                    above the raw ANTLR4 parse tree)
 *   --ir             ModelDef JSON produced by Document.compile() — the IR
 *                    handed off to the SQL code generator
 *
 * Usage (from packages/malloy/):
 *   npx ts-node show-ast.ts [--ast|--ir] <path/to/file.malloy>
 *
 * Table schemas are stubbed with empty field lists so the script works
 * without a live database connection.  For --ir this means field-level type
 * info from external tables is absent, but the source/query structure is
 * fully visible.
 */

import * as fs from 'fs';
import * as path from 'path';
import {MalloyTranslator} from './src/lang/parse-malloy';
import {isNeedResponse} from './src/lang/translate-response';
import type {TableSourceDef} from './src/model/malloy_types';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let mode: 'ast' | 'ir' = 'ast';
const fileArgs: string[] = [];
for (const arg of args) {
  if (arg === '--ast') mode = 'ast';
  else if (arg === '--ir') mode = 'ir';
  else fileArgs.push(arg);
}

if (fileArgs.length !== 1) {
  console.error('Usage: npx ts-node show-ast.ts [--ast|--ir] <file.malloy>');
  process.exit(1);
}

const absolutePath = path.resolve(fileArgs[0]);
if (!fs.existsSync(absolutePath)) {
  console.error(`File not found: ${absolutePath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Translator setup
// ---------------------------------------------------------------------------
const fileURL = `file://${absolutePath}`;
const source = fs.readFileSync(absolutePath, 'utf-8');

const translator = new MalloyTranslator(fileURL);
translator.update({urls: {[fileURL]: source}});

// ---------------------------------------------------------------------------
// Helper: satisfy a need response (tables / imports) and call update()
// ---------------------------------------------------------------------------
function satisfyNeeds(response: {
  tables?: Record<string, {connectionName: string | undefined; tablePath: string}>;
  urls?: string[];
}): void {
  const update: {
    tables?: Record<string, TableSourceDef>;
    urls?: Record<string, string>;
  } = {};

  // Provide empty-field stub schemas for any requested tables
  if (response.tables) {
    update.tables = {};
    for (const [tableKey, tableInfo] of Object.entries(response.tables)) {
      const stub: TableSourceDef = {
        type: 'table',
        name: tableInfo.tablePath,
        dialect: 'duckdb',
        tablePath: tableInfo.tablePath,
        connection: tableInfo.connectionName ?? 'unknown',
        fields: [],
      };
      update.tables[tableKey] = stub;
    }
  }

  // Read any imported .malloy files from disk
  if (response.urls) {
    update.urls = {};
    for (const url of response.urls) {
      try {
        const urlPath = new URL(url).pathname;
        update.urls[url] = fs.readFileSync(urlPath, 'utf-8');
        console.error(`[info] Loaded import: ${url}`);
      } catch {
        console.error(`[warn] Could not read import: ${url} — using empty file`);
        update.urls[url] = '';
      }
    }
  }

  translator.update(update);
}

// ---------------------------------------------------------------------------
// Helper: strip location/reference noise from IR for readable output
// ---------------------------------------------------------------------------
function cleanIR(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cleanIR);

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Drop document-position metadata and cross-reference arrays
    if (k === 'location' || k === 'at' || k === 'references' || k === 'imports') continue;
    if (v === undefined) continue;
    out[k] = cleanIR(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main loop — each step returns either needs-data, the answer, or a fatal error
// ---------------------------------------------------------------------------
const MAX_ITER = 50;

if (mode === 'ast') {
  // -- AST mode: drive astStep -------------------------------------------------
  for (let i = 0; i < MAX_ITER; i++) {
    const response = translator.astStep.step(translator);

    if (response.ast) {
      console.log(response.ast.toString());
      process.exit(0);
    }

    if (response.final) {
      console.error('\nTranslation errors:');
      for (const p of response.problems ?? []) {
        const loc = p.at
          ? ` (line ${p.at.range.start.line + 1}:${p.at.range.start.character + 1})`
          : '';
        console.error(`  [${p.severity}]${loc} ${p.message}`);
      }
      process.exit(1);
    }

    if (!isNeedResponse(response)) {
      console.error('Unexpected empty response from translator');
      process.exit(1);
    }

    satisfyNeeds(response);
  }
} else {
  // -- IR mode: drive translateStep -------------------------------------------
  for (let i = 0; i < MAX_ITER; i++) {
    const response = translator.translate();

    if (response.modelDef) {
      console.log(JSON.stringify(cleanIR(response.modelDef), null, 2));
      if (response.problems?.length) {
        console.error('\nWarnings:');
        for (const p of response.problems) {
          const loc = p.at
            ? ` (line ${p.at.range.start.line + 1}:${p.at.range.start.character + 1})`
            : '';
          console.error(`  [${p.severity}]${loc} ${p.message}`);
        }
      }
      process.exit(0);
    }

    if (response.final) {
      // Compilation ran but logged errors.  translator.modelDef is still
      // populated with whatever was successfully compiled — show it, then
      // print the errors as warnings so the user knows what couldn't be
      // resolved (typically column references into our empty stub schemas).
      const partialModel = translator.modelDef;
      console.log(JSON.stringify(cleanIR(partialModel), null, 2));
      console.error(
        '\nNote: field-reference errors below are expected when columns come' +
          ' from external tables — the script stubs schemas with no fields.'
      );
      for (const p of response.problems ?? []) {
        const loc = p.at
          ? ` (line ${p.at.range.start.line + 1}:${p.at.range.start.character + 1})`
          : '';
        console.error(`  [${p.severity}]${loc} ${p.message}`);
      }
      process.exit(0);
    }

    if (!isNeedResponse(response)) {
      console.error('Unexpected empty response from translator');
      process.exit(1);
    }

    satisfyNeeds(response);
  }
}

console.error(`Exceeded ${MAX_ITER} iterations — possible circular imports`);
process.exit(1);
