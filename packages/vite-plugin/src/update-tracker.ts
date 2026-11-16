import type { UpdateResult } from '@gui-jam/contracts-ts';

const STATUSES: ReadonlySet<string> = new Set<UpdateResult['status']>([
  'ok',
  'compile_error',
  'runtime_error',
  'full_reload',
  'timeout',
]);

export function isUpdateResult(value: unknown): value is UpdateResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.updateId === 'string' &&
    typeof candidate.status === 'string' &&
    STATUSES.has(candidate.status) &&
    typeof candidate.latencyMs === 'number' &&
    Array.isArray(candidate.errors)
  );
}

export interface UpdateTracker {
  begin(updateId: string): Promise<UpdateResult>;
  settle(result: UpdateResult): void;
}

export function createUpdateTracker(timeoutMs: number): UpdateTracker {
  const pending = new Map<string, (result: UpdateResult) => void>();

  return {
    begin(updateId) {
      return new Promise((resolve) => {
        const startedAt = performance.now();
        const timer = setTimeout(() => {
          pending.delete(updateId);
          resolve({
            updateId,
            status: 'timeout',
            latencyMs: performance.now() - startedAt,
            errors: [],
          });
        }, timeoutMs);
        pending.set(updateId, (result) => {
          clearTimeout(timer);
          pending.delete(updateId);
          resolve(result);
        });
      });
    },
    settle(result) {
      pending.get(result.updateId)?.(result);
    },
  };
}
