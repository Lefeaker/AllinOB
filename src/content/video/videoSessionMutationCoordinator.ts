import { runSessionMutationTransaction } from '../sessionDrafts';
import type { VideoCaptureMutationTransaction } from './videoCaptureMutationTypes';
import type { VideoSessionMutationPort } from './videoSessionRuntimePorts';

interface SavingStateOwner {
  saving: boolean;
}

export class VideoSessionMutationCoordinator implements VideoSessionMutationPort {
  private tail = Promise.resolve<void>(undefined);
  private pendingCaptureMutations = 0;

  constructor(private readonly state: SavingStateOwner) {}

  private enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async track<Result>(task: () => Promise<Result>): Promise<Result> {
    this.pendingCaptureMutations += 1;
    this.state.saving = true;
    try {
      return await this.enqueue(task);
    } finally {
      this.pendingCaptureMutations = Math.max(0, this.pendingCaptureMutations - 1);
      this.state.saving = this.pendingCaptureMutations > 0;
    }
  }

  hasPendingMutations(): boolean {
    return this.pendingCaptureMutations > 0;
  }

  runExclusive<Result>(task: () => Promise<Result>): Promise<Result> {
    return this.track(task);
  }

  runCaptureMutation<Result>(
    transaction: VideoCaptureMutationTransaction<Result>
  ): Promise<boolean> {
    return this.track(() =>
      runSessionMutationTransaction({
        ...transaction,
        isSaveFailure: (saveHint) => saveHint === 'failure'
      })
    );
  }
}
