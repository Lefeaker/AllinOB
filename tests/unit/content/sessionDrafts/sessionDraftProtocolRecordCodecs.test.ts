import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSessionDraftRepositoryMessage } from '@content/sessionDrafts/sessionDraftRepositoryMessages';
import { normalizeSessionDraftRepositoryResponse } from '@content/sessionDrafts/sessionDraftRepositoryResponses';
import {
  configureSessionDraftRuntimeMessenger,
  getCurrentSessionDraftOwnerContext,
  isSessionDraftOwnerContextActive,
  normalizeSessionDraftOwnerContext
} from '@content/sessionDrafts/sessionDraftTabContext';
import type { RuntimePropertyValue } from '@shared/guards/object';

const DRAFT_KEY = 'aiob.sessionDraft.v1.video.page.draft';
const CONTEXT = {
  operationId: 'operation-1',
  epoch: 1,
  draftKey: DRAFT_KEY,
  baseRevision: 0,
  nextRevision: 1
};

function prepareMessage() {
  return {
    type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
    operation: 'prepareSessionDraftOperation',
    operationId: 'operation-1',
    draftKey: DRAFT_KEY
  };
}

function saveResponse() {
  return {
    success: true,
    operation: 'saveSessionDraft',
    revision: 1,
    replayed: false
  };
}

function validEnvelope() {
  return {
    schemaVersion: 1,
    draftId: 'draft',
    mode: 'video',
    pageKey: 'page',
    pageUrl: 'https://video.example/watch?v=1',
    pageTitle: 'Video',
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    status: 'restorable',
    payload: {}
  };
}

function arrayBackedRecord(value: object): object {
  return Object.assign([], value);
}

function inheritedRecord(value: object): object {
  return Object.assign(Object.create({ inherited: true }), value);
}

function withUnexpectedSymbol(value: object): object {
  const candidate = { ...value };
  Object.defineProperty(candidate, Symbol('unexpected'), {
    enumerable: true,
    value: true
  });
  return candidate;
}

function withUnexpectedNonEnumerable(value: object): object {
  const candidate = { ...value };
  Object.defineProperty(candidate, 'hidden', {
    enumerable: false,
    value: true
  });
  return candidate;
}

function defineStatefulGetter(
  value: object,
  key: string,
  first: RuntimePropertyValue,
  later: RuntimePropertyValue
): { candidate: object; readCount: () => number } {
  const candidate = { ...value };
  let reads = 0;
  Object.defineProperty(candidate, key, {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? first : later;
    }
  });
  return { candidate, readCount: () => reads };
}

afterEach(() => {
  configureSessionDraftRuntimeMessenger(null);
});

