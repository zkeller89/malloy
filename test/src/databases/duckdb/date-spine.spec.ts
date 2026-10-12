/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
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

/*
 * employees: hires Jan(eng, eng) Feb(null) Mar(eng, ops)
 *            terminations Mar(eng, ops)
 * requisitions: opened Feb(eng, ops) Apr(eng)
 */
const model = `
  ##! experimental.date_spine
  source: employees is duckdb.sql("""
    SELECT * FROM (VALUES
      (1, 'eng', DATE '2024-01-10', DATE '2024-03-05', 100),
      (2, 'eng', DATE '2024-01-20', NULL, 200),
      (3, 'ops', DATE '2024-03-15', DATE '2024-03-20', 50),
      (4, NULL,  DATE '2024-02-02', NULL, 80),
      (5, 'eng', DATE '2024-03-01', NULL, 120)
    ) t(id, dept, hire_date, term_date, salary)
  """) extend {
    measure: headcount is count()
  }
  source: requisitions is duckdb.sql("""
    SELECT * FROM (VALUES
      ('eng', TIMESTAMP '2024-02-01 10:00:00'),
      ('ops', TIMESTAMP '2024-02-11 09:00:00'),
      ('eng', TIMESTAMP '2024-04-03 12:00:00')
    ) t(department, opened_at)
  """)
  source: workforce is date_spine(employees, requisitions) extend {
    from employees {
      dimension: dept
      measure:
        hires is headcount at hire_date
        terminations is count() at term_date
        terms_filled is count() at term_date default 0
        hire_depts is count(dept) at hire_date
        avg_salary is salary.avg() at hire_date
    }
    from requisitions {
      dimension: dept is department
      measure: reqs_opened is count() at opened_at default 0
    }
    dimension: is_eng is dept = 'eng'
    measure: net is hires - terms_filled
    view: hires_by_month is {
      group_by: dspine.month
      aggregate: hires
      order_by: dspine
    }
  }
`;

