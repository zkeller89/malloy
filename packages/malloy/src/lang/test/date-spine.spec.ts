/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import {errorMessage, model} from './test-translator';
import './parse-expects';
import type {DateSpineSourceDef} from '../../model';

const EXP = '##! experimental.date_spine\n';

describe('date_spine source definitions', () => {
  test('requires the experiment', () => {
    expect('source: s is date_spine(a)').toLog(
      errorMessage(
        'Experimental flag `date_spine` is not set, feature not available'
      )
    );
  });

  test('a bare date_spine has only the spine date', () => {
    const m = model`${EXP}source: s is date_spine(a, ab)`;
    expect(m).toTranslate();
    const s = m.translator.getSourceDef('s') as DateSpineSourceDef;
    expect(s.type).toBe('date_spine');
    expect(s.members.map(x => x.name)).toEqual(['a', 'ab']);
    expect(s.fields.map(f => f.name)).toEqual(['dspine']);
  });

  test('from blocks add shared dimensions and tethered measures', () => {
    const m = model`${EXP}
      source: s is date_spine(a, ab) extend {
        from a {
          dimension: kind is astr
          measure:
            made is count() at ad
            touched is count() at ats default 0
        }
        from ab {
          dimension: kind is astr
          measure: total is ai.sum() at ad
        }
        measure: net is made - touched
      }
    `;
    expect(m).toTranslate();
    const s = m.translator.getSourceDef('s') as DateSpineSourceDef;
    expect(s.fields.map(f => f.name)).toEqual([
      'dspine',
      'kind',
      'made',
      'touched',
      'total',
      'net',
    ]);
    expect(s.sharedDims).toEqual([{name: 'kind', mappedIn: [0, 1]}]);
    expect(s.tethers.map(t => [t.name, t.member, t.atType])).toEqual([
      ['made', 0, 'date'],
      ['touched', 0, 'timestamp'],
      ['total', 1, 'date'],
    ]);
    expect(s.tethers[1].default).toEqual({
      node: 'numberLiteral',
      literal: '0',
    });
    expect(s.members[0].def.fields.map(f => f.name)).toContain('__ds_t_made');
  });

  test('a member measure can be tethered under its own name', () => {
    expect(`${EXP}
      source: am is a extend { measure: c is count() }
      source: s is date_spine(am) extend {
        from am { measure: c is c at ad }
      }
    `).toTranslate();
  });

  test('bare dimension maps the member field of that name', () => {
    const m = model`${EXP}
      source: s is date_spine(a) extend {
        from a { dimension: astr  measure: c is count() at ad }
      }
    `;
    expect(m).toTranslate();
    const s = m.translator.getSourceDef('s') as DateSpineSourceDef;
    expect(s.fields.find(f => f.name === 'astr')?.type).toBe('string');
  });

  test('at and default remain legal column names', () => {
    expect(`
      source: x is a extend {
        dimension: at is astr, default is ai
        measure: c is count()
      }
      run: x -> { group_by: at, default }
    `).toTranslate();
  });

  test('tether must name a member', () => {
    expect(`${EXP}
      source: s is date_spine(a) extend {
        from b { measure: c is count() at ad }
      }
    `).toLog(errorMessage("'b' is not a member of this date_spine"));
  });

  test('tether needs at', () => {
    expect(`${EXP}
      source: s is date_spine(a) extend {
        from a { measure: c is count() }
      }
    `).toLog(
      errorMessage(
        "Tethered measure 'c' needs a date to tether to, e.g. `c is count() at created_at`"
      )
    );
  });

  test('at must be temporal', () => {
    expect(`${EXP}
      source: s is date_spine(a) extend {
        from a { measure: c is count() at astr }
      }
    `).toLog(
      errorMessage(
        "'c' must be tethered to a date or timestamp dimension, not string"
      )
    );
  });

  test('default must be constant and match type', () => {
    expect(`${EXP}
      source: s is date_spine(a) extend {
        from a { measure: c is count() at ad default 'none' }
      }
    `).toLog(
      errorMessage("The default for 'c' is string, but the measure is number")
    );
  });

  test('shared dimension types must agree', () => {
    expect(`${EXP}
      source: s is date_spine(a, ab) extend {
        from a { dimension: k is astr }
        from ab { dimension: k is ai }
      }
    `).toLog(
      errorMessage(
        "Shared dimension 'k' is number in 'ab' but string elsewhere"
      )
    );
  });

  test('duplicate tether names', () => {
    expect(`${EXP}
      source: s is date_spine(a, ab) extend {
        from a { measure: c is count() at ad }
        from ab { measure: c is count() at ad }
      }
    `).toLog(errorMessage("'c' is already defined in this date_spine"));
  });

  test('untethered aggregate on the spine', () => {
    expect(`${EXP}
      source: s is date_spine(a) extend {
        measure: n is count()
      }
    `).toLog(
      errorMessage(
        "'n' aggregates directly on the date_spine; define it in a `from` block with `at`, or combine tethered measures"
      )
    );
  });

  test('from outside a date_spine', () => {
    expect(`${EXP}
      source: s is a extend {
        from a { measure: c is count() at ad }
      }
    `).toLog(
      errorMessage("'from' can only be used when extending a date_spine")
    );
  });

  test('spine_range', () => {
    const m = model`${EXP}
      source: s is date_spine(a) extend {
        spine_range: @2020-01-01 to @2020-12-31
      }
    `;
    expect(m).toTranslate();
    const s = m.translator.getSourceDef('s') as DateSpineSourceDef;
    expect(s.spineRange).toEqual({from: '2020-01-01', to: '2020-12-31'});
  });
});

