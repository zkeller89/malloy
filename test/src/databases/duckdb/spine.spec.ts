/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import {RuntimeList} from '../../runtimes';
import {describeIfDatabaseAvailable} from '../../util';
import '@malloydata/malloy/test/matchers';
import {wrapTestModel} from '@malloydata/malloy/test';

const [describe, databases] = describeIfDatabaseAvailable(['duckdb']);
const runtimes = new RuntimeList(databases);

describe.each(runtimes.runtimeList)('spine:%s', (dbName, runtime) => {
  const testModel = wrapTestModel(runtime, '');

  it('zero-fills missing dates with no groups', async () => {
    // fact table has 2 events on day 1 and 1 event on day 3 — day 2 has no events
    await expect(`
      source: events is ${dbName}.sql("""
        SELECT TIMESTAMP '2024-01-01 10:00:00' as event_time UNION ALL
        SELECT TIMESTAMP '2024-01-01 14:00:00' as event_time UNION ALL
        SELECT TIMESTAMP '2024-01-03 09:00:00' as event_time
      """) extend {
        # spine.date=event_time
        measure: event_count is count()
      }

      spine_source: daily_spine(grain::string) {
        start: @2024-01-01
        end: @2024-01-03
      }

      spine_composite: daily_events(grain::string) {
        spine: daily_spine
        spine_join: events
      }

      run: daily_events(grain is 'day') -> {
        group_by: spine_date
        aggregate: event_count
        order_by: spine_date
      }
    `).toMatchRows(testModel, [
      {event_count: 2},
      {event_count: 0},
      {event_count: 1},
    ]);
  });

  it('zero-fills missing dates with a group dimension', async () => {
    // flights on day 1 (carrier AA, 2 flights) and day 3 (carrier WN, 1 flight)
    // day 2 has no flights; carrier WN has no flights on day 1; carrier AA has none on day 3
    await expect(`
      source: mini_flights is ${dbName}.sql("""
        SELECT TIMESTAMP '2024-01-01 10:00:00' as dep_time, 'AA' as carrier UNION ALL
        SELECT TIMESTAMP '2024-01-01 14:00:00' as dep_time, 'AA' as carrier UNION ALL
        SELECT TIMESTAMP '2024-01-03 09:00:00' as dep_time, 'WN' as carrier
      """) extend {
        rename: carrier_raw is carrier
        # spine.group
        dimension: carrier is carrier_raw
        # spine.date=dep_time
        measure: flight_count is count()
      }

      spine_source: daily_spine(grain::string) {
        start: @2024-01-01
        end: @2024-01-03
      }

      spine_composite: daily_flights(grain::string) {
        spine: daily_spine
        spine_join: mini_flights
      }

      run: daily_flights(grain is 'day') -> {
        group_by: spine_date, carrier
        aggregate: flight_count
        order_by: spine_date, carrier
      }
    `).toMatchRows(testModel, [
      {carrier: 'AA', flight_count: 2},
      {carrier: 'WN', flight_count: 0},
      {carrier: 'AA', flight_count: 0},
      {carrier: 'WN', flight_count: 0},
      {carrier: 'AA', flight_count: 0},
      {carrier: 'WN', flight_count: 1},
    ]);
  });

  it('grain at query time changes granularity', async () => {
    // 4 events spread over 2024-01-01 through 2024-01-31 in same month
    await expect(`
      source: monthly_events is ${dbName}.sql("""
        SELECT TIMESTAMP '2024-01-01 10:00:00' as event_time UNION ALL
        SELECT TIMESTAMP '2024-01-15 12:00:00' as event_time UNION ALL
        SELECT TIMESTAMP '2024-01-20 08:00:00' as event_time UNION ALL
        SELECT TIMESTAMP '2024-02-05 10:00:00' as event_time
      """) extend {
        # spine.date=event_time
        measure: event_count is count()
      }

      spine_source: monthly_spine(grain::string) {
        start: @2024-01-01
        end: @2024-03-01
      }

      spine_composite: monthly_rollup(grain::string) {
        spine: monthly_spine
        spine_join: monthly_events
      }

      run: monthly_rollup(grain is 'month') -> {
        group_by: spine_date
        aggregate: event_count
        order_by: spine_date
      }
    `).toMatchRows(testModel, [
      {event_count: 3},
      {event_count: 1},
      {event_count: 0},
    ]);
  });

  it('handles renamed spine.date and spine.group fields', async () => {
    // Regression: joinFields used the Malloy alias as the SQL column name.
    // With rename: ts_col is raw_ts, the SQL column is raw_ts but the Malloy
    // name is ts_col.  The JOIN ON must reference raw_ts, not ts_col.
    await expect(`
      source: renamed_events is ${dbName}.sql("""
        SELECT TIMESTAMP '2024-01-01 10:00:00' as raw_ts, 'A' as raw_carrier UNION ALL
        SELECT TIMESTAMP '2024-01-01 14:00:00' as raw_ts, 'A' as raw_carrier UNION ALL
        SELECT TIMESTAMP '2024-01-03 09:00:00' as raw_ts, 'B' as raw_carrier
      """) extend {
        rename: ts_col is raw_ts
        rename: carrier_col is raw_carrier
        # spine.group
        dimension: carrier is carrier_col
        # spine.date=ts_col
        measure: event_count is count()
      }

      spine_source: rename_spine(grain::string) {
        start: @2024-01-01
        end: @2024-01-03
      }

      spine_composite: rename_rollup(grain::string) {
        spine: rename_spine
        spine_join: renamed_events
      }

      run: rename_rollup(grain is 'day') -> {
        group_by: spine_date, carrier
        aggregate: event_count
        order_by: spine_date, carrier
      }
    `).toMatchRows(testModel, [
      {carrier: 'A', event_count: 2},
      {carrier: 'B', event_count: 0},
      {carrier: 'A', event_count: 0},
      {carrier: 'B', event_count: 0},
      {carrier: 'A', event_count: 0},
      {carrier: 'B', event_count: 1},
    ]);
  });

  it('works when the fact source declares a primary_key', async () => {
    // Regression: joinEntry inherits primaryKey from the fact source via ...entry.
    // The expression compiler tries to resolve that field for symmetric aggregate
    // detection and fails if it isn't present in joinFields.
    await expect(`
      source: keyed_events is ${dbName}.sql("""
        SELECT 1 as id, TIMESTAMP '2024-01-01 10:00:00' as event_time UNION ALL
        SELECT 2 as id, TIMESTAMP '2024-01-15 12:00:00' as event_time UNION ALL
        SELECT 3 as id, TIMESTAMP '2024-02-05 10:00:00' as event_time
      """) extend {
        primary_key: id
        # spine.date=event_time
        measure: event_count is count()
      }

      spine_source: pk_spine(grain::string) {
        start: @2024-01-01
        end:   @2024-03-01
      }

      spine_composite: pk_rollup(grain::string) {
        spine: pk_spine
        spine_join: keyed_events
      }

      run: pk_rollup(grain is 'month') -> {
        group_by: spine_date
        aggregate: event_count
        order_by: spine_date
      }
    `).toMatchRows(testModel, [
      {event_count: 2},
      {event_count: 1},
      {event_count: 0},
    ]);
  });
});
