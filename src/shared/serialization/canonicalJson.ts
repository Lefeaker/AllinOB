import { isObjectRecord, type RuntimePropertyValue } from '../guards/object';

export function canonicalJsonStringify(value: RuntimePropertyValue): string {
  return serializeCanonicalJson(value, new WeakSet<object>());
}

function serializeCanonicalJson(value: RuntimePropertyValue, active: WeakSet<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_JSON_INVALID');
    return JSON.stringify(value);
  }
  if (isRuntimePropertyArray(value)) {
    enter(value, active);
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
    if (
      ownKeys.some((key) => typeof key === 'symbol') ||
      ownKeys.filter((key) => key !== 'length').some((key, index) => key !== expectedKeys[index]) ||
      ownKeys.length !== expectedKeys.length + 1
    ) {
      throw invalid();
    }
    const serialized = `[${value.map((entry) => serializeCanonicalJson(entry, active)).join(',')}]`;
    active.delete(value);
    return serialized;
  }
  if (!isObjectRecord(value)) throw invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw invalid();
  }
  enter(value, active);
  const record = value;
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.some((key) => typeof key === 'symbol') ||
    ownKeys.some((key) => !Object.getOwnPropertyDescriptor(record, key)?.enumerable)
  ) {
    throw invalid();
  }
  const serialized = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(record[key], active)}`)
    .join(',')}}`;
  active.delete(value);
  return serialized;
}

function enter(value: object, active: WeakSet<object>): void {
  if (active.has(value)) throw invalid();
  active.add(value);
}

function invalid(): Error {
  return new Error('CANONICAL_JSON_INVALID');
}

function isRuntimePropertyArray(value: RuntimePropertyValue): value is RuntimePropertyValue[] {
  return Array.isArray(value);
}
