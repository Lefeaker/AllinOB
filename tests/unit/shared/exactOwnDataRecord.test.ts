import { describe, expect, it } from 'vitest';
import {
  readExactOwnDataRecord,
  readOwnDataRecord
} from '../../../src/shared/guards/exactOwnDataRecord';

describe('exact own data record snapshots', () => {
  it('copies plain and null-prototype data records into stable snapshots', () => {
    const plain = { epoch: 1, state: 'ready' };
    const plainSnapshot = readExactOwnDataRecord(plain, ['epoch', 'state']);
    plain.epoch = 2;
    expect(plainSnapshot).toEqual({ epoch: 1, state: 'ready' });

    const nullPrototype: Record<string, number> = { epoch: 3 };
    Reflect.setPrototypeOf(nullPrototype, null);
    expect(readOwnDataRecord(nullPrototype)).toEqual({ epoch: 3 });
  });

  it('rejects arrays, inherited fields, symbols, hidden fields, and accessors', () => {
    const inherited = {};
    Reflect.setPrototypeOf(inherited, { epoch: 1 });
    const symbol = { epoch: 1 };
    Reflect.defineProperty(symbol, Symbol('extra'), { value: true, enumerable: true });
    const hidden = { epoch: 1 };
    Reflect.defineProperty(hidden, 'extra', { value: true, enumerable: false });
    const accessor = {};
    Reflect.defineProperty(accessor, 'epoch', { get: () => 1, enumerable: true });

    for (const value of [Object.assign([], { epoch: 1 }), inherited, symbol, hidden, accessor]) {
      expect(readExactOwnDataRecord(value, ['epoch'])).toBeNull();
    }
  });
});
