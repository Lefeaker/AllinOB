import { normalizeSessionDraftRetentionPolicy } from './sessionDraftRetentionPolicy';
import { createSessionDraftStoragePolicy } from './sessionDraftStoragePolicy';
import type { SessionDraftRepositoryOptions, SessionDraftStoragePolicy } from './sessionDraftTypes';

export function resolveSessionDraftRepositoryStoragePolicy(
  options: SessionDraftRepositoryOptions
): SessionDraftStoragePolicy {
  const retentionPolicy = normalizeSessionDraftRetentionPolicy(
    options.storagePolicy?.retentionPolicy ?? options.retentionPolicy,
    options.ttlMs
  );
  const maxDraftEntries = options.maxEntries ?? options.storagePolicy?.maxDraftEntries;
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? options.storagePolicy?.maxEnvelopeBytes;

  return createSessionDraftStoragePolicy({
    retentionPolicy,
    ...(maxDraftEntries === undefined ? {} : { maxDraftEntries }),
    ...(maxEnvelopeBytes === undefined ? {} : { maxEnvelopeBytes })
  });
}
