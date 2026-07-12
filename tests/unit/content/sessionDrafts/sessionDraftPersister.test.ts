import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionDraftPersister } from '@content/sessionDrafts/sessionDraftPersister';
import type { SessionDraftEnvelope } from '@content/sessionDrafts/sessionDraftTypes';

function createEnvelope(draftId: string, updatedAt: number): SessionDraftEnvelope {
  return {
    schemaVersion: 1,
    draftId,
    mode: 'reader',
    pageKey: `page-${draftId}`,
    pageUrl: 'https://example.com/post#:~:text=Alpha',
    pageTitle: 'Reader title',
    createdAt: updatedAt - 1,
    updatedAt,
    expiresAt: updatedAt + 1_000,
    status: 'active',
    payload: {
      commentDrafts: {
        [draftId]: `draft-${updatedAt}`
      }
    }
  };
}

describe('sessionDraftPersister', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid saves and flushes the latest envelope', async () => {
    vi.useFakeTimers();

    let current = createEnvelope('draft-1', 1);
    const repository = {
      save: vi.fn(async () => undefined)
    };
    const persister = createSessionDraftPersister({
      repository,
      buildEnvelope: () => current,
      delayMs: 25
    });

    const first = persister.scheduleSave();
    current = createEnvelope('draft-2', 2);
    const second = persister.scheduleSave();

    await vi.advanceTimersByTimeAsync(25);
    await Promise.all([first, second]);

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-2' }));
  });

  it('serializes writes so newer drafts cannot reorder ahead of older writes', async () => {
    vi.useFakeTimers();

    let current = createEnvelope('draft-1', 1);
    let releaseFirst: (() => void) | null = null;
    const repository = {
      save: vi.fn((envelope: SessionDraftEnvelope) => {
        if (envelope.draftId === 'draft-1') {
          return new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve();
      })
    };
    const persister = createSessionDraftPersister({
      repository,
      buildEnvelope: () => current,
      delayMs: 10
    });

    const first = persister.scheduleSave();
    await vi.advanceTimersByTimeAsync(10);
    expect(repository.save).toHaveBeenCalledTimes(1);

    current = createEnvelope('draft-2', 2);
    const second = persister.scheduleSave();
    await vi.advanceTimersByTimeAsync(10);
    expect(repository.save).toHaveBeenCalledTimes(1);

    expect(releaseFirst).not.toBeNull();
    releaseFirst!();
    await Promise.all([first, second]);

    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.save.mock.calls[0]?.[0]).toMatchObject({ draftId: 'draft-1' });
    expect(repository.save.mock.calls[1]?.[0]).toMatchObject({ draftId: 'draft-2' });
  });

  it('flushNow drains a pending save after an in-flight write without reordering envelopes', async () => {
    vi.useFakeTimers();

    let current = createEnvelope('draft-1', 1);
    let releaseFirst: (() => void) | null = null;
    const repository = {
      save: vi.fn((envelope: SessionDraftEnvelope) => {
        if (envelope.draftId === 'draft-1') {
          return new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve();
      })
    };
    const persister = createSessionDraftPersister({
      repository,
      buildEnvelope: () => current,
      delayMs: 10
    });

    const first = persister.scheduleSave();
    await vi.advanceTimersByTimeAsync(10);
    expect(repository.save).toHaveBeenCalledTimes(1);

    current = createEnvelope('draft-2', 2);
    const second = persister.scheduleSave();
    const flush = persister.flushNow();
    await Promise.resolve();

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(releaseFirst).not.toBeNull();

    releaseFirst!();
    await Promise.all([first, second, flush]);

    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.save.mock.calls[0]?.[0]).toMatchObject({ draftId: 'draft-1' });
    expect(repository.save.mock.calls[1]?.[0]).toMatchObject({ draftId: 'draft-2' });
  });

  it('dispose with flush drains a pending save after an in-flight write without reordering', async () => {
    vi.useFakeTimers();

    let current = createEnvelope('draft-1', 1);
    let releaseFirst: (() => void) | null = null;
    const repository = {
      save: vi.fn((envelope: SessionDraftEnvelope) => {
        if (envelope.draftId === 'draft-1') {
          return new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return Promise.resolve();
      })
    };
    const persister = createSessionDraftPersister({
      repository,
      buildEnvelope: () => current,
      delayMs: 10
    });

    const first = persister.scheduleSave();
    await vi.advanceTimersByTimeAsync(10);
    expect(repository.save).toHaveBeenCalledTimes(1);

    current = createEnvelope('draft-2', 2);
    const second = persister.scheduleSave();
    const dispose = persister.dispose({ flush: true });
    await Promise.resolve();

    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(releaseFirst).not.toBeNull();

    releaseFirst!();
    await Promise.all([first, second, dispose]);

    expect(repository.save).toHaveBeenCalledTimes(2);
    expect(repository.save.mock.calls[0]?.[0]).toMatchObject({ draftId: 'draft-1' });
    expect(repository.save.mock.calls[1]?.[0]).toMatchObject({ draftId: 'draft-2' });
  });

  it('dispose without flush cancels a pending timer without writing', async () => {
    vi.useFakeTimers();

    const repository = {
      save: vi.fn(async () => undefined)
    };
    const persister = createSessionDraftPersister({
      repository,
      buildEnvelope: () => createEnvelope('draft-1', 1),
      delayMs: 10
    });

    const scheduled = persister.scheduleSave();
    await persister.dispose();
    await vi.advanceTimersByTimeAsync(10);

    await expect(scheduled).resolves.toBeUndefined();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('cancels a pending save synchronously without waiting for its timer', async () => {
    vi.useFakeTimers();
    const repository = { save: vi.fn(async () => undefined) };
    const persister = createSessionDraftPersister({
      repository,
      buildEnvelope: () => createEnvelope('draft-cancelled', 1),
      delayMs: 10
    });
    const scheduled = persister.scheduleSave();

    persister.cancelPending();
    await scheduled;
    await vi.advanceTimersByTimeAsync(10);

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('surfaces write failures through the returned promise', async () => {
    vi.useFakeTimers();

    const repository = {
      save: vi.fn(async () => {
        throw new Error('save failed');
      })
    };
    const persister = createSessionDraftPersister({
      repository,
      buildEnvelope: () => createEnvelope('draft-1', 1),
      delayMs: 10
    });

    const scheduled = persister.scheduleSave();
    await vi.advanceTimersByTimeAsync(10);

    await expect(scheduled).rejects.toThrow('save failed');
  });
});
