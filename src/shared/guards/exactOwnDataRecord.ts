import { isObjectRecord, type ObjectRecord, type RuntimePropertyValue } from './object';

interface RuntimeDataPropertyDescriptor extends PropertyDescriptor {
  value: RuntimePropertyValue;
}

export type JsonDataValue =
  | string
  | number
  | boolean
  | null
  | JsonDataValue[]
  | { [key: string]: JsonDataValue };

const JSON_DATA_MAX_DEPTH = 64;
// A 1 MiB JSON array can contain just over 500k one-byte scalar values plus separators.
const JSON_DATA_MAX_NODES = 600_000;

export function readOwnJsonDataValue(value: unknown): JsonDataValue | undefined {
  try {
    return snapshotJsonDataValue(value, new WeakSet<object>(), 0, { nodes: 0 });
  } catch {
    return undefined;
  }
}

export function readOwnDataArray<Value>(value: Value): RuntimePropertyValue[] | null {
  if (!Array.isArray(value) || Reflect.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  if (
    !isRuntimeDataDescriptor(lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length = lengthDescriptor.value;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const snapshot: RuntimePropertyValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (!isRuntimeDataDescriptor(descriptor) || !descriptor.enumerable) return null;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

export function readExactOwnDataRecord<Value>(
  value: Value,
  expectedKeys: readonly string[]
): ObjectRecord | null {
  const snapshot = readOwnDataRecord(value);
  if (!snapshot) return null;
  const expected = new Set(expectedKeys);
  const ownKeys = Object.keys(snapshot);
  if (
    expected.size !== expectedKeys.length ||
    ownKeys.length !== expected.size ||
    ownKeys.some((key) => !expected.has(key))
  ) {
    return null;
  }
  return snapshot;
}

export function readOwnDataRecord<Value>(value: Value): ObjectRecord | null {
  if (!isObjectRecord(value) || Array.isArray(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const snapshot: ObjectRecord = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !Reflect.defineProperty(snapshot, key, descriptor)
    ) {
      return null;
    }
  }
  return snapshot;
}

function isRuntimeDataDescriptor(
  value: PropertyDescriptor | undefined
): value is RuntimeDataPropertyDescriptor {
  return Boolean(value && 'value' in value && value.get === undefined && value.set === undefined);
}

function snapshotJsonDataValue(
  value: unknown,
  active: WeakSet<object>,
  depth: number,
  budget: { nodes: number }
): JsonDataValue | undefined {
  budget.nodes += 1;
  if (depth > JSON_DATA_MAX_DEPTH || budget.nodes > JSON_DATA_MAX_NODES) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object') return undefined;
  if (active.has(value)) return undefined;
  active.add(value);
  try {
    const array = readOwnDataArray(value);
    if (array) {
      const snapshot: JsonDataValue[] = [];
      for (const entry of array) {
        const next = snapshotJsonDataValue(entry, active, depth + 1, budget);
        if (next === undefined) return undefined;
        snapshot.push(next);
      }
      return snapshot;
    }
    const record = readOwnDataRecord(value);
    if (!record) return undefined;
    const snapshot: { [key: string]: JsonDataValue } = {};
    for (const [key, entry] of Object.entries(record)) {
      const next = snapshotJsonDataValue(entry, active, depth + 1, budget);
      if (next === undefined) return undefined;
      if (
        !Reflect.defineProperty(snapshot, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: next
        })
      ) {
        return undefined;
      }
    }
    return snapshot;
  } finally {
    active.delete(value);
  }
}
