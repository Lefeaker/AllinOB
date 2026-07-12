/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from '@shared/serialization/canonicalJson';

describe('canonicalJsonStringify', () => {
  it('rejects sparse arrays instead of emitting invalid JSON', () => {
    expect(() => canonicalJsonStringify(Array(2))).toThrow('CANONICAL_JSON_INVALID');
  });

  it('rejects symbol-keyed object data instead of silently omitting it', () => {
    const value = { visible: true, [Symbol('hidden')]: 'secret' };
    expect(() => canonicalJsonStringify(value)).toThrow('CANONICAL_JSON_INVALID');
  });

  it('rejects array extra properties instead of silently omitting them', () => {
    const value: number[] & { extra?: string } = [1, 2];
    value.extra = 'hidden';
    expect(() => canonicalJsonStringify(value)).toThrow('CANONICAL_JSON_INVALID');
  });

  it('rejects circular graphs with the fixed low-cardinality error', () => {
    const value: { self?: object } = {};
    value.self = value;
    expect(() => canonicalJsonStringify(value)).toThrowError(new Error('CANONICAL_JSON_INVALID'));
  });
});
