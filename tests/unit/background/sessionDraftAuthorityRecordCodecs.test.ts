/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import {
  normalizeRestoreStorageLease,
  RESTORE_STORAGE_LEASE_TTL_MS
} from '../../../src/background/services/restoreStorageLeaseStore';
import {
  normalizeSessionDraftOutcome,
  normalizeSessionDraftSaveJournal,
  SESSION_DRAFT_JOURNAL_TTL_MS,
  SESSION_DRAFT_OUTCOME_TTL_MS
} from '../../../src/background/services/sessionDraftSaveJournal';
import { getSessionDraftProtocolQuarantineCollisionStatus } from '../../../src/background/services/sessionDraftProtocolCorruption';
import {
  normalizeSessionDraftRetiredOperation,
  SESSION_DRAFT_RETIRED_OPERATION_TTL_MS
} from '../../../src/background/services/sessionDraftRetiredOperationStore';
import { normalizeSessionDraftDeletionKeys } from '../../../src/background/services/sessionDraftDeletionRecordCodecs';

const NOW = 2_000_000_000_000;
const FINGERPRINT = 'a'.repeat(64);
const SCREENSHOT_KEY = 'aiob.videoScreenshotCache.v1.page.capture.screenshot';
const CORRUPTION_KEY = 'aiob.restoreStorage.corruption.v1';

function validLease() {
  return {
    schemaVersion: 1,
    operationId: 'lease-operation',
    epoch: 7,
    draftKey: 'aiob.sessionDraft.v1.video.page.draft',
    baseRevision: 2,
    draftRevision: 3,
    screenshotKeys: [SCREENSHOT_KEY],
    screenshotFingerprints: { [SCREENSHOT_KEY]: FINGERPRINT },
    createdAt: NOW,
    expiresAt: NOW + RESTORE_STORAGE_LEASE_TTL_MS
  };
}

function validOutcome() {
  return {
    schemaVersion: 1,
    kind: 'save',
    operationId: 'save-operation',
    draftKey: 'aiob.sessionDraft.v1.reader.page.draft',
    revision: 3,
    requestFingerprint: FINGERPRINT,
    createdAt: NOW,
    expiresAt: NOW + SESSION_DRAFT_OUTCOME_TTL_MS
  };
}

function validContext() {
  return {
    operationId: 'save-operation',
    epoch: 7,
    draftKey: 'aiob.sessionDraft.v1.reader.page.draft',
    baseRevision: 2,
    nextRevision: 3
  };
}

function validJournal() {
  return {
    schemaVersion: 1,
    state: 'pending',
    operationId: 'save-operation',
    context: validContext(),
    requestFingerprint: FINGERPRINT,
    desiredEnvelopeFingerprint: 'b'.repeat(64),
    previousEnvelopeFingerprint: null,
    createdAt: NOW,
    expiresAt: NOW + SESSION_DRAFT_JOURNAL_TTL_MS
  };
}

function validRetiredOperation() {
  return {
    schemaVersion: 1,
    operationId: 'retired-operation',
    retiredAt: NOW,
    expiresAt: NOW + SESSION_DRAFT_RETIRED_OPERATION_TTL_MS
  };
}

function statefulAccessor<Value extends object>(
  record: Value,
  key: string,
  values: readonly unknown[]
): Value {
  let reads = 0;
  Reflect.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    get() {
      const value = values[Math.min(reads, values.length - 1)];
      reads += 1;
      return value;
    }
  });
  return record;
}

function corruptionLedger(sourceKey: string) {
  return {
    schemaVersion: 1,
    recoveryRequiredUntil: null,
    entries: [{ sourceKey, quarantinedAt: NOW }]
  };
}

async function collisionStatus(value: object, sourceKey: string) {
  const local = createMemoryStorageArea();
  await local.set(CORRUPTION_KEY, value);
  return getSessionDraftProtocolQuarantineCollisionStatus(
    local,
    { exactSourceKeys: [sourceKey], numericSourcePrefix: 'unused.' },
    NOW
  );
}

