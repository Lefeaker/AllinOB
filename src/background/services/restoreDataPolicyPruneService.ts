import { getSessionDraftEffectiveExpiresAt } from '../../content/sessionDrafts/sessionDraftRetentionPolicy';
import { measureSessionDraftValueBytes } from '../../content/sessionDrafts/sessionDraftSchemas';
import {
  readSessionDraftReferenceIndex,
  type SessionDraftReferenceIndexSnapshot
} from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import type { SessionDraftStoragePolicy } from '../../content/sessionDrafts/sessionDraftStoragePolicy';
import type { StorageAreaService } from '../../platform/interfaces/storage';
import type { RestoreDataPolicyPruneMessageResult } from '../../content/sessionDrafts/restoreStorageMaintenanceMessages';
import type { VideoScreenshotCacheBlobObservationStore } from '../../content/video/videoScreenshotCacheStore';
import {
  selectExcessDraftKeys,
  sortDraftsOldestFirst,
  sortScreenshotMetadataOldestFirst
} from './restoreStoragePressureSelectors';
import { createSessionDraftProtocolFingerprint } from './sessionDraftFingerprint';
import type {
  SessionDraftDeletionRequest,
  SessionDraftDeletionResult
} from './sessionDraftDeletionOwner';
import { SESSION_DRAFT_DELETE_MAX_TARGETS } from './sessionDraftDeletionStore';

type PolicyPruneDraftStage = 'expired' | 'excess';

export interface RestoreDataPolicyPruneServiceDependencies {
  drafts: Pick<StorageAreaService, 'getAll'>;
  screenshots: Pick<VideoScreenshotCacheBlobObservationStore, 'listAllMetadata'>;
  deleteScreenshotCandidates(keys: readonly string[]): Promise<{ deletedKeys: string[] }>;
  deleteDraftCandidates(request: SessionDraftDeletionRequest): Promise<SessionDraftDeletionResult>;
  getProtectedDraftKeys(): Promise<readonly string[]>;
  getStoragePolicy(): SessionDraftStoragePolicy;
  now?: () => number;
}

export interface RestoreDataPolicyPruneService {
  prune(operationId: string): Promise<RestoreDataPolicyPruneMessageResult>;
}

export function createRestoreDataPolicyPruneService(
  dependencies: RestoreDataPolicyPruneServiceDependencies
): RestoreDataPolicyPruneService {
  const now = dependencies.now ?? (() => Date.now());
  return {
    async prune(operationId) {
      const result: RestoreDataPolicyPruneMessageResult = {
        expiredDrafts: 0,
        excessDrafts: 0,
        newlyOrphanedScreenshots: 0
      };
      const policy = dependencies.getStoragePolicy();
      let references = await readSessionDraftReferenceIndex(dependencies.drafts);
      let protectedDraftKeys = new Set(await dependencies.getProtectedDraftKeys());
      const expiredDraftKeys = sortDraftsOldestFirst(references.drafts)
        .filter(
          ({ key, envelope }) =>
            envelope.status !== 'active' &&
            !protectedDraftKeys.has(key) &&
            getSessionDraftEffectiveExpiresAt(envelope, policy.retentionPolicy) <= now()
        )
        .map(({ key }) => key);
      result.expiredDrafts = await deleteDrafts(
        dependencies,
        operationId,
        'expired',
        expiredDraftKeys
      );

      references = await readSessionDraftReferenceIndex(dependencies.drafts);
      protectedDraftKeys = new Set(await dependencies.getProtectedDraftKeys());
      const policyViolationKeys = references.drafts
        .filter(
          ({ key, envelope }) =>
            envelope.status !== 'active' &&
            !protectedDraftKeys.has(key) &&
            exceedsCurrentDraftPolicy(envelope, policy)
        )
        .map(({ key }) => key);
      const excessDraftKeys = [
        ...new Set([
          ...policyViolationKeys,
          ...selectExcessDraftKeys(references, policy).filter((key) => !protectedDraftKeys.has(key))
        ])
      ].sort();
      result.excessDrafts = await deleteDrafts(
        dependencies,
        operationId,
        'excess',
        excessDraftKeys
      );

      references = await readSessionDraftReferenceIndex(dependencies.drafts);
      result.newlyOrphanedScreenshots = await deleteOrphanScreenshots(dependencies, references);
      return result;
    }
  };
}

function exceedsCurrentDraftPolicy(
  envelope: SessionDraftReferenceIndexSnapshot['drafts'][number]['envelope'],
  policy: SessionDraftStoragePolicy
): boolean {
  if (measureSessionDraftValueBytes(envelope) > policy.maxEnvelopeBytes) return true;
  const maxItems = policy.retentionPolicy.maxItemsPerPage;
  if (maxItems === null) return false;
  const items =
    envelope.mode === 'reader' ? envelope.payload.highlights : envelope.payload.captures;
  return Array.isArray(items) && items.length > maxItems;
}

async function deleteDrafts(
  dependencies: RestoreDataPolicyPruneServiceDependencies,
  parentOperationId: string,
  stage: PolicyPruneDraftStage,
  keys: readonly string[]
): Promise<number> {
  const candidates = [...new Set(keys)].sort();
  let removed = 0;
  for (let offset = 0; offset < candidates.length; offset += SESSION_DRAFT_DELETE_MAX_TARGETS) {
    let candidateKeys = candidates.slice(offset, offset + SESSION_DRAFT_DELETE_MAX_TARGETS);
    let attempt = 0;
    while (candidateKeys.length > 0) {
      const stageSeed = await createSessionDraftProtocolFingerprint({
        operation: 'pruneRestoreDataToCurrentPolicy',
        parentOperationId,
        stage,
        attempt,
        candidateKeys
      });
      const operationId = `policy-prune-${stage}-${stageSeed}`;
      const requestFingerprint = await createSessionDraftProtocolFingerprint({
        operation: 'pruneRestoreDataToCurrentPolicy',
        parentOperationId,
        stage,
        attempt,
        operationId,
        candidateKeys
      });
      const deletion = await dependencies.deleteDraftCandidates({
        operationId,
        requestFingerprint,
        candidateKeys
      });
      removed += deletion.revisions.length;
      if (deletion.protectedKeys.length === 0 || !deletion.replayed) break;
      candidateKeys = [...new Set(deletion.protectedKeys)].sort();
      attempt += 1;
    }
  }
  return removed;
}

async function deleteOrphanScreenshots(
  dependencies: RestoreDataPolicyPruneServiceDependencies,
  references: SessionDraftReferenceIndexSnapshot
): Promise<number> {
  const observation = await dependencies.screenshots.listAllMetadata();
  const orderedKeys = [
    ...sortScreenshotMetadataOldestFirst(observation.entries).map(({ key }) => key),
    ...observation.invalidKeys.slice().sort()
  ];
  const candidates = [...new Set(orderedKeys)].filter(
    (key) => !references.referencedScreenshotKeys.has(key)
  );
  let removed = 0;
  for (const key of candidates) {
    const deletion = await dependencies.deleteScreenshotCandidates([key]);
    removed += deletion.deletedKeys.length;
  }
  return removed;
}