describe('date_spine queries', () => {
  const src = `${EXP}
    source: s is date_spine(a, ab) extend {
      from a {
        dimension: kind is astr
        measure: made is count() at ad
      }
      from ab {
        measure: total is ai.sum() at ats
      }
      dimension: is_x is kind = 'x'
    }
  `;

  test('a grouped query translates', () => {
    expect(`${src}
      run: s -> {
        where: kind = 'y'
        group_by: dspine.month, is_x
        aggregate: made
      }
    `).toTranslate();
  });

  test('nest is not supported', () => {
    expect(`${src}
      run: s -> {
        group_by: dspine.month
        nest: x is { group_by: kind; aggregate: made }
      }
    `).toLog(errorMessage('nest: is not supported in a query on a date_spine'));
  });

  test('aggregates must use tethered measures', () => {
    expect(`${src}
      run: s -> { group_by: dspine.month; aggregate: n is count() }
    `).toLog(
      errorMessage(
        'Aggregates on a date_spine must use tethered measures; define new measures in a `from` block with `at`'
      )
    );
  });

  test('a query needs a tethered measure', () => {
    expect(`${src}
      run: s -> { group_by: dspine.month }
    `).toLog(
      errorMessage(
        'A query on a date_spine needs at least one tethered measure'
      )
    );
  });

  test('unmapped shared dimension', () => {
    expect(`${src}
      run: s -> { group_by: kind; aggregate: total }
    `).toLog(
      errorMessage(
        "Shared dimension 'kind' is not mapped in 'ab', which 'total' comes from"
      )
    );
  });

  test('extractions of dspine are not supported', () => {
    expect(`${src}
      run: s -> { group_by: m is month(dspine); aggregate: made }
    `).toLog(
      errorMessage(
        'dspine can only be grouped by itself or a truncation such as dspine.month'
      )
    );
  });

  test('weeks do not mix with months', () => {
    expect(`${src}
      run: s -> { group_by: dspine.week, m is dspine.month; aggregate: made }
    `).toLog(
      errorMessage('dspine.week cannot be mixed with month, quarter or year')
    );
  });

  test('select is not supported', () => {
    expect(`${src}
      run: s -> { select: dspine }
    `).toLog(
      errorMessage(
        'Queries on a date_spine must group_by and aggregate; select: and index: are not supported'
      )
    );
  });

  test('filtered tethers are not supported yet', () => {
    expect(`${src}
      run: s -> { aggregate: m is made { where: kind = 'x' } }
    `).toLog(
      errorMessage('Filtered measures are not supported on a date_spine yet')
    );
  });
});
