import { z } from 'zod';
import { isObjectRecord, type RuntimePropertyValue } from '../../shared/guards/object';
import { createSessionDraftPageKey, createSessionDraftStorageKey } from './sessionDraftKeys';
import {
  SESSION_DRAFT_SCHEMA_VERSION,
  type SessionDraftEnvelope,
  type SessionDraftIndex,
  type SessionDraftIndexEntry
} from './sessionDraftTypes';

const TimestampSchema = z.number().int().nonnegative().finite();
const textEncoder = new TextEncoder();
export const SESSION_DRAFT_ID_MAX_LENGTH = 256;

export const SessionDraftModeSchema = z.enum(['reader', 'video']);
export const SessionDraftStatusSchema = z.enum(['active', 'restorable', 'discarded', 'exported']);
export const SessionCommentDraftSnapshotSchema = z.record(z.string(), z.string());
export const SessionDraftOwnerContextSchema = z
  .object({
    tabId: z.number().int().nonnegative().optional(),
    windowId: z.number().int().nonnegative().optional(),
    frameId: z.number().int().nonnegative().optional()
  })
  .refine(
    (value) =>
      value.tabId !== undefined || value.windowId !== undefined || value.frameId !== undefined,
    { message: 'SESSION_DRAFT_OWNER_CONTEXT_MISSING_RUNTIME_IDENTIFIER' }
  );
export const ExportDestinationMetadataSchema = z.object({
  kind: z.enum(['vault', 'downloads']),
  vaultId: z.string().optional()
});
export const ReaderSessionDraftHighlightPayloadSchema = z.object({
  id: z.string().min(1),
  selectedHtml: z.string(),
  selectedText: z.string(),
  comment: z.string(),
  fragmentUrl: z.string(),
  createdAt: TimestampSchema
});

export const ReaderSessionDraftPayloadSchema = z
  .object({
    mode: z.literal('reader').optional(),
    url: z.string().url().optional(),
    title: z.string().optional(),
    destination: ExportDestinationMetadataSchema.optional(),
    highlights: z.array(ReaderSessionDraftHighlightPayloadSchema).optional(),
    commentDrafts: SessionCommentDraftSnapshotSchema.optional(),
    ownerContext: SessionDraftOwnerContextSchema.optional()
  })
  .passthrough();

export const VideoSessionDraftPayloadSchema = z
  .object({
    commentDrafts: SessionCommentDraftSnapshotSchema.optional(),
    ownerContext: SessionDraftOwnerContextSchema.optional()
  })
  .passthrough();

