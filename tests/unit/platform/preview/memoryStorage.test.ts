import { describe, expect, it } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';

describe('preview memory storage', () => {
  it('returns a detached typed snapshot of every entry', async () => {
    const area = createMemoryStorageArea();
    await area.set('one', { value: 1 });
    await area.set('two', 'second');

    const snapshot = await area.getAll();

    expect(snapshot).toEqual({ one: { value: 1 }, two: 'second' });
    delete snapshot.one;
    await expect(area.get('one')).resolves.toEqual({ value: 1 });
  });
});
