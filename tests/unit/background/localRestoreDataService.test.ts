import { describe, expect, it, vi } from 'vitest';
import {
  createLocalRestoreDataClient,
  createRestoreDataPolicyPruneClient,
  LOCAL_RESTORE_DATA_CLEAR_FAILED,
  RESTORE_DATA_POLICY_PRUNE_FAILED
} from '../../../src/background/services/localRestoreDataService';
import type { RestoreStorageMaintenanceResponse } from '@content/sessionDrafts/restoreStorageMaintenanceMessages';
import { asType } from '../../utils/typeHelpers';

const SUCCESS = {
  success: true,
  operation: 'clearAllRestoreData',
  result: {
    draftKeysRemoved: 2,
    screenshotEntriesRemoved: 3,
    legacyScreenshotKeysRemoved: 1
  }
} as const;

const PRUNE_SUCCESS: Extract<
  RestoreStorageMaintenanceResponse,
  { operation: 'pruneRestoreDataToCurrentPolicy' }
> = {
  success: true,
  operation: 'pruneRestoreDataToCurrentPolicy',
  result: {
    expiredDrafts: 1,
    excessDrafts: 2,
    newlyOrphanedScreenshots: 3
  }
};

describe('localRestoreDataClient', () => {
  it('sends one bounded operation id and accepts a strict clear response', async () => {
    const send = vi.fn().mockResolvedValue(SUCCESS);
    const client = createLocalRestoreDataClient(
      asType<Parameters<typeof createLocalRestoreDataClient>[0]>({ send }),
      { createOperationId: () => 'clear-client' }
    );

    await expect(client.clearAll()).resolves.toEqual(SUCCESS.result);
    expect(send).toHaveBeenCalledWith({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'clearAllRestoreData',
      operationId: 'clear-client'
    });
  });

  it('reuses the operation id after response loss or an acknowledged partial failure', async () => {
    const messages: Array<{ operationId: string }> = [];
    let attempt = 0;
    const send = vi.fn((message: { operationId: string }) => {
      messages.push(message);
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('response lost'));
      if (attempt === 2) {
        return Promise.resolve({ success: false, error: LOCAL_RESTORE_DATA_CLEAR_FAILED });
      }
      return Promise.resolve(SUCCESS);
    });
    let sequence = 0;
    const client = createLocalRestoreDataClient(
      asType<Parameters<typeof createLocalRestoreDataClient>[0]>({ send }),
      { createOperationId: () => `clear-client-${sequence++}` }
    );

    await expect(client.clearAll()).rejects.toThrow('response lost');
    await expect(client.clearAll()).rejects.toThrow(LOCAL_RESTORE_DATA_CLEAR_FAILED);
    await expect(client.clearAll()).resolves.toEqual(SUCCESS.result);
    expect(messages.map((message) => message.operationId)).toEqual([
      'clear-client-0',
      'clear-client-0',
      'clear-client-0'
    ]);
  });

  it('shares one in-flight clear request between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return SUCCESS;
    });
    const client = createLocalRestoreDataClient(
      asType<Parameters<typeof createLocalRestoreDataClient>[0]>({ send }),
      { createOperationId: () => 'clear-concurrent' }
    );

    const first = client.clearAll();
    const second = client.clearAll();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([SUCCESS.result, SUCCESS.result]);
  });

  it('rejects malformed responses with a fixed code', async () => {
    const client = createLocalRestoreDataClient(
      { send: vi.fn().mockResolvedValue({ success: true, result: { draftKeysRemoved: -1 } }) },
      { createOperationId: () => 'clear-malformed' }
    );
    await expect(client.clearAll()).rejects.toThrow(LOCAL_RESTORE_DATA_CLEAR_FAILED);
  });
});

describe('restoreDataPolicyPruneClient', () => {
  it('sends the exact operation and keeps its operation id stable until success', async () => {
    const operationIds: string[] = [];
    let attempt = 0;
    const send = vi.fn((message: { operationId: string }) => {
      operationIds.push(message.operationId);
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('response lost'))
        : Promise.resolve(PRUNE_SUCCESS);
    });
    let sequence = 0;
    const client = createRestoreDataPolicyPruneClient(
      asType<Parameters<typeof createLocalRestoreDataClient>[0]>({ send }),
      { createOperationId: () => `policy-prune-${sequence++}` }
    );

    await expect(client.pruneToCurrentPolicy()).rejects.toThrow('response lost');
    await expect(client.pruneToCurrentPolicy()).resolves.toEqual(PRUNE_SUCCESS.result);
    expect(operationIds).toEqual(['policy-prune-0', 'policy-prune-0']);
    expect(send).toHaveBeenLastCalledWith({
      type: 'AIIOB_VIDEO_SCREENSHOT_CACHE',
      operation: 'pruneRestoreDataToCurrentPolicy',
      operationId: 'policy-prune-0'
    });
  });

  it('shares an in-flight prune and rejects malformed responses with a fixed code', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return PRUNE_SUCCESS;
    });
    const client = createRestoreDataPolicyPruneClient(
      asType<Parameters<typeof createLocalRestoreDataClient>[0]>({ send }),
      { createOperationId: () => 'policy-prune-concurrent' }
    );
    const first = client.pruneToCurrentPolicy();
    const second = client.pruneToCurrentPolicy();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      PRUNE_SUCCESS.result,
      PRUNE_SUCCESS.result
    ]);

    const malformed = createRestoreDataPolicyPruneClient(
      { send: vi.fn().mockResolvedValue({ ...PRUNE_SUCCESS, result: { expiredDrafts: -1 } }) },
      { createOperationId: () => 'policy-prune-malformed' }
    );
    await expect(malformed.pruneToCurrentPolicy()).rejects.toThrow(
      RESTORE_DATA_POLICY_PRUNE_FAILED
    );
  });

  it.each([
    '',
    'x'.repeat(129),
    'white space',
    'line\nbreak',
    'control\u0000value',
    '操作',
    'surrogate-\ud800'
  ])('fails closed before send for an invalid generated operation id', async (operationId) => {
    const send = vi.fn().mockResolvedValue(PRUNE_SUCCESS);
    const client = createRestoreDataPolicyPruneClient(
      asType<Parameters<typeof createLocalRestoreDataClient>[0]>({ send }),
      { createOperationId: () => operationId }
    );

    await expect(client.pruneToCurrentPolicy()).rejects.toThrow(RESTORE_DATA_POLICY_PRUNE_FAILED);
    expect(send).not.toHaveBeenCalled();
  });
});