export const SessionDraftEnvelopeMetadataSchema = z.object({
  schemaVersion: z.literal(SESSION_DRAFT_SCHEMA_VERSION),
  draftId: z.string().min(1).max(SESSION_DRAFT_ID_MAX_LENGTH),
  pageKey: z.string().min(1),
  pageUrl: z.string().url(),
  pageTitle: z.string(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  status: SessionDraftStatusSchema
});

export const ReaderSessionDraftEnvelopeSchema = SessionDraftEnvelopeMetadataSchema.extend({
  mode: z.literal('reader'),
  payload: ReaderSessionDraftPayloadSchema
});

export const VideoSessionDraftEnvelopeSchema = SessionDraftEnvelopeMetadataSchema.extend({
  mode: z.literal('video'),
  payload: VideoSessionDraftPayloadSchema
});

export const SessionDraftEnvelopeSchema = z.discriminatedUnion('mode', [
  ReaderSessionDraftEnvelopeSchema,
  VideoSessionDraftEnvelopeSchema
]);

export const SessionDraftIndexEntrySchema = z.object({
  key: z.string().min(1),
  draftId: z.string().min(1).max(SESSION_DRAFT_ID_MAX_LENGTH),
  mode: SessionDraftModeSchema,
  pageKey: z.string().min(1),
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  status: SessionDraftStatusSchema,
  ownerContext: SessionDraftOwnerContextSchema.optional()
});

export const SessionDraftIndexSchema = z.object({
  schemaVersion: z.literal(SESSION_DRAFT_SCHEMA_VERSION),
  entries: z.array(SessionDraftIndexEntrySchema)
});

export function createSessionDraftIndex(entries: SessionDraftIndexEntry[] = []): SessionDraftIndex {
  return {
    schemaVersion: SESSION_DRAFT_SCHEMA_VERSION,
    entries
  };
}

export function createSessionDraftIndexEntry(
  envelope: SessionDraftEnvelope
): SessionDraftIndexEntry {
  return {
    key: createSessionDraftStorageKey({
      mode: envelope.mode,
      pageKey: envelope.pageKey,
      draftId: envelope.draftId
    }),
    draftId: envelope.draftId,
    mode: envelope.mode,
    pageKey: envelope.pageKey,
    updatedAt: envelope.updatedAt,
    expiresAt: envelope.expiresAt,
    status: envelope.status,
    ...(envelope.payload.ownerContext ? { ownerContext: envelope.payload.ownerContext } : {})
  };
}

export function measureSessionDraftValueBytes(value: RuntimePropertyValue): number {
  const serialized = JSON.stringify(value);
  return serialized ? textEncoder.encode(serialized).length : 0;
}

function omitUndefinedOptionalFields(value: object): object {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

export function containsDisallowedSessionDraftPayloadValue(
  value: RuntimePropertyValue,
  seen = new WeakSet<object>()
): boolean {
  if (typeof value === 'string') {
    return value.toLowerCase().includes('data:image/');
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return true;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return true;
  }
  if (isRuntimePropertyArray(value)) {
    return value.some((entry) => containsDisallowedSessionDraftPayloadValue(entry, seen));
  }
  if (!isObjectRecord(value)) return false;
  return Object.keys(value).some((key) =>
    containsDisallowedSessionDraftPayloadValue(value[key], seen)
  );
}

function isRuntimePropertyArray(value: RuntimePropertyValue): value is RuntimePropertyValue[] {
  return Array.isArray(value);
}

export function normalizeSessionDraftEnvelopeForSave(
  envelope: SessionDraftEnvelope,
  retentionMs: number
): SessionDraftEnvelope {
  const parsed = SessionDraftEnvelopeSchema.parse(envelope);
  const pageKey = createSessionDraftPageKey(parsed.mode, parsed.pageUrl);
  const retentionExpiresAt = parsed.updatedAt + retentionMs;
  const expiresAt =
    parsed.expiresAt > parsed.updatedAt
      ? Math.min(parsed.expiresAt, retentionExpiresAt)
      : retentionExpiresAt;
  const normalized = {
    ...parsed,
    pageKey,
    expiresAt,
    payload: omitUndefinedOptionalFields(parsed.payload)
  };
  if (!isNormalizedSessionDraftEnvelope(normalized)) {
    throw new Error('SESSION_DRAFT_NORMALIZATION_FAILED');
  }
  return normalized;
}

function isNormalizedSessionDraftEnvelope(value: object): value is SessionDraftEnvelope {
  return SessionDraftEnvelopeSchema.safeParse(value).success;
}

export function pruneSessionDraftIndexEntries(
  entries: SessionDraftIndexEntry[],
  now: number,
  maxEntries: number
): { entries: SessionDraftIndexEntry[]; removedKeys: string[]; dirty: boolean } {
  const sorted = [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
  const unique: SessionDraftIndexEntry[] = [];
  const removedKeys: string[] = [];
  const seenKeys = new Set<string>();

  for (const entry of sorted) {
    if (seenKeys.has(entry.key)) {
      continue;
    }
    seenKeys.add(entry.key);
    unique.push(entry);
  }

  const retained = unique.filter((entry) => {
    if (entry.expiresAt <= now) {
      removedKeys.push(entry.key);
      return false;
    }
    return true;
  });
  const next = [...retained].sort((left, right) => left.updatedAt - right.updatedAt);

  for (let index = 0; index < next.length && next.length > maxEntries; ) {
    if (next[index]?.status === 'active') {
      index += 1;
      continue;
    }
    removedKeys.push(next[index]!.key);
    next.splice(index, 1);
  }
  while (next.length > maxEntries) {
    removedKeys.push(next[0]!.key);
    next.shift();
  }

  next.sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    entries: next,
    removedKeys: Array.from(new Set(removedKeys)),
    dirty: removedKeys.length > 0 || next.length !== entries.length
  };
}