describe.each(runtimes.runtimeList)(
  '%s date_spine',
  (_databaseName, runtime) => {
    const tm = wrapTestModel(runtime, model);

    it('two measures from one table on different dates, zero-filled', async () => {
      await expect(`
      run: workforce -> {
        group_by: dspine.month
        aggregate: hires, terminations, terms_filled, net
        order_by: dspine
      }
    `).toEqualResult(tm, [
        {
          dspine: '2024-01-01',
          hires: 2,
          terminations: null,
          terms_filled: 0,
          net: 2,
        },
        {
          dspine: '2024-02-01',
          hires: 1,
          terminations: null,
          terms_filled: 0,
          net: 1,
        },
        {
          dspine: '2024-03-01',
          hires: 2,
          terminations: 2,
          terms_filled: 2,
          net: 0,
        },
      ]);
    });

    it('measures from two tables on a shared dimension, dense over dates', async () => {
      await expect(`
      run: workforce -> {
        group_by: dspine.month, dept
        aggregate: hires, reqs_opened
        order_by: dspine, dept
      } -> {
        aggregate:
          row_count is count()
          total_hires is hires.sum()
          total_reqs is reqs_opened.sum()
      }
    `).toEqualResult(tm, [
        // Jan..Apr x (eng, ops, null)
        {row_count: 12, total_hires: 5, total_reqs: 3},
      ]);
      await expect(`
      run: workforce -> {
        where: dept = 'ops'
        group_by: dspine.month, dept
        aggregate: hires, reqs_opened
        order_by: dspine
      }
    `).toEqualResult(tm, [
        {dspine: '2024-02-01', dept: 'ops', hires: null, reqs_opened: 1},
        {dspine: '2024-03-01', dept: 'ops', hires: 1, reqs_opened: 0},
      ]);
    });

    it('null dimension values join null-safely', async () => {
      await expect(`
      run: workforce -> {
        where: dept = null
        group_by: dspine.month, dept
        aggregate: hires
      }
    `).toEqualResult(tm, [{dspine: '2024-02-01', dept: null, hires: 1}]);
    });

    it('count distinct and average are exact at a coarser grain', async () => {
      await expect(`
      run: workforce -> {
        group_by: dspine.quarter
        aggregate: hire_depts, avg_salary
      }
    `).toEqualResult(tm, [
        {dspine: '2024-01-01', hire_depts: 2, avg_salary: 110},
      ]);
    });

    it('totals with no spine date', async () => {
      await expect(`
      run: workforce -> {
        group_by: dept
        aggregate: hires, terminations, reqs_opened
        order_by: dept
      }
    `).toEqualResult(tm, [
        {dept: 'eng', hires: 3, terminations: 1, reqs_opened: 2},
        {dept: 'ops', hires: 1, terminations: 1, reqs_opened: 1},
        {dept: null, hires: 1, terminations: null, reqs_opened: 0},
      ]);
    });

    it('a derived dimension groups like a shared one', async () => {
      await expect(`
      run: workforce -> {
        group_by: is_eng
        aggregate: hires
        order_by: is_eng
      }
    `).toEqualResult(tm, [
        {is_eng: false, hires: 1},
        {is_eng: true, hires: 3},
        {is_eng: null, hires: 1},
      ]);
    });

    it('a dspine filter applies to each event date', async () => {
      await expect(`
      run: workforce -> {
        where: dspine >= @2024-01-15
        group_by: dspine.month
        aggregate: hires
        order_by: dspine
      }
    `).toEqualResult(tm, [
        {dspine: '2024-01-01', hires: 1},
        {dspine: '2024-02-01', hires: 1},
        {dspine: '2024-03-01', hires: 2},
      ]);
    });

    it('week grain and a pinned range', async () => {
      await expect(`
      run: workforce extend { spine_range: @2024-01-01 to @2024-01-31 } -> {
        group_by: dspine.week
        aggregate: hires
        order_by: dspine
      }
    `).toEqualResult(tm, [
        {dspine: '2023-12-31', hires: null},
        {dspine: '2024-01-07', hires: 1},
        {dspine: '2024-01-14', hires: 1},
        {dspine: '2024-01-21', hires: null},
        // the last week runs into February and includes the Feb 2 hire
        {dspine: '2024-01-28', hires: 1},
      ]);
    });

    it('having and calculate over the dense series', async () => {
      await expect(`
      run: workforce -> {
        group_by: dspine.month
        aggregate: reqs_opened
        calculate: prev is lag(reqs_opened)
        order_by: dspine
      }
    `).toEqualResult(tm, [
        // the spine spans the dates of the measures the query uses
        {dspine: '2024-02-01', reqs_opened: 2, prev: null},
        {dspine: '2024-03-01', reqs_opened: 0, prev: 2},
        {dspine: '2024-04-01', reqs_opened: 1, prev: 0},
      ]);
      await expect(`
      run: workforce -> {
        group_by: dspine.month
        aggregate: hires
        having: hires > 1
        order_by: dspine
      }
    `).toEqualResult(tm, [
        {dspine: '2024-01-01', hires: 2},
        {dspine: '2024-03-01', hires: 2},
      ]);
    });

    it('timestamp tether dates become civil dates', async () => {
      await expect(`
      run: workforce -> {
        group_by: dspine
        aggregate: reqs_opened
        having: reqs_opened > 0
        order_by: dspine
      }
    `).toEqualResult(tm, [
        {dspine: '2024-02-01', reqs_opened: 1},
        {dspine: '2024-02-11', reqs_opened: 1},
        {dspine: '2024-04-03', reqs_opened: 1},
      ]);
    });

    it('refining a view defined on the date_spine', async () => {
      await expect(`
      run: workforce -> hires_by_month + {where: dept = 'eng'}
    `).toEqualResult(tm, [
        {dspine: '2024-01-01', hires: 2},
        {dspine: '2024-02-01', hires: null},
        {dspine: '2024-03-01', hires: 1},
      ]);
    });

    it('a member measure through a join is not fanned out', async () => {
      await expect(`
      ##! experimental.date_spine
      source: orders is duckdb.sql("""
        SELECT * FROM (VALUES
          (1, DATE '2024-01-05', 10),
          (2, DATE '2024-02-07', 20)
        ) t(id, ordered_on, amount)
      """) extend {
        primary_key: id
        join_many: lines is duckdb.sql("""
          SELECT * FROM (VALUES (1, 'a'), (1, 'b'), (1, 'c'), (2, 'd'))
            t(order_id, sku)
        """) on lines.order_id = id
      }
      source: sales is date_spine(orders) extend {
        from orders {
          measure:
            revenue is amount.sum() at ordered_on
            line_count is lines.count() at ordered_on
        }
      }
      run: sales -> {
        group_by: dspine.month
        aggregate: revenue, line_count
        order_by: dspine
      }
    `).toEqualResult(tm, [
        {dspine: '2024-01-01', revenue: 10, line_count: 3},
        {dspine: '2024-02-01', revenue: 20, line_count: 1},
      ]);
    });
  }
);
