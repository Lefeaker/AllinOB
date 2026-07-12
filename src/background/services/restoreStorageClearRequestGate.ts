import type { SessionDraftRepositoryResponse } from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import type { VideoScreenshotCacheResponse } from '../../content/video/videoScreenshotCacheMessages';

export type RestoreStorageHandlerResponse =
  | VideoScreenshotCacheResponse
  | SessionDraftRepositoryResponse
  | undefined;

interface ActiveClearRequest {
  operationId: string;
  promise: Promise<RestoreStorageHandlerResponse>;
}

const activeRequests = new WeakMap<object, ActiveClearRequest>();

export function readActiveRestoreStorageClearRequest(identity: object): ActiveClearRequest | null {
  return activeRequests.get(identity) ?? null;
}

export function registerActiveRestoreStorageClearRequest(
  identity: object,
  operationId: string,
  promise: Promise<RestoreStorageHandlerResponse>
): void {
  activeRequests.set(identity, { operationId, promise });
  void promise.then(
    () => clear(identity, promise),
    () => clear(identity, promise)
  );
}

function clear(identity: object, promise: Promise<RestoreStorageHandlerResponse>): void {
  if (activeRequests.get(identity)?.promise === promise) activeRequests.delete(identity);
}