describe('session draft protocol record codecs', () => {
  it('rejects array-backed top-level messages, responses, and owner contexts', () => {
    expect(normalizeSessionDraftRepositoryMessage(arrayBackedRecord(prepareMessage()))).toBeNull();
    expect(
      normalizeSessionDraftRepositoryResponse(arrayBackedRecord(saveResponse()), 'saveSessionDraft')
    ).toBeNull();
    expect(normalizeSessionDraftOwnerContext(arrayBackedRecord({ tabId: 7 }))).toBeNull();
  });

  it('rejects inherited, symbol-keyed, and non-enumerable top-level records', () => {
    expect(normalizeSessionDraftRepositoryMessage(inheritedRecord(prepareMessage()))).toBeNull();
    expect(
      normalizeSessionDraftRepositoryResponse(
        withUnexpectedSymbol(saveResponse()),
        'saveSessionDraft'
      )
    ).toBeNull();
    expect(normalizeSessionDraftOwnerContext(withUnexpectedNonEnumerable({ tabId: 7 }))).toBeNull();
  });

  it('rejects stateful accessors instead of validating one value and returning another', () => {
    const message = defineStatefulGetter(
      prepareMessage(),
      'operation',
      'prepareSessionDraftOperation',
      'saveSessionDraft'
    );
    const response = defineStatefulGetter(saveResponse(), 'revision', 1, -1);
    const ownerContext = defineStatefulGetter({ tabId: 7 }, 'tabId', 7, -1);

    expect(normalizeSessionDraftRepositoryMessage(message.candidate)).toBeNull();
    expect(
      normalizeSessionDraftRepositoryResponse(response.candidate, 'saveSessionDraft')
    ).toBeNull();
    expect(normalizeSessionDraftOwnerContext(ownerContext.candidate)).toBeNull();
    expect(message.readCount()).toBe(0);
    expect(response.readCount()).toBe(0);
    expect(ownerContext.readCount()).toBe(0);
  });

  it('rejects unstable nested operation contexts, owner options, and removal targets', () => {
    const context = defineStatefulGetter(CONTEXT, 'operationId', 'operation-1', '');
    const ownerContext = defineStatefulGetter({ tabId: 7 }, 'tabId', 7, -1);
    const target = defineStatefulGetter({ key: DRAFT_KEY }, 'key', DRAFT_KEY, DRAFT_KEY);

    expect(
      normalizeSessionDraftRepositoryMessage({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'cancelSessionDraftOperation',
        context: context.candidate
      })
    ).toBeNull();
    expect(
      normalizeSessionDraftRepositoryMessage({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'loadLatestSessionDraft',
        mode: 'video',
        pageUrl: 'https://video.example/watch?v=1',
        options: { ownerContext: ownerContext.candidate }
      })
    ).toBeNull();
    expect(
      normalizeSessionDraftRepositoryMessage({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'removeSessionDraft',
        operationId: 'operation-remove',
        target: target.candidate
      })
    ).toBeNull();
  });

  it('rejects unstable deletion snapshots and candidate records', () => {
    const deletion = defineStatefulGetter(
      {
        epoch: 1,
        revisions: [{ draftKey: DRAFT_KEY, revision: 1 }],
        protectedKeys: [],
        replayed: false
      },
      'epoch',
      1,
      -1
    );
    const candidate = arrayBackedRecord({
      envelope: {
        schemaVersion: 1,
        draftId: 'draft',
        mode: 'video',
        pageKey: 'page',
        pageUrl: 'https://video.example/watch?v=1',
        pageTitle: 'Video',
        createdAt: 1,
        updatedAt: 2,
        expiresAt: 3,
        status: 'restorable',
        payload: {}
      },
      revision: 1
    });

    expect(
      normalizeSessionDraftRepositoryResponse(
        {
          success: true,
          operation: 'removeSessionDraft',
          result: deletion.candidate
        },
        'removeSessionDraft'
      )
    ).toBeNull();
    expect(
      normalizeSessionDraftRepositoryResponse(
        {
          success: true,
          operation: 'listSessionDraftCandidates',
          result: { candidates: [candidate], epoch: 1 }
        },
        'listSessionDraftCandidates'
      )
    ).toBeNull();
  });

  it('rejects accessor-backed envelopes instead of returning post-validation values', () => {
    const requestEnvelope = defineStatefulGetter(validEnvelope(), 'updatedAt', 2, 99);
    const responseEnvelope = defineStatefulGetter(validEnvelope(), 'updatedAt', 2, 99);

    expect(
      normalizeSessionDraftRepositoryMessage({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'saveSessionDraft',
        context: CONTEXT,
        envelope: requestEnvelope.candidate
      })
    ).toBeNull();
    expect(
      normalizeSessionDraftRepositoryResponse(
        {
          success: true,
          operation: 'loadLatestSessionDraft',
          result: { envelope: responseEnvelope.candidate, epoch: 1, revision: 1 }
        },
        'loadLatestSessionDraft'
      )
    ).toBeNull();
    expect(requestEnvelope.readCount()).toBe(0);
    expect(responseEnvelope.readCount()).toBe(0);
  });

  it('rejects accessor-backed protocol arrays without reading their elements', () => {
    const protectedKeys = defineStatefulGetter([DRAFT_KEY], '0', DRAFT_KEY, 'changed');
    const candidates = defineStatefulGetter(
      [{ envelope: validEnvelope(), revision: 1 }],
      '0',
      { envelope: validEnvelope(), revision: 1 },
      { envelope: validEnvelope(), revision: -1 }
    );

    expect(
      normalizeSessionDraftRepositoryResponse(
        {
          success: true,
          operation: 'removeSessionDraft',
          result: {
            epoch: 1,
            revisions: [],
            protectedKeys: protectedKeys.candidate,
            replayed: false
          }
        },
        'removeSessionDraft'
      )
    ).toBeNull();
    expect(
      normalizeSessionDraftRepositoryResponse(
        {
          success: true,
          operation: 'listSessionDraftCandidates',
          result: { candidates: candidates.candidate, epoch: 1 }
        },
        'listSessionDraftCandidates'
      )
    ).toBeNull();
    expect(protectedKeys.readCount()).toBe(0);
    expect(candidates.readCount()).toBe(0);
  });

  it('deep-snapshots video capture payloads instead of retaining raw mutable references', () => {
    const captures = [{ id: 'capture-1', screenshotRef: { key: 'screenshot-1' } }];
    const normalized = normalizeSessionDraftRepositoryMessage({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'saveSessionDraft',
      context: CONTEXT,
      envelope: { ...validEnvelope(), payload: { captures } }
    });
    if (!normalized || normalized.operation !== 'saveSessionDraft') {
      throw new Error('expected normalized save message');
    }

    captures.push({ id: 'capture-2', screenshotRef: { key: 'screenshot-2' } });

    expect(normalized.envelope.payload.captures).toEqual([
      { id: 'capture-1', screenshotRef: { key: 'screenshot-1' } }
    ]);
  });

  it('rejects nested accessors, sparse arrays, and custom-prototype arrays in payloads', () => {
    const nestedAccessor = defineStatefulGetter({ id: 'capture-1' }, 'id', 'capture-1', 'changed');
    const sparseCaptures = Array(1);
    const customPrototypeCaptures = [{ id: 'capture-1' }];
    Reflect.setPrototypeOf(customPrototypeCaptures, null);

    for (const captures of [[nestedAccessor.candidate], sparseCaptures, customPrototypeCaptures]) {
      expect(
        normalizeSessionDraftRepositoryMessage({
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'saveSessionDraft',
          context: CONTEXT,
          envelope: { ...validEnvelope(), payload: { captures } }
        })
      ).toBeNull();
    }
    expect(nestedAccessor.readCount()).toBe(0);
  });

  it('preserves nested __proto__ data without mutating the snapshot prototype', () => {
    const capture = { id: 'capture-1' };
    Reflect.defineProperty(capture, '__proto__', {
      enumerable: true,
      value: { polluted: true }
    });
    const normalized = normalizeSessionDraftRepositoryMessage({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'saveSessionDraft',
      context: CONTEXT,
      envelope: { ...validEnvelope(), payload: { captures: [capture] } }
    });
    if (!normalized || normalized.operation !== 'saveSessionDraft') {
      throw new Error('expected normalized save message');
    }
    const captures = normalized.envelope.payload.captures;
    if (!Array.isArray(captures)) throw new Error('expected normalized captures');
    const normalizedCapture: unknown = captures[0];
    if (typeof normalizedCapture !== 'object' || normalizedCapture === null) {
      throw new Error('expected normalized capture');
    }

    expect(Object.prototype.hasOwnProperty.call(normalizedCapture, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(normalizedCapture)).toBe(Object.prototype);
  });

  it('fails closed for excessive nesting and throwing proxy traps', () => {
    const deep: { child?: object } = {};
    let cursor = deep;
    for (let index = 0; index < 70; index += 1) {
      const child: { child?: object } = {};
      cursor.child = child;
      cursor = child;
    }
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('proxy trap');
        }
      }
    );

    for (const extension of [deep, throwing]) {
      expect(
        normalizeSessionDraftRepositoryMessage({
          type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
          operation: 'saveSessionDraft',
          context: CONTEXT,
          envelope: { ...validEnvelope(), payload: { extension } }
        })
      ).toBeNull();
    }
  });

  it('accepts wide JSON payloads that remain below the envelope byte budget', () => {
    expect(
      normalizeSessionDraftRepositoryMessage({
        type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
        operation: 'saveSessionDraft',
        context: CONTEXT,
        envelope: {
          ...validEnvelope(),
          payload: { extension: Array.from({ length: 10_001 }, () => 0) }
        }
      })
    ).toMatchObject({ operation: 'saveSessionDraft' });
  });

  it('preserves optional fields, both removal target forms, and valid owner subsets', () => {
    const withoutExpectedVersion = normalizeSessionDraftRepositoryMessage(prepareMessage());
    const withExpectedVersion = normalizeSessionDraftRepositoryMessage({
      ...prepareMessage(),
      expectedEpoch: 2,
      expectedRevision: 3
    });
    const legacyRemoval = normalizeSessionDraftRepositoryMessage({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'removeSessionDraft',
      operationId: 'remove-legacy',
      target: DRAFT_KEY
    });
    const currentRemoval = normalizeSessionDraftRepositoryMessage({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'removeSessionDraft',
      operationId: 'remove-current',
      target: { key: DRAFT_KEY }
    });

    expect(withoutExpectedVersion).toMatchObject({ operation: 'prepareSessionDraftOperation' });
    expect(withExpectedVersion).toMatchObject({ expectedEpoch: 2, expectedRevision: 3 });
    expect(legacyRemoval).toMatchObject({ operation: 'removeSessionDraft' });
    expect(currentRemoval).toMatchObject({ target: { key: DRAFT_KEY } });
    expect(normalizeSessionDraftOwnerContext({ tabId: 7 })).toEqual({ tabId: 7 });
    expect(normalizeSessionDraftOwnerContext({ windowId: 3, frameId: 0 })).toEqual({
      windowId: 3,
      frameId: 0
    });
    expect(normalizeSessionDraftOwnerContext({})).toBeNull();
  });

  it('rejects unstable runtime owner-context responses without invoking accessors', async () => {
    const ownerResponse = defineStatefulGetter(
      { success: true, windowId: 3, frameId: 0 },
      'tabId',
      7,
      -1
    );
    configureSessionDraftRuntimeMessenger(vi.fn().mockResolvedValue(ownerResponse.candidate));
    await expect(getCurrentSessionDraftOwnerContext()).resolves.toBeNull();
    expect(ownerResponse.readCount()).toBe(0);

    const activeResponse = defineStatefulGetter({ success: true }, 'active', true, false);
    configureSessionDraftRuntimeMessenger(vi.fn().mockResolvedValue(activeResponse.candidate));
    await expect(isSessionDraftOwnerContextActive({ tabId: 7 })).resolves.toBe(false);
    expect(activeResponse.readCount()).toBe(0);
  });
});
