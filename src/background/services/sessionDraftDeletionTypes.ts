export interface SessionDraftDeletionRevision {
  draftKey: string;
  revision: number;
}

export interface SessionDraftDeletionRequest {
  operationId: string;
  requestFingerprint: string;
  candidateKeys: readonly string[];
}

export interface SessionDraftDeletionResult {
  epoch: number;
  revisions: SessionDraftDeletionRevision[];
  protectedKeys: string[];
  replayed: boolean;
}

export type SessionDraftDeletionExecutor = (
  request: SessionDraftDeletionRequest
) => Promise<SessionDraftDeletionResult>;

export type SessionDraftDeletionReplay = (
  operationId: string,
  requestFingerprint: string
) => Promise<SessionDraftDeletionResult | null>;
