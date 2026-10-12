/*
 * Copyright Contributors to the Malloy project
 * SPDX-License-Identifier: MIT
 */

import {DateSpineSource} from '../source-elements/date-spine-source';
import type {Source} from '../source-elements/source';
import {SourceQueryElement} from './source-query-element';
import {SQReference} from './sq-reference';

/**
 * e.g. `date_spine(employees, requisitions)`
 */
export class SQDateSpine extends SourceQueryElement {
  elementType = 'sq-date-spine';
  asSource?: DateSpineSource;

  constructor(readonly members: SourceQueryElement[]) {
    super({members});
  }

  getSource() {
    if (this.asSource) {
      return this.asSource;
    }
    const members: {name: string; source: Source}[] = [];
    for (const m of this.members) {
      if (!(m instanceof SQReference)) {
        m.sqLog(
          'date-spine-invalid-member',
          'date_spine members must be named sources'
        );
        return undefined;
      }
      const source = m.getSource();
      if (source === undefined) {
        return undefined;
      }
      members.push({name: m.ref.refString, source});
    }
    this.asSource = new DateSpineSource(members);
    this.has({asSource: this.asSource});
    return this.asSource;
  }

  isSource() {
    return true;
  }
}
