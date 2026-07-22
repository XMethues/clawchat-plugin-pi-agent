import type { ChatSessionRecord, ChatTurn, GatewayStore } from "./gateway-store.js";

export interface ChatSessionDriver {
  runTurn(turn: ChatTurn): Promise<void>;
  abort?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ChatSessionFactory {
  createSession(chatId: string): { sessionId: string; sessionPath: string };
  openSession(mapping: ChatSessionRecord): Promise<ChatSessionDriver>;
}

export interface ChatSessionRegistryOptions {
  store: GatewayStore;
  factory: ChatSessionFactory;
  onError?: (error: unknown, turn: ChatTurn) => void;
  onWorkerError?: (error: unknown, chatId: string) => void;
}

interface ChatWorker {
  notified: boolean;
  promise: Promise<void>;
}

export class ChatSessionRegistry {
  private readonly store: GatewayStore;
  private readonly factory: ChatSessionFactory;
  private readonly onError: ((error: unknown, turn: ChatTurn) => void) | undefined;
  private readonly onWorkerError: ((error: unknown, chatId: string) => void) | undefined;
  private readonly runtimes = new Map<string, Promise<ChatSessionDriver>>();
  private readonly workers = new Map<string, ChatWorker>();
  private readonly activeTurns = new Map<string, ChatTurn>();
  private readonly forcedInterrupts = new Set<string>();
  private stopping = false;
  private started = false;

  constructor(options: ChatSessionRegistryOptions) {
    this.store = options.store;
    this.factory = options.factory;
    this.onError = options.onError;
    this.onWorkerError = options.onWorkerError;
  }

  async start(): Promise<{ interruptedTurnIds: string[] }> {
    if (this.started) throw new Error("Chat Session Registry has already started");
    this.started = true;
    const recovery = this.store.recoverAfterRestart();
    for (const chatId of this.store.listQueuedChatIds()) {
      void this.wake(chatId).catch((error: unknown) => this.onWorkerError?.(error, chatId));
    }
    return recovery;
  }

  wake(chatId: string): Promise<void> {
    if (this.stopping) throw new Error("Chat Session Registry is shutting down");
    const active = this.workers.get(chatId);
    if (active) {
      active.notified = true;
      return active.promise;
    }

    const worker: ChatWorker = { notified: false, promise: Promise.resolve() };
    worker.promise = this.drain(chatId, worker).finally(() => {
      this.workers.delete(chatId);
    });
    this.workers.set(chatId, worker);
    return worker.promise;
  }

  async shutdown(options: { graceMs?: number } = {}): Promise<void> {
    this.stopping = true;
    const workerPromises = [...this.workers.values()].map((worker) => worker.promise);
    const settled = await settlesWithin(workerPromises, options.graceMs ?? 30_000);
    if (!settled) {
      for (const turn of this.activeTurns.values()) {
        this.forcedInterrupts.add(turn.id);
        this.store.interruptTurn(turn.id);
      }
      const activeRuntimes = await Promise.allSettled(this.runtimes.values());
      await Promise.allSettled(
        activeRuntimes
          .filter((result): result is PromiseFulfilledResult<ChatSessionDriver> => result.status === "fulfilled")
          .map((result) => result.value.abort?.())
          .filter((operation): operation is Promise<void> => operation !== undefined)
      );
      await Promise.allSettled(workerPromises);
    }
    const runtimes = await Promise.allSettled(this.runtimes.values());
    await Promise.all(
      runtimes
        .filter((result): result is PromiseFulfilledResult<ChatSessionDriver> => result.status === "fulfilled")
        .map((result) => result.value.dispose())
    );
    this.runtimes.clear();
  }

  private async drain(chatId: string, worker: ChatWorker): Promise<void> {
    const runtime = await this.getOrCreateRuntime(chatId);
    do {
      worker.notified = false;
      let turn: ChatTurn | null;
      while (!this.stopping && (turn = this.store.claimNextTurn(chatId))) {
        this.activeTurns.set(chatId, turn);
        try {
          await runtime.runTurn(turn);
          if (!this.forcedInterrupts.has(turn.id)) this.store.completeTurn(turn.id);
        } catch (error: unknown) {
          if (!this.forcedInterrupts.has(turn.id)) this.store.interruptTurn(turn.id);
          this.onError?.(error, turn);
        } finally {
          this.activeTurns.delete(chatId);
          this.forcedInterrupts.delete(turn.id);
        }
      }
    } while (!this.stopping && worker.notified);
  }

  private getOrCreateRuntime(chatId: string): Promise<ChatSessionDriver> {
    const existing = this.runtimes.get(chatId);
    if (existing) return existing;
    const mapping = this.store.getOrCreateChatSession(chatId, () => this.factory.createSession(chatId));
    const runtime = this.factory.openSession(mapping);
    this.runtimes.set(chatId, runtime);
    return runtime;
  }
}

async function settlesWithin(promises: Promise<unknown>[], milliseconds: number): Promise<boolean> {
  if (promises.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, milliseconds));
  });
  const settled = Promise.allSettled(promises).then(() => true as const);
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
