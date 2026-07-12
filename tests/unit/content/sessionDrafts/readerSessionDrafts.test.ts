/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import {
  buildReaderSessionDraftEnvelope,
  loadLatestReaderSessionDraft,
  loadLatestReaderSessionDraftResult,
  restoreReaderSessionDraftHighlights
} from '@content/reader/sessionDrafts';
import type { ReaderHighlightRecord } from '@content/reader/services/highlightManager';
import {
  FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE,
  createDirectSessionDraftRepository as createSessionDraftRepository
} from '@content/sessionDrafts';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';

function createHighlightRecord(
  overrides: Partial<ReaderHighlightRecord> = {}
): ReaderHighlightRecord {
  const wrapper = document.createElement('mark');
  wrapper.className = 'aiob-reader-highlight';
  wrapper.dataset.readerHighlightId = overrides.id ?? 'saved-1';
  wrapper.textContent = overrides.selectedText ?? 'Saved highlight';
  return {
    id: overrides.id ?? 'saved-1',
    selectedHtml: overrides.selectedHtml ?? '<mark>Saved highlight</mark>',
    selectedText: overrides.selectedText ?? 'Saved highlight',
    comment: overrides.comment ?? '',
    fragmentUrl: overrides.fragmentUrl ?? '#saved-1',
    wrapper,
    wrapperSegments: overrides.wrapperSegments ?? [wrapper],
    createdAt: overrides.createdAt ?? 25
  };
}

