/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../../setup/globalSetup';
import { buildReaderSessionDraftEnvelope } from '@content/reader/sessionDrafts';
import { DEFAULT_SESSION_MESSAGES } from '@content/reader/sessionMessages';
import {
  __resetContentSessionRegistryForTests,
  getReaderSession,
  isReaderSessionActive
} from '@content/runtime/contentSessionRegistry';
import {
  createSessionDraftStorageKey,
  type SessionDraftOwnerContext
} from '@content/sessionDrafts';
import { configureSessionDraftRuntimeMessenger } from '@content/sessionDrafts/sessionDraftTabContext';
import {
  createPersistedHighlightRecord,
  createSelectionPayload,
  createSessionContext,
  expectCanonicalReaderTelemetry,
  flushDraftPersistence,
  getDraftIdentity,
  getSessionHarness,
  getTelemetryMessages,
  isTabContextProbeMessage,
  listReaderDraftCandidates,
  loadLatestReaderDraft,
  readDraftIndex,
  readStoredReaderDraft,
  removalCallIncludesKey,
  settleReaderMutation,
  type TabContextProbeResponse
} from './readerSessionTestHarness';

describe('ReaderSession export', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = '';
    document.documentElement.removeAttribute('data-aiob-reader-active');
    document.body.removeAttribute('data-aiobReaderHighlight');
    document.body.removeAttribute('data-aiobReaderHighlightTheme');
    __resetContentSessionRegistryForTests(document);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('finish exports markdown and cleans up the session', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-export';
    wrapper.textContent = 'Export me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-export',
        selectedHtml: '<mark>Export me</mark>',
        selectedText: 'Export me',
        comment: 'note',
        fragmentUrl: '#export',
        wrapper
      }
    ]);
    context.emitCommentDraftChange({});
    await flushDraftPersistence();

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }

    await callbacks.onFinish();
    expect(context.dispatchClipResult).toHaveBeenCalledTimes(1);
    await flushDraftPersistence();
    expect(context.showSupportProgress).toHaveBeenCalledWith({
      value: 10,
      message: {
        key: 'supportProgressReaderPreparing',
        fallback: 'Preparing reader export'
      }
    });
    expect(context.showSupportProgress).toHaveBeenCalledWith({
      value: 24,
      message: {
        key: 'supportProgressReaderOrganizing',
        fallback: 'Organizing highlights'
      }
    });
    expect(context.showSupportProgress).toHaveBeenCalledWith({
      value: 32,
      message: {
        key: 'supportProgressReaderGenerating',
        fallback: 'Generating reader note'
      }
    });
    expect(context.showSupportProgress).toHaveBeenCalledWith({
      value: 36,
      message: {
        key: 'supportProgressReaderSending',
        fallback: 'Sending to Obsidian'
      }
    });
    expect(context.view.destroy).toHaveBeenCalledTimes(1);
    expect(isReaderSessionActive(document)).toBe(false);
    await expect(
      context.draftRepository.loadLatest('reader', 'https://example.com/article')
    ).resolves.toBeNull();
  });

  it('tracks exported reader sessions with canonical destination and duration bucket only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T00:00:00.000Z'));

    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-export';
    wrapper.textContent = 'Export me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-export',
        selectedHtml: '<mark>Export me</mark>',
        selectedText: 'Export me',
        comment: 'note',
        fragmentUrl: '#export',
        wrapper
      }
    ]);

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }
    if (!callbacks.onSelectDestination) {
      throw new Error('destination callback missing');
    }

    await settleReaderMutation(Promise.resolve(callbacks.onSelectDestination('downloads')));
    vi.setSystemTime(new Date('2026-06-05T00:00:01.500Z'));
    await callbacks.onFinish();

    const exportedEvent = getTelemetryMessages(context).find(
      (message) => message.event === 'reader_exported'
    );
    expect(exportedEvent).toEqual({
      type: 'ANALYTICS_EVENT',
      event: 'reader_exported',
      params: {
        destination: 'downloads',
        duration_bucket: '1s_to_2s',
        highlight_count_bucket: 'one'
      }
    });
    expectCanonicalReaderTelemetry(getTelemetryMessages(context));
  });

  it('cleans up after cancel when exact-key draft removal fails after the terminal envelope is written', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-cancel-terminal';
    wrapper.textContent = 'Cancel me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-cancel-terminal',
        selectedHtml: '<mark>Cancel me</mark>',
        selectedText: 'Cancel me',
        comment: 'pending note',
        fragmentUrl: '#cancel-terminal',
        wrapper
      }
    ]);
    context.emitCommentDraftChange({});
    await flushDraftPersistence();

    const { draftStorageKey: currentDraftKey, draftId: currentDraftId } = getDraftIdentity(
      context.session
    );
    if (!currentDraftKey || !currentDraftId) {
      throw new Error('expected an active current draft');
    }

    const passthroughRemove = context.storageLocal.remove.bind(context.storageLocal);
    vi.spyOn(context.storageLocal, 'remove').mockImplementation(async (value) => {
      if (removalCallIncludesKey(value, currentDraftKey)) {
        throw new Error('remove current exact key after terminal cancel failed');
      }
      return await passthroughRemove(value);
    });

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }

    callbacks.onCancel();
    await vi.waitFor(() => {
      expect(context.view.destroy).toHaveBeenCalledTimes(1);
    });

    expect(isReaderSessionActive(document)).toBe(false);
    await expect(loadLatestReaderDraft(context)).resolves.toBeNull();
    await expect(listReaderDraftCandidates(context)).resolves.toEqual([]);
    expect(await readDraftIndex(context)).toMatchObject({
      entries: [expect.objectContaining({ draftId: currentDraftId, status: 'discarded' })]
    });
    await expect(readStoredReaderDraft(context, currentDraftKey)).resolves.toMatchObject({
      draftId: currentDraftId,
      status: 'discarded'
    });
  });

  it('keeps the session active and suppresses cancel analytics when terminal draft persistence fails', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-cancel-failure';
    wrapper.textContent = 'Cancel me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-cancel-failure',
        selectedHtml: '<mark>Cancel me</mark>',
        selectedText: 'Cancel me',
        comment: 'pending note',
        fragmentUrl: '#cancel-failure',
        wrapper
      }
    ]);
    context.emitCommentDraftChange({});
    await flushDraftPersistence();
    context.messaging.send.mockClear();
    context.view.updateHint.mockClear();
    vi.spyOn(context.storageLocal, 'setMany').mockImplementationOnce(() =>
      Promise.reject(new Error('cancel terminal save failed'))
    );

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }

    callbacks.onCancel();
    await vi.waitFor(() => {
      expect(context.view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    });

    expect(context.view.destroy).not.toHaveBeenCalled();
    expect(isReaderSessionActive(document)).toBe(true);
    expect(getReaderSession()).toBe(context.session);
    expect(getSessionHarness(context.session).__testHighlights).toHaveLength(1);
    expect(
      getTelemetryMessages(context).find((message) => message.event === 'reader_session_cancelled')
    ).toBeUndefined();
    await expect(loadLatestReaderDraft(context)).resolves.toMatchObject({ status: 'active' });
  });

  it('preserves same-page other-owner drafts after cancel when the current exact-key cleanup fails', async () => {
    vi.useFakeTimers();
    const previousChrome = globalThis.chrome;
    const currentOwner: SessionDraftOwnerContext = { tabId: 11, windowId: 1, frameId: 0 };
    const otherOwner: SessionDraftOwnerContext = { tabId: 22, windowId: 2, frameId: 0 };
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          sendMessage: vi.fn(
            (message: object | null, callback?: (response: TabContextProbeResponse) => void) => {
              if (isTabContextProbeMessage(message)) {
                callback?.({ success: true, active: true });
                return;
              }
              callback?.({ success: true, ...currentOwner });
            }
          )
        }
      }
    });
    configureSessionDraftRuntimeMessenger(async <TResult = unknown>(message: unknown) => {
      if ((message === null || typeof message === 'object') && isTabContextProbeMessage(message)) {
        return { success: true, active: true } as TResult;
      }
      return { success: true, ...currentOwner } as TResult;
    });

    const context = createSessionContext();
    const pageUrl = 'https://example.com/article';
    const existing = buildReaderSessionDraftEnvelope({
      draftId: 'existing-draft',
      createdAt: 2_000_000_000_049,
      now: 2_000_000_000_050,
      pageUrl,
      pageTitle: 'Existing title',
      highlights: [
        createPersistedHighlightRecord({
          id: 'existing-highlight',
          selectedText: 'Existing highlight',
          selectedHtml: '<mark>Existing highlight</mark>',
          comment: 'existing note',
          fragmentUrl: '#existing-highlight',
          createdAt: 2_000_000_000_050
        })
      ],
      commentDrafts: {
        'existing-highlight': 'existing note'
      },
      status: 'active'
    });

    if (!existing) {
      throw new Error('expected existing reader draft envelope');
    }

    try {
      await context.draftRepository.save(existing, { ownerContext: otherOwner });
      await context.session.initialize();

      const content = document.getElementById('content');
      if (!content?.firstChild) {
        throw new Error('content node missing');
      }

      await settleReaderMutation(
        Promise.resolve(
          getSessionHarness(context.session).handleSelection(
            createSelectionPayload(content.firstChild)
          )
        )
      );

      const beforeCancel = await context.draftRepository.listCandidates(
        'reader',
        pageUrl,
        undefined,
        { ownerContext: null }
      );
      expect(beforeCancel).toHaveLength(2);

      const currentDraft = beforeCancel.find((candidate) => candidate.draftId !== 'existing-draft');
      if (!currentDraft) {
        throw new Error('expected a current draft before cancel');
      }

      const currentDraftKey = createSessionDraftStorageKey({
        mode: 'reader',
        pageKey: currentDraft.pageKey,
        draftId: currentDraft.draftId
      });
      const existingDraftKey = createSessionDraftStorageKey({
        mode: 'reader',
        pageKey: existing.pageKey,
        draftId: existing.draftId
      });
      const passthroughRemove = context.storageLocal.remove.bind(context.storageLocal);
      const removeSpy = vi
        .spyOn(context.storageLocal, 'remove')
        .mockImplementation(async (value) => {
          if (removalCallIncludesKey(value, currentDraftKey)) {
            throw new Error('keep current key to verify terminal suppression');
          }
          return await passthroughRemove(value);
        });

      const callbacks = context.getCallbacks();
      if (!callbacks) {
        throw new Error('panel callbacks missing');
      }

      callbacks.onCancel();
      await vi.waitFor(() => {
        expect(context.view.destroy).toHaveBeenCalledTimes(1);
      });

      const afterCancel = await context.draftRepository.listCandidates(
        'reader',
        pageUrl,
        undefined,
        { ownerContext: null }
      );
      expect(afterCancel).toHaveLength(1);
      expect(afterCancel[0]?.draftId).toBe('existing-draft');
      await expect(
        context.draftRepository.loadLatest('reader', pageUrl, undefined, { ownerContext: null })
      ).resolves.toMatchObject({
        draftId: 'existing-draft'
      });
      const draftIndex = await readDraftIndex(context);
      if (!draftIndex) {
        throw new Error('Expected session draft index');
      }
      expect(draftIndex.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ draftId: 'existing-draft', status: 'active' }),
          expect.objectContaining({ draftId: currentDraft.draftId, status: 'discarded' })
        ])
      );
      await expect(readStoredReaderDraft(context, currentDraftKey)).resolves.toMatchObject({
        draftId: currentDraft.draftId,
        status: 'discarded'
      });
      expect(
        removeSpy.mock.calls.filter(([value]) => removalCallIncludesKey(value, currentDraftKey))
      ).toHaveLength(1);
      expect(
        removeSpy.mock.calls.filter(([value]) => removalCallIncludesKey(value, existingDraftKey))
      ).toHaveLength(0);
    } finally {
      configureSessionDraftRuntimeMessenger(null);
      if (previousChrome === undefined) {
        Reflect.deleteProperty(globalThis, 'chrome');
      } else {
        Object.defineProperty(globalThis, 'chrome', {
          configurable: true,
          value: previousChrome
        });
      }
      vi.useRealTimers();
    }
  });

  it('keeps the session active when pending draft flush fails before cancel terminalization', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-cancel-flush-failure';
    wrapper.textContent = 'Cancel me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-cancel-flush-failure',
        selectedHtml: '<mark>Cancel me</mark>',
        selectedText: 'Cancel me',
        comment: 'persisted note',
        fragmentUrl: '#cancel-flush-failure',
        wrapper
      }
    ]);
    context.emitCommentDraftChange({});
    await flushDraftPersistence();

    const { draftId: currentDraftId } = getDraftIdentity(context.session);
    if (!currentDraftId) {
      throw new Error('expected an active current draft');
    }

    context.emitCommentDraftChange({
      'h-cancel-flush-failure': 'pending unsaved comment'
    });
    context.messaging.send.mockClear();
    context.view.updateHint.mockClear();
    const setManySpy = vi
      .spyOn(context.storageLocal, 'setMany')
      .mockImplementationOnce(() => Promise.reject(new Error('cancel pending flush failed')));

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }

    callbacks.onCancel();
    await vi.waitFor(() => {
      expect(context.view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    });

    expect(context.view.destroy).not.toHaveBeenCalled();
    expect(isReaderSessionActive(document)).toBe(true);
    expect(getReaderSession()).toBe(context.session);
    expect(context.view.currentDrafts).toEqual({
      'h-cancel-flush-failure': 'pending unsaved comment'
    });
    expect(
      getTelemetryMessages(context).find((message) => message.event === 'reader_session_cancelled')
    ).toBeUndefined();
    expect(setManySpy).toHaveBeenCalledTimes(1);
    await expect(loadLatestReaderDraft(context)).resolves.toMatchObject({
      draftId: currentDraftId,
      status: 'active'
    });
  });

  it('cleans up after export when exact-key draft removal fails after the terminal envelope is written', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-export-terminal';
    wrapper.textContent = 'Export me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-export-terminal',
        selectedHtml: '<mark>Export me</mark>',
        selectedText: 'Export me',
        comment: 'pending note',
        fragmentUrl: '#export-terminal',
        wrapper
      }
    ]);
    context.emitCommentDraftChange({});
    await flushDraftPersistence();

    const { draftStorageKey: currentDraftKey, draftId: currentDraftId } = getDraftIdentity(
      context.session
    );
    if (!currentDraftKey || !currentDraftId) {
      throw new Error('expected an active current draft');
    }

    const passthroughRemove = context.storageLocal.remove.bind(context.storageLocal);
    vi.spyOn(context.storageLocal, 'remove').mockImplementation(async (value) => {
      if (removalCallIncludesKey(value, currentDraftKey)) {
        throw new Error('remove current exact key after terminal export failed');
      }
      return await passthroughRemove(value);
    });

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }

    await callbacks.onFinish();

    expect(context.dispatchClipResult).toHaveBeenCalledTimes(1);
    expect(context.view.destroy).toHaveBeenCalledTimes(1);
    expect(isReaderSessionActive(document)).toBe(false);
    await expect(loadLatestReaderDraft(context)).resolves.toBeNull();
    await expect(listReaderDraftCandidates(context)).resolves.toEqual([]);
    expect(await readDraftIndex(context)).toMatchObject({
      entries: [expect.objectContaining({ draftId: currentDraftId, status: 'exported' })]
    });
    await expect(readStoredReaderDraft(context, currentDraftKey)).resolves.toMatchObject({
      draftId: currentDraftId,
      status: 'exported'
    });
  });

  it('keeps the session active and suppresses export success analytics when terminal draft persistence fails', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-export-failure';
    wrapper.textContent = 'Export me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-export-failure',
        selectedHtml: '<mark>Export me</mark>',
        selectedText: 'Export me',
        comment: 'pending note',
        fragmentUrl: '#export-failure',
        wrapper
      }
    ]);
    context.emitCommentDraftChange({});
    await flushDraftPersistence();
    context.messaging.send.mockClear();
    context.view.updateHint.mockClear();
    vi.spyOn(context.storageLocal, 'setMany').mockImplementationOnce(() =>
      Promise.reject(new Error('export terminal save failed'))
    );

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }

    await callbacks.onFinish();

    expect(context.dispatchClipResult).toHaveBeenCalledTimes(1);
    expect(context.view.destroy).not.toHaveBeenCalled();
    expect(isReaderSessionActive(document)).toBe(true);
    expect(getSessionHarness(context.session).__testHighlights).toHaveLength(1);
    expect(context.view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(
      getTelemetryMessages(context).find((message) => message.event === 'reader_exported')
    ).toBeUndefined();
    await expect(loadLatestReaderDraft(context)).resolves.toMatchObject({ status: 'active' });
  });

  it('keeps the session active when pending draft flush fails after export dispatch succeeds', async () => {
    vi.useFakeTimers();
    const context = createSessionContext();
    await context.session.initialize();

    const wrapper = document.createElement('mark');
    wrapper.className = 'aiob-reader-highlight';
    wrapper.dataset.readerHighlightId = 'h-export-flush-failure';
    wrapper.textContent = 'Export me';
    document.body.appendChild(wrapper);
    getSessionHarness(context.session).__setTestHighlights([
      {
        id: 'h-export-flush-failure',
        selectedHtml: '<mark>Export me</mark>',
        selectedText: 'Export me',
        comment: 'persisted note',
        fragmentUrl: '#export-flush-failure',
        wrapper
      }
    ]);
    context.emitCommentDraftChange({});
    await flushDraftPersistence();

    const { draftId: currentDraftId } = getDraftIdentity(context.session);
    if (!currentDraftId) {
      throw new Error('expected an active current draft');
    }

    context.emitCommentDraftChange({
      'h-export-flush-failure': 'pending unsaved comment'
    });
    context.messaging.send.mockClear();
    context.view.updateHint.mockClear();
    const setManySpy = vi
      .spyOn(context.storageLocal, 'setMany')
      .mockImplementationOnce(() => Promise.reject(new Error('export pending flush failed')));

    const callbacks = context.getCallbacks();
    if (!callbacks) {
      throw new Error('panel callbacks missing');
    }

    await callbacks.onFinish();

    expect(context.dispatchClipResult).toHaveBeenCalledTimes(1);
    expect(context.view.destroy).not.toHaveBeenCalled();
    expect(isReaderSessionActive(document)).toBe(true);
    expect(context.view.currentDrafts).toEqual({
      'h-export-flush-failure': 'pending unsaved comment'
    });
    expect(context.view.updateHint).toHaveBeenCalledWith(DEFAULT_SESSION_MESSAGES.hintFailure);
    expect(context.showSupportProgress).toHaveBeenCalledWith({
      value: 100,
      variant: 'failure'
    });
    expect(
      getTelemetryMessages(context).find((message) => message.event === 'reader_exported')
    ).toBeUndefined();
    expect(setManySpy).toHaveBeenCalledTimes(1);
    await expect(loadLatestReaderDraft(context)).resolves.toMatchObject({
      draftId: currentDraftId,
      status: 'active'
    });
  });

  it.each([
    {
      name: 'permission-denied export surfaces',
      rejection: new Error('permission denied'),
      expectedCategory: 'permission'
    },
    {
      name: 'message timeout failures',
      rejection: new DOMException('timed out', 'AbortError'),
      expectedCategory: 'timeout'
    },
    {
      name: 'extraction app errors',
      rejection: {
        code: 'EXTRACTION_CONTENT_NO_MARKDOWN',
        domain: 'extraction',
        message: 'EXTRACTION_CONTENT_NO_MARKDOWN',
        severity: 'error',
        recoverable: false
      },
      expectedCategory: 'extraction'
    },
    {
      name: 'unknown failures stay unknown',
      rejection: new Error('boom'),
      expectedCategory: 'unknown'
    }
  ])(
    'tracks failed exports for $name without swallowing the existing failure behavior',
    async ({ rejection, expectedCategory }) => {
      vi.useFakeTimers();
      const context = createSessionContext();
      await context.session.initialize();
      context.dispatchClipResult.mockRejectedValueOnce(rejection);

      const wrapper = document.createElement('mark');
      wrapper.className = 'aiob-reader-highlight';
      wrapper.dataset.readerHighlightId = 'h-fail';
      wrapper.textContent = 'Export me';
      document.body.appendChild(wrapper);
      getSessionHarness(context.session).__setTestHighlights([
        {
          id: 'h-fail',
          selectedHtml: '<mark>Export me</mark>',
          selectedText: 'Export me',
          comment: 'note',
          fragmentUrl: '#export',
          wrapper
        }
      ]);

      const callbacks = context.getCallbacks();
      if (!callbacks) {
        throw new Error('panel callbacks missing');
      }
      if (!callbacks.onSelectDestination) {
        throw new Error('destination callback missing');
      }

      await settleReaderMutation(Promise.resolve(callbacks.onSelectDestination('downloads')));
      const { draftStorageKey: currentDraftKey, draftId: currentDraftId } = getDraftIdentity(
        context.session
      );
      if (!currentDraftKey || !currentDraftId) {
        throw new Error('expected an active current draft');
      }
      await callbacks.onFinish();

      const failedEvent = getTelemetryMessages(context).find(
        (message) => message.event === 'reader_export_failed'
      );
      expect(failedEvent).toEqual({
        type: 'ANALYTICS_EVENT',
        event: 'reader_export_failed',
        params: {
          destination: 'downloads',
          failure_category: expectedCategory
        }
      });
      expect(context.view.updateHint).toHaveBeenLastCalledWith(
        DEFAULT_SESSION_MESSAGES.hintFailure
      );
      expect(context.view.destroy).not.toHaveBeenCalled();
      expect(isReaderSessionActive(document)).toBe(true);
      await expect(loadLatestReaderDraft(context)).resolves.toMatchObject({
        status: 'active'
      });
      await expect(listReaderDraftCandidates(context)).resolves.toEqual([
        expect.objectContaining({ draftId: currentDraftId, status: 'active' })
      ]);
      await expect(readStoredReaderDraft(context, currentDraftKey)).resolves.toMatchObject({
        draftId: currentDraftId,
        status: 'active'
      });
      expectCanonicalReaderTelemetry(getTelemetryMessages(context));
    }
  );
});
