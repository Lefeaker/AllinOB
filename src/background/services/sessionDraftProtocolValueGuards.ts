import type { ObjectRecord, RuntimePropertyValue } from '../../shared/guards/object';
export { readOwnDataArray as readProtocolDataArray } from '../../shared/guards/exactOwnDataRecord';

export function hasOnlyProtocolKeys(
  value: Record<string, RuntimePropertyValue>,
  keys: readonly string[]
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function hasOwnProtocolKey(value: ObjectRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isProtocolFingerprint(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

export function isNonEmptyProtocolString(value: RuntimePropertyValue): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isNonNegativeSafeInteger(value: RuntimePropertyValue): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
