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
});