describe('readerSessionDrafts', () => {
  it('builds and loads a persisted reader draft with destination and comment drafts', async () => {
    const repository = createSessionDraftRepository(createMemoryStorageArea());
    const now = Date.now();
    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-1',
      createdAt: now - 10,
      now,
      pageUrl: 'https://example.com/article',
      pageTitle: 'Saved article',
      destination: { kind: 'downloads' },
      highlights: [
        createHighlightRecord({
          id: 'saved-1',
          selectedText: 'Saved highlight',
          comment: 'saved comment',
          createdAt: 30
        })
      ],
      commentDrafts: {
        'saved-1': 'draft note'
      },
      status: 'restorable'
    });

    expect(envelope).not.toBeNull();
    if (!envelope) {
      throw new Error('expected reader session envelope');
    }

    await repository.save(envelope);
    const loadedDraft = await loadLatestReaderSessionDraft(
      repository,
      'https://example.com/article'
    );
    expect(loadedDraft).not.toBeNull();
    expect(loadedDraft?.storageKey).toContain('reader-draft-1');
    expect(loadedDraft?.payload).toMatchObject({
      mode: 'reader',
      url: 'https://example.com/article',
      title: 'Saved article',
      destination: { kind: 'downloads' },
      commentDrafts: {
        'saved-1': 'draft note'
      }
    });
  });

  it('reports invalid persisted reader drafts with aggregate counts and removes the candidate', async () => {
    const storage = createMemoryStorageArea();
    const repository = createSessionDraftRepository(storage);
    const now = Date.now();
    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-invalid',
      createdAt: now - 10,
      now,
      pageUrl: 'https://example.com/article',
      pageTitle: 'Broken article',
      destination: { kind: 'downloads' },
      highlights: [
        createHighlightRecord({
          id: 'saved-1',
          selectedText: 'Saved highlight',
          comment: 'saved comment',
          createdAt: 30
        })
      ],
      commentDrafts: {
        'saved-1': 'draft note'
      },
      status: 'restorable'
    });

    expect(envelope).not.toBeNull();
    if (!envelope) {
      throw new Error('expected invalid reader session envelope');
    }

    await repository.save(envelope);
    const loadedDraft = await loadLatestReaderSessionDraft(
      repository,
      'https://example.com/article'
    );
    if (!loadedDraft) {
      throw new Error('expected persisted reader draft');
    }
    await storage.set(loadedDraft.storageKey, {
      ...envelope,
      payload: {
        ...envelope.payload,
        commentDrafts: [] as unknown as Record<string, string>
      }
    } as never);

    const result = await loadLatestReaderSessionDraftResult(
      repository,
      storage,
      'https://example.com/article'
    );

    expect(result).toMatchObject({
      status: 'invalid_removed',
      highlightCount: 1,
      cleanup: 'removed'
    });
    await expect(
      repository.loadLatest('reader', 'https://example.com/article')
    ).resolves.toBeNull();
    await expect(
      loadLatestReaderSessionDraft(repository, 'https://example.com/article')
    ).resolves.toBeNull();
  });

  it('returns null instead of creating an empty durable reader draft', () => {
    expect(
      buildReaderSessionDraftEnvelope({
        draftId: 'reader-draft-empty',
        createdAt: 10,
        now: 20,
        pageUrl: 'https://example.com/article',
        pageTitle: 'Empty article',
        highlights: [],
        commentDrafts: {},
        status: 'active'
      })
    ).toBeNull();
  });

  it('persists only the newest Free highlight window and filters comment drafts', () => {
    const highlights = Array.from({ length: 25 }, (_, index) =>
      createHighlightRecord({
        id: `highlight-${index}`,
        selectedText: `Highlight ${index}`,
        selectedHtml: `<mark>Highlight ${index}</mark>`,
        comment: `saved comment ${index}`,
        createdAt: 1_000 + index
      })
    );
    const commentDrafts = Object.fromEntries(
      highlights.map((highlight) => [highlight.id, `draft for ${highlight.id}`])
    );

    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-cap',
      createdAt: 900,
      now: 2_000,
      pageUrl: 'https://example.com/article/free-cap',
      pageTitle: 'Article with many highlights',
      highlights,
      commentDrafts,
      status: 'active'
    });

    expect(envelope).not.toBeNull();
    if (!envelope) {
      throw new Error('expected reader session envelope');
    }
    const retainedHighlights = envelope.payload.highlights ?? [];
    const retainedCommentDrafts = envelope.payload.commentDrafts ?? {};
    expect(retainedHighlights).toHaveLength(FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE);
    expect(retainedHighlights.map((highlight) => highlight.id)).toEqual(
      Array.from(
        { length: FREE_SESSION_DRAFT_MAX_ITEMS_PER_PAGE },
        (_, index) => `highlight-${index + 5}`
      )
    );
    expect(Object.keys(retainedCommentDrafts)).toEqual(
      retainedHighlights.map((highlight) => highlight.id)
    );
    expect(highlights).toHaveLength(25);
  });

  it('honors an injected generic null item cap without durable binary payloads', () => {
    const highlights = Array.from({ length: 25 }, (_, index) =>
      createHighlightRecord({
        id: `highlight-${index}`,
        selectedText: `Highlight ${index}`,
        selectedHtml: `<mark>Highlight ${index}</mark>`,
        comment: `saved comment ${index}`,
        createdAt: 1_000 + index
      })
    );
    const commentDraftEntries: Array<[string, string]> = [
      ...highlights.map((highlight): [string, string] => [
        highlight.id,
        `draft for ${highlight.id}`
      ]),
      ['orphan-highlight', 'should be filtered']
    ];
    const commentDrafts = Object.fromEntries(commentDraftEntries);

    const envelope = buildReaderSessionDraftEnvelope({
      draftId: 'reader-draft-null-cap',
      createdAt: 900,
      now: 2_000,
      pageUrl: 'https://example.com/article/null-cap',
      pageTitle: 'Article with generic null cap',
      highlights,
      commentDrafts,
      retentionPolicy: {
        retentionMs: 96 * 60 * 60 * 1000,
        maxRestorablePages: null,
        maxItemsPerPage: null
      },
      status: 'active'
    });

    expect(envelope).not.toBeNull();
    if (!envelope) {
      throw new Error('expected reader session envelope');
    }
    expect(envelope.payload.highlights).toHaveLength(25);
    expect(Object.keys(envelope.payload.commentDrafts ?? {})).toEqual(
      highlights.map((highlight) => highlight.id)
    );
    const serializedEnvelope = JSON.stringify(envelope);
    expect(serializedEnvelope).not.toContain('data:image/');
    expect(serializedEnvelope).not.toContain('ArrayBuffer');
    expect(serializedEnvelope).not.toContain('Blob');
  });

  it('recreates live highlight ranges when the saved text still exists in the document', () => {
    document.body.innerHTML = '<article><p>Alpha Beta Gamma</p></article>';
    const createHighlight = vi.fn(
      (options: {
        id: string;
        range: Range;
        selectedHtml: string;
        selectedText: string;
        comment: string;
        fragmentUrl: string;
      }) => {
        const wrapper = document.createElement('mark');
        wrapper.dataset.readerHighlightId = options.id;
        wrapper.textContent = options.range.toString();
        return createHighlightRecord({
          id: options.id,
          selectedHtml: options.selectedHtml,
          selectedText: options.selectedText,
          comment: options.comment,
          fragmentUrl: options.fragmentUrl,
          wrapper,
          wrapperSegments: [wrapper],
          createdAt: 40
        });
      }
    );

    const restored = restoreReaderSessionDraftHighlights({
      doc: document,
      highlightManager: {
        createHighlight
      } as never,
      highlights: [
        {
          id: 'saved-1',
          selectedHtml: '<mark>Beta</mark>',
          selectedText: 'Beta',
          comment: 'saved comment',
          fragmentUrl: '#saved-1',
          createdAt: 44
        }
      ]
    });

    expect(createHighlight).toHaveBeenCalledTimes(1);
    expect(createHighlight.mock.calls[0]?.[0].range.toString()).toBe('Beta');
    expect(restored.detachedHighlightIds).toEqual([]);
    expect(restored.highlights).toEqual([
      expect.objectContaining({
        id: 'saved-1',
        selectedText: 'Beta',
        comment: 'saved comment',
        createdAt: 44
      })
    ]);
  });

  it('restores duplicate reader draft text to separate document occurrences', () => {
    document.body.innerHTML = '<article><p>Echo middle Echo</p></article>';
    const createHighlight = vi.fn(
      (options: {
        id: string;
        range: Range;
        selectedHtml: string;
        selectedText: string;
        comment: string;
        fragmentUrl: string;
      }) => {
        const wrapper = document.createElement('mark');
        wrapper.dataset.readerHighlightId = options.id;
        wrapper.textContent = options.range.toString();
        return createHighlightRecord({
          id: options.id,
          selectedHtml: options.selectedHtml,
          selectedText: options.selectedText,
          comment: options.comment,
          fragmentUrl: options.fragmentUrl,
          wrapper,
          wrapperSegments: [wrapper],
          createdAt: 40
        });
      }
    );

    const restored = restoreReaderSessionDraftHighlights({
      doc: document,
      highlightManager: {
        createHighlight
      } as never,
      highlights: [
        {
          id: 'saved-1',
          selectedHtml: '<mark>Echo</mark>',
          selectedText: 'Echo',
          comment: 'first duplicate',
          fragmentUrl: '#saved-1',
          createdAt: 44
        },
        {
          id: 'saved-2',
          selectedHtml: '<mark>Echo</mark>',
          selectedText: 'Echo',
          comment: 'second duplicate',
          fragmentUrl: '#saved-2',
          createdAt: 45
        }
      ]
    });

    expect(createHighlight).toHaveBeenCalledTimes(2);
    expect(createHighlight.mock.calls.map(([options]) => options.range.startOffset)).toEqual([
      0, 12
    ]);
    expect(restored.detachedHighlightIds).toEqual([]);
    expect(restored.highlights).toEqual([
      expect.objectContaining({
        id: 'saved-1',
        selectedText: 'Echo',
        comment: 'first duplicate',
        createdAt: 44
      }),
      expect.objectContaining({
        id: 'saved-2',
        selectedText: 'Echo',
        comment: 'second duplicate',
        createdAt: 45
      })
    ]);
  });

  it('falls back to detached highlight rows when the saved text no longer exists', () => {
    document.body.innerHTML = '<article><p>Alpha Beta Gamma</p></article>';
    const createHighlight = vi.fn();

    const restored = restoreReaderSessionDraftHighlights({
      doc: document,
      highlightManager: {
        createHighlight
      } as never,
      highlights: [
        {
          id: 'detached-1',
          selectedHtml: '<mark>Missing text</mark>',
          selectedText: 'Missing text',
          comment: 'saved comment',
          fragmentUrl: '#detached-1',
          createdAt: 55
        }
      ]
    });

    expect(createHighlight).not.toHaveBeenCalled();
    expect(restored.detachedHighlightIds).toEqual(['detached-1']);
    expect(restored.highlights).toEqual([
      expect.objectContaining({
        id: 'detached-1',
        selectedText: 'Missing text',
        comment: 'saved comment',
        createdAt: 55
      })
    ]);
    expect(restored.highlights[0]?.wrapper.isConnected).toBe(false);
  });
});
