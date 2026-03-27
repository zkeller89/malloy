/*
 * Copyright 2024 Google LLC
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

import {describeIfDatabaseAvailable} from '../../util';
import {RuntimeList} from '../../runtimes';
import '@malloydata/malloy/test/matchers';
import {wrapTestModel} from '@malloydata/malloy/test';

const [describe, databases] = describeIfDatabaseAvailable(['duckdb']);
const runtimes = new RuntimeList(databases);

afterAll(async () => {
  await runtimes.closeAll();
});

describe.each(runtimes.runtimeList)('%s', (_databaseName, runtime) => {
  const testModel = wrapTestModel(runtime, '');

  const eventSource = `
    source: events is duckdb.sql("""
      SELECT * FROM (VALUES
        ('A', TIMESTAMP '2020-01-15'),
        ('A', TIMESTAMP '2020-02-10'),
        ('B', TIMESTAMP '2020-01-25')
      ) t(category, event_date)
    """)
  `;

  const spineComposite = `
    ##! experimental { composite_sources parameters }
    ${eventSource}
    spine_composite: monthly_spine(grain::string) {
      spine_start: @2020-01-01
      spine_end: @2020-03-31
      spine_join: events {
        spine_date: event_date
        spine_group: category
      }
    }
  `;

  it('zero-fill: produces rows for all (date, group) combinations', async () => {
    // category B has no February or March events; spine should fill them in
    // so both A and B have 3 month rows (Jan, Feb, Mar)
    await expect(`
      ${spineComposite}
      run: monthly_spine(grain is 'month') -> {
        group_by: category
        aggregate: month_count is count()
        order_by: category
      }
    `).toMatchResult(
      testModel,
      {category: 'A', month_count: 3},
      {category: 'B', month_count: 3}
    );
  });

  it('total rows equals date_count × group_count', async () => {
    // 3 months × 2 categories = 6 rows total
    await expect(`
      ${spineComposite}
      run: monthly_spine(grain is 'month') -> {
        aggregate: total_rows is count()
      }
    `).toMatchResult(testModel, {total_rows: 6});
  });

  it('federated group alias: spine_group with is-rename', async () => {
    // Verify alias mapping: spine_group: group_alias is source_column
    await expect(`
      ##! experimental { composite_sources parameters }
      source: items is duckdb.sql("""
        SELECT * FROM (VALUES
          ('x', TIMESTAMP '2021-01-10'),
          ('y', TIMESTAMP '2021-02-15')
        ) t(item_code, ts)
      """)
      spine_composite: item_spine(grain::string) {
        spine_start: @2021-01-01
        spine_end: @2021-02-28
        spine_join: items {
          spine_date: ts
          spine_group: grp is item_code
        }
      }
      run: item_spine(grain is 'month') -> {
        group_by: grp
        aggregate: row_count is count()
        order_by: grp
      }
    `).toMatchResult(
      testModel,
      {grp: 'x', row_count: 2},
      {grp: 'y', row_count: 2}
    );
  });

  it('named measure via fact join alias: dep_flights.dep_count', async () => {
    // dep_count is count() in the flights source — after pre-aggregation it should
    // equal the actual count of fact rows in each (month, category) cell.
    await expect(`
      ##! experimental { composite_sources parameters }
      source: events2 is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', TIMESTAMP '2020-01-15'),
          ('A', TIMESTAMP '2020-01-28'),
          ('B', TIMESTAMP '2020-01-25')
        ) t(category, event_date)
      """) extend {
        measure: evt_count is count()
      }
      spine_composite: named_measure_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-02-28
        spine_join: dep is events2 {
          spine_date: event_date
          spine_group: category
        }
      }
      run: named_measure_spine(grain is 'month') -> {
        group_by: spine_date, category
        aggregate: cnt is dep.evt_count
        order_by: spine_date, category
      }
    `).toMatchResult(
      testModel,
      // Jan: A has 2 events, B has 1
      {category: 'A', cnt: 2},
      {category: 'B', cnt: 1},
      // Feb: zero-fill — COALESCE produces 0 (no events in Feb)
      {category: 'A', cnt: 0},
      {category: 'B', cnt: 0}
    );
  });

  it('two fact joins on same source: no fan-out', async () => {
    // When two spine_join entries reference the same fact table, aggregates must
    // NOT be inflated by a Cartesian product.  dep + arr each have 2 rows in Jan;
    // wrong fan-out would give 4 instead of 2 for each.
    // Also verifies anonymous count() equals named count() — UNION ALL in the base
    // grid would duplicate group rows and cause anonymous count() to double named count.
    await expect(`
      ##! experimental { composite_sources parameters }
      source: events3 is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', TIMESTAMP '2020-01-10', TIMESTAMP '2020-01-11'),
          ('A', TIMESTAMP '2020-01-20', TIMESTAMP '2020-01-21')
        ) t(category, dep_date, arr_date)
      """) extend {
        measure: evt_count is count()
      }
      spine_composite: fanout_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-01-31
        spine_join: dep_flights is events3 {
          spine_date: dep_date
          spine_group: category
        }
        spine_join: arr_flights is events3 {
          spine_date: arr_date
          spine_group: category
        }
      }
      run: fanout_spine(grain is 'month') -> {
        group_by: category
        aggregate:
          deps is dep_flights.evt_count,
          arrs is arr_flights.evt_count,
          deps_anon is dep_flights.count(),
          arrs_anon is arr_flights.count()
      }
    `).toMatchResult(
      testModel,
      {category: 'A', deps: 2, arrs: 2, deps_anon: 2, arrs_anon: 2}
    );
  });

  it('no spine_group: produces one row per date period', async () => {
    // Without groups, spine is just a date series
    await expect(`
      ##! experimental { composite_sources parameters }
      source: simple_events is duckdb.sql("""
        SELECT * FROM (VALUES
          (TIMESTAMP '2022-06-15'),
          (TIMESTAMP '2022-08-20')
        ) t(ts)
      """)
      spine_composite: date_spine(grain::string) {
        spine_start: @2022-06-01
        spine_end: @2022-08-31
        spine_join: simple_events {
          spine_date: ts
        }
      }
      run: date_spine(grain is 'month') -> {
        aggregate: month_count is count()
      }
    `).toMatchResult(testModel, {month_count: 3});
  });

  it('count() on fact join: returns actual row count per cell', async () => {
    // count() on a spine fact join should return the true number of fact rows
    // per (period, group) cell via COALESCE(SUM(__preagg_count), 0).
    await expect(`
      ##! experimental { composite_sources parameters }
      source: events6 is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', TIMESTAMP '2020-01-10'),
          ('A', TIMESTAMP '2020-01-20'),
          ('B', TIMESTAMP '2020-01-15')
        ) t(category, event_date)
      """)
      spine_composite: count_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-02-28
        spine_join: events6 {
          spine_date: event_date
          spine_group: category
        }
      }
      run: count_spine(grain is 'month') -> {
        group_by: spine_date, category
        aggregate: joined is events6.count()
        order_by: spine_date, category
      }
    `).toMatchResult(
      testModel,
      {category: 'A', joined: 2},   // Jan: 2 events
      {category: 'B', joined: 1},   // Jan: 1 event
      {category: 'A', joined: 0},   // Feb: zero-fill
      {category: 'B', joined: 0}    // Feb: zero-fill
    );
  });

  it('invalid grain throws a clear error', async () => {
    const query = testModel.model.loadQuery(`
      ${spineComposite}
      run: monthly_spine(grain is 'fortnight') -> {
        aggregate: total_rows is count()
      }
    `);
    await expect(query.run()).rejects.toThrow(/Invalid spine grain 'fortnight'/);
  });

  it('computed dimension in spine_group: resolves via expression compiler', async () => {
    // cat_upper is a computed dimension (upper(category)); spine_group must resolve
    // the expression, not use the computed-field name as a bare SQL column.
    await expect(`
      ##! experimental { composite_sources parameters }
      source: events5 is duckdb.sql("""
        SELECT * FROM (VALUES
          ('a', TIMESTAMP '2020-01-10'),
          ('b', TIMESTAMP '2020-01-20'),
          ('a', TIMESTAMP '2020-02-05')
        ) t(category, event_date)
      """) extend {
        dimension: cat_upper is upper(category)
      }
      spine_composite: computed_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-02-28
        spine_join: events5 {
          spine_date: event_date
          spine_group: cat_upper
        }
      }
      run: computed_spine(grain is 'month') -> {
        group_by: cat_upper
        aggregate: row_count is count()
        order_by: cat_upper
      }
    `).toMatchResult(
      testModel,
      // both 'A' and 'B' (upper-cased) should appear in both months → 2 rows each
      {cat_upper: 'A', row_count: 2},
      {cat_upper: 'B', row_count: 2}
    );
  });

  it('raw column .sum() on fact join: aggregates from fact table column', async () => {
    // dep_flights.distance.sum() is a raw column sum — distance is not a named
    // measure in the source, so it needs to be added to the pre-agg at query time.
    // Jan: A has 2 events (distance 100 + 200 = 300); B has 1 event (distance 50).
    // Feb: zero-fill → COALESCE produces 0.
    await expect(`
      ##! experimental { composite_sources parameters }
      source: events_dist is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', TIMESTAMP '2020-01-10', 100),
          ('A', TIMESTAMP '2020-01-20', 200),
          ('B', TIMESTAMP '2020-01-15', 50)
        ) t(category, event_date, distance)
      """)
      spine_composite: dist_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-02-28
        spine_join: dep is events_dist {
          spine_date: event_date
          spine_group: category
        }
      }
      run: dist_spine(grain is 'month') -> {
        group_by: spine_date, category
        aggregate: total_dist is dep.distance.sum()
        order_by: spine_date, category
      }
    `).toMatchResult(
      testModel,
      {category: 'A', total_dist: 300},  // Jan: 100 + 200
      {category: 'B', total_dist: 50},   // Jan: 50
      {category: 'A', total_dist: 0},    // Feb: zero-fill
      {category: 'B', total_dist: 0}     // Feb: zero-fill
    );
  });

  it('raw column .avg() on fact join: decomposes into SUM/COUNT pre-agg', async () => {
    // dep.distance.avg() is a raw column average — not decomposable as AVG(AVG(x)).
    // Pre-agg carries SUM(distance) and COUNT(distance) per (spine_date, category) cell;
    // the outer query emits SUM(__preagg_sum_distance) / NULLIF(SUM(__preagg_count_distance), 0).
    // Jan: A has 2 events (100, 200) → avg = 150; B has 1 event (50) → avg = 50.
    // Feb: zero-fill → avg = null (no rows, division produces null).
    await expect(`
      ##! experimental { composite_sources parameters }
      source: events_avg is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', TIMESTAMP '2020-01-10', 100),
          ('A', TIMESTAMP '2020-01-20', 200),
          ('B', TIMESTAMP '2020-01-15', 50)
        ) t(category, event_date, distance)
      """)
      spine_composite: avg_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-02-28
        spine_join: dep is events_avg {
          spine_date: event_date
          spine_group: category
        }
      }
      run: avg_spine(grain is 'month') -> {
        group_by: spine_date, category
        aggregate: avg_dist is dep.distance.avg()
        order_by: spine_date, category
      }
    `).toMatchResult(
      testModel,
      {category: 'A', avg_dist: 150},  // Jan: (100 + 200) / 2
      {category: 'B', avg_dist: 50},   // Jan: 50 / 1
      {category: 'A', avg_dist: null}, // Feb: zero-fill → null
      {category: 'B', avg_dist: null}  // Feb: zero-fill → null
    );
  });

  it('multiple spine_group: dims produce correct (date × carrier × region) grid', async () => {
    // Only 2 distinct (carrier, region) pairs exist: (A, east) and (B, west).
    // DISTINCT groups gives those 2 pairs (not a 2×2 cross product) × 2 months = 4 rows.
    // Jan: (A, east) has 1 event; (B, west) zero-fill.
    // Feb: (B, west) has 1 event; (A, east) zero-fill.
    await expect(`
      ##! experimental { composite_sources parameters }
      source: events7 is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', 'east', TIMESTAMP '2020-01-10'),
          ('B', 'west', TIMESTAMP '2020-02-15')
        ) t(carrier, region, event_date)
      """) extend {
        measure: evt_count is count()
      }
      spine_composite: multi_group_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-02-28
        spine_join: events7 {
          spine_date: event_date
          spine_group: carrier
          spine_group: region
        }
      }
      run: multi_group_spine(grain is 'month') -> {
        group_by: spine_date, carrier, region
        aggregate: cnt is events7.evt_count
        order_by: spine_date, carrier, region
      }
    `).toMatchResult(
      testModel,
      {carrier: 'A', region: 'east', cnt: 1},  // Jan: 1 event
      {carrier: 'B', region: 'west', cnt: 0},  // Jan: zero-fill
      {carrier: 'A', region: 'east', cnt: 0},  // Feb: zero-fill
      {carrier: 'B', region: 'west', cnt: 1}   // Feb: 1 event
    );
  });

  it('differing alias sets: per-alias CROSS JOIN strategy', async () => {
    // dep_facts groups by [carrier, region]; arr_facts groups by [carrier] only.
    // Only (A,east) and (B,west) co-occur in dep_facts, but the base grid is the full
    // Cartesian product: {A,B} × {east,west} = 4 rows per date period.
    // arr_facts joins only on (spine_date, carrier), so its counts are duplicated
    // across all region values for a given carrier.
    await expect(`
      ##! experimental { composite_sources parameters }
      source: dep_facts is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', 'east', TIMESTAMP '2020-01-10'),
          ('B', 'west', TIMESTAMP '2020-01-15')
        ) t(carrier, region, dep_date)
      """) extend { measure: dep_count is count() }
      source: arr_facts is duckdb.sql("""
        SELECT * FROM (VALUES
          ('A', TIMESTAMP '2020-01-11'),
          ('B', TIMESTAMP '2020-01-16')
        ) t(carrier, arr_date)
      """) extend { measure: arr_count is count() }
      spine_composite: mixed_alias_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-01-31
        spine_join: dep is dep_facts {
          spine_date: dep_date
          spine_group: carrier
          spine_group: region
        }
        spine_join: arr is arr_facts {
          spine_date: arr_date
          spine_group: carrier
        }
      }
      run: mixed_alias_spine(grain is 'month') -> {
        group_by: carrier, region
        aggregate: deps is dep.dep_count, arrs is arr.arr_count
        order_by: carrier, region
      }
    `).toMatchResult(
      testModel,
      {carrier: 'A', region: 'east', deps: 1, arrs: 1},
      {carrier: 'A', region: 'west', deps: 0, arrs: 1},
      {carrier: 'B', region: 'east', deps: 0, arrs: 1},
      {carrier: 'B', region: 'west', deps: 1, arrs: 1}
    );
  });

  it('differing alias sets: emits compile-time warning', async () => {
    const source = `
      ##! experimental { composite_sources parameters }
      source: dep_facts is duckdb.sql("""
        SELECT * FROM (VALUES ('A', 'east', TIMESTAMP '2020-01-10')) t(carrier, region, dep_date)
      """)
      source: arr_facts is duckdb.sql("""
        SELECT * FROM (VALUES ('A', TIMESTAMP '2020-01-11')) t(carrier, arr_date)
      """)
      spine_composite: warn_spine(grain::string) {
        spine_start: @2020-01-01
        spine_end: @2020-01-31
        spine_join: dep is dep_facts {
          spine_date: dep_date
          spine_group: carrier
          spine_group: region
        }
        spine_join: arr is arr_facts {
          spine_date: arr_date
          spine_group: carrier
        }
      }
    `;
    const model = await runtime.getModel(source);
    expect(model).toMatchObject({
      problems: [
        {
          severity: 'warn',
          message: expect.stringContaining('different spine_group alias sets'),
        },
      ],
    });
  });
});