describe('session draft authority record codecs', () => {
  it('preserves the current and legacy lease contracts', () => {
    const current = validLease();
    const { screenshotKeys, screenshotFingerprints: ignoredFingerprints, ...base } = current;
    void ignoredFingerprints;
    const legacy = { ...base, screenshotKey: screenshotKeys[0] };

    expect(normalizeRestoreStorageLease(current)).toEqual(current);
    expect(normalizeRestoreStorageLease(legacy)).toEqual({
      ...base,
      screenshotKeys,
      screenshotFingerprints: {}
    });
  });

  it('preserves the current and legacy save outcome contracts', () => {
    const current = validOutcome();
    const { kind: ignored, ...legacy } = current;
    void ignored;

    expect(normalizeSessionDraftOutcome(current)).toEqual(current);
    expect(normalizeSessionDraftOutcome(legacy)).toEqual(current);
    expect(normalizeSessionDraftSaveJournal(validJournal())).toEqual(validJournal());
  });

  it('rejects array-shaped lease authority records', () => {
    expect(normalizeRestoreStorageLease(Object.assign([], validLease()))).toBeNull();
  });

  it('rejects stateful accessors in lease authority records', () => {
    const lease = statefulAccessor(validLease(), 'operationId', [
      'lease-operation',
      'changed-operation'
    ]);
    expect(normalizeRestoreStorageLease(lease)).toBeNull();
  });

  it('rejects array and accessor-backed screenshot fingerprint records', () => {
    const arrayFingerprints = validLease();
    arrayFingerprints.screenshotFingerprints = Object.assign([], {
      [SCREENSHOT_KEY]: FINGERPRINT
    });
    const accessorFingerprints = validLease();
    accessorFingerprints.screenshotFingerprints = statefulAccessor(
      { [SCREENSHOT_KEY]: FINGERPRINT },
      SCREENSHOT_KEY,
      [FINGERPRINT, 'b'.repeat(64)]
    );

    expect(normalizeRestoreStorageLease(arrayFingerprints)).toBeNull();
    expect(normalizeRestoreStorageLease(accessorFingerprints)).toBeNull();
  });

  it('rejects accessor-backed screenshot-key arrays', () => {
    const lease = validLease();
    lease.screenshotKeys = [SCREENSHOT_KEY];
    statefulAccessor(lease.screenshotKeys, '0', [SCREENSHOT_KEY, 'changed-screenshot-key']);
    expect(normalizeRestoreStorageLease(lease)).toBeNull();
  });

  it('rejects array-shaped save outcomes', () => {
    expect(normalizeSessionDraftOutcome(Object.assign([], validOutcome()))).toBeNull();
  });

  it('rejects stateful accessors in save outcomes', () => {
    const outcome = statefulAccessor(validOutcome(), 'operationId', [
      'save-operation',
      'changed-operation'
    ]);
    expect(normalizeSessionDraftOutcome(outcome)).toBeNull();
  });

  it('rejects hidden and symbol authority fields', () => {
    const hidden = validOutcome();
    Reflect.defineProperty(hidden, 'hiddenAuthority', {
      configurable: true,
      enumerable: false,
      value: true
    });
    const symbol = validOutcome();
    Reflect.defineProperty(symbol, Symbol('hidden-authority'), {
      configurable: true,
      enumerable: true,
      value: true
    });

    expect(normalizeSessionDraftOutcome(hidden)).toBeNull();
    expect(normalizeSessionDraftOutcome(symbol)).toBeNull();
  });

  it('rejects array-shaped nested WAL contexts', () => {
    const journal = validJournal();
    journal.context = Object.assign([], validContext());
    expect(normalizeSessionDraftSaveJournal(journal)).toBeNull();
  });

  it('rejects stateful accessors in nested WAL contexts', () => {
    const journal = validJournal();
    journal.context = statefulAccessor(validContext(), 'operationId', [
      'save-operation',
      'changed-operation'
    ]);
    expect(normalizeSessionDraftSaveJournal(journal)).toBeNull();
  });

  it('rejects array-shaped corruption ledgers', async () => {
    const sourceKey = 'aiob.restoreStorage.pending.v1.array-ledger';
    await expect(
      collisionStatus(Object.assign([], corruptionLedger(sourceKey)), sourceKey)
    ).resolves.toBe('none');
  });

  it('rejects stateful accessors in corruption entries', async () => {
    const sourceKey = 'aiob.restoreStorage.pending.v1.accessor-entry';
    const ledger = corruptionLedger(sourceKey);
    ledger.entries[0] = statefulAccessor(ledger.entries[0], 'sourceKey', [
      sourceKey,
      sourceKey,
      sourceKey,
      'changed-source-key'
    ]);
    await expect(collisionStatus(ledger, sourceKey)).resolves.toBe('none');
  });

  it('rejects accessor-backed corruption entry arrays', async () => {
    const sourceKey = 'aiob.restoreStorage.pending.v1.accessor-entry-array';
    const ledger = corruptionLedger(sourceKey);
    statefulAccessor(ledger.entries, '0', [ledger.entries[0]]);
    await expect(collisionStatus(ledger, sourceKey)).resolves.toBe('none');
  });

  it('rejects array-shaped retired-operation authority records', () => {
    expect(
      normalizeSessionDraftRetiredOperation(Object.assign([], validRetiredOperation()))
    ).toBeNull();
  });

  it('rejects stateful accessors in retired-operation authority records', () => {
    const retired = statefulAccessor(validRetiredOperation(), 'operationId', [
      'retired-operation',
      'changed-operation'
    ]);
    expect(normalizeSessionDraftRetiredOperation(retired)).toBeNull();
  });

  it('rejects authority records with custom prototypes', () => {
    const retired: object = validRetiredOperation();
    Reflect.setPrototypeOf(retired, { inheritedAuthority: true });
    expect(normalizeSessionDraftRetiredOperation(retired)).toBeNull();
  });

  it('rejects accessor-backed and custom-prototype deletion arrays', () => {
    const draftKey = 'aiob.sessionDraft.v1.reader.page.draft';
    const accessorArray = statefulAccessor([draftKey], '0', [draftKey, 'changed-key']);
    const customPrototypeArray = [draftKey];
    Reflect.setPrototypeOf(customPrototypeArray, null);

    expect(normalizeSessionDraftDeletionKeys(accessorArray)).toBeNull();
    expect(normalizeSessionDraftDeletionKeys(customPrototypeArray)).toBeNull();
  });
});
