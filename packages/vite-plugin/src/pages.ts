import type { GuijamMessage } from '@guijam/contracts-ts';

export const GRACE_MS = 20_000;
export const KEEP_FINISHED_MS = 120_000;
export const RELOAD_WINDOW_MS = 10_000;

export interface Timers {
  set: (run: () => void, ms: number) => unknown;
  clear: (timer: unknown) => void;
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class Pages<Client> {
  private readonly pageOf = new Map<Client, string>();
  private readonly clientOf = new Map<string, Client>();
  private readonly runsOf = new Map<string, Set<string>>();
  private readonly ownerOf = new Map<string, string>();
  private readonly leaving = new Map<string, unknown>();
  private readonly pending = new Map<string, Promise<GuijamMessage>>();
  private readonly finished = new Map<string, { reply: GuijamMessage; timer: unknown }>();
  private reloadTimer: unknown;

  constructor(
    private readonly drop: (runId: string) => void,
    private readonly release: (runId: string) => void,
    private readonly timers: Timers = REAL_TIMERS,
  ) {}

  seen(client: Client, pageId: string): void {
    const timer = this.leaving.get(pageId);
    if (timer !== undefined) {
      this.timers.clear(timer);
      this.leaving.delete(pageId);
    }
    this.pageOf.set(client, pageId);
    this.clientOf.set(pageId, client);
  }

  client(runId: string): Client | undefined {
    const pageId = this.ownerOf.get(runId);
    return pageId === undefined ? undefined : this.clientOf.get(pageId);
  }

  started(pageId: string, runId: string, reply: Promise<GuijamMessage>): void {
    const runs = this.runsOf.get(pageId) ?? new Set<string>();
    runs.add(runId);
    this.runsOf.set(pageId, runs);
    this.ownerOf.set(runId, pageId);
    this.pending.set(runId, reply);
    void reply.then(
      (message) => this.finish(runId, message),
      () => this.pending.delete(runId),
    );
  }

  discarded(pageId: string, runId: string): void {
    this.runsOf.get(pageId)?.delete(runId);
    this.ownerOf.delete(runId);
    this.forgetReply(runId);
  }

  async attach(runId: string): Promise<GuijamMessage | undefined> {
    const kept = this.finished.get(runId);
    if (kept) return kept.reply;
    return this.pending.get(runId);
  }

  reloading(): void {
    if (this.reloadTimer !== undefined) this.timers.clear(this.reloadTimer);
    this.reloadTimer = this.timers.set(() => {
      this.reloadTimer = undefined;
    }, RELOAD_WINDOW_MS);
  }

  left(client: Client): void {
    const pageId = this.pageOf.get(client);
    this.pageOf.delete(client);
    if (pageId === undefined || this.clientOf.get(pageId) !== client) return;
    this.clientOf.delete(pageId);
    if (this.reloadTimer === undefined) {
      for (const runId of this.runsOf.get(pageId) ?? []) this.release(runId);
    }
    this.leaving.set(
      pageId,
      this.timers.set(() => this.forget(pageId), GRACE_MS),
    );
  }

  private finish(runId: string, reply: GuijamMessage): void {
    this.pending.delete(runId);
    this.forgetReply(runId);
    this.finished.set(runId, {
      reply,
      timer: this.timers.set(() => this.finished.delete(runId), KEEP_FINISHED_MS),
    });
  }

  private forgetReply(runId: string): void {
    const kept = this.finished.get(runId);
    if (!kept) return;
    this.timers.clear(kept.timer);
    this.finished.delete(runId);
  }

  private forget(pageId: string): void {
    this.leaving.delete(pageId);
    const runs = this.runsOf.get(pageId);
    this.runsOf.delete(pageId);
    for (const runId of runs ?? []) {
      this.ownerOf.delete(runId);
      this.forgetReply(runId);
      this.drop(runId);
    }
  }
}
