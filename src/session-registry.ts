import type {
  ChatSessionRecord,
  ChatSessionMapping,
  ChatTurn,
  ConversationWork,
  GatewayStore
} from "./gateway-store.js";
import type { ClawchatInboundMessage } from "./types.js";

export interface ChatSessionInfo {
  name?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

export interface ChatSessionSummary {
  name?: string;
  messageCount: number;
}

export interface ChatSessionDriver {
  runTurn(turn: ChatTurn): Promise<void>;
  getInfo(): Promise<ChatSessionInfo>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ChatSessionFactory {
  createSession(chatId: string): { sessionId: string; sessionPath: string };
  openSession(mapping: ChatSessionMapping): Promise<ChatSessionDriver>;
  inspectSession(mapping: ChatSessionMapping): Promise<ChatSessionSummary>;
  deleteSession(mapping: ChatSessionMapping): Promise<void>;
}

export interface ChatSessionRegistryOptions {
  store: GatewayStore;
  factory: ChatSessionFactory;
  reply: (message: ClawchatInboundMessage, text: string) => Promise<void>;
  resumePageSize?: number;
  onError?: (error: unknown, work: ConversationWork) => void;
  onWorkerError?: (error: unknown, chatId: string) => void;
}

interface ChatWorker {
  notified: boolean;
  promise: Promise<void>;
}

interface RuntimeEntry {
  sessionId: string;
  driver: Promise<ChatSessionDriver>;
}

export class ChatSessionRegistry {
  private readonly store: GatewayStore;
  private readonly factory: ChatSessionFactory;
  private readonly reply: ChatSessionRegistryOptions["reply"];
  private readonly resumePageSize: number;
  private readonly onError: ((error: unknown, work: ConversationWork) => void) | undefined;
  private readonly onWorkerError: ((error: unknown, chatId: string) => void) | undefined;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly workers = new Map<string, ChatWorker>();
  private readonly activeWork = new Map<string, ConversationWork>();
  private readonly forcedInterrupts = new Set<string>();
  private readonly deleting = new Set<string>();
  private stopping = false;
  private started = false;

  constructor(options: ChatSessionRegistryOptions) {
    this.store = options.store;
    this.factory = options.factory;
    this.reply = options.reply;
    this.resumePageSize = options.resumePageSize ?? 10;
    if (!Number.isSafeInteger(this.resumePageSize) || this.resumePageSize < 1) {
      throw new Error("resumePageSize must be a positive integer");
    }
    this.onError = options.onError;
    this.onWorkerError = options.onWorkerError;
  }

  start(): { interruptedWorkIds: string[] } {
    if (this.started) throw new Error("Chat Session Registry has already started");
    this.started = true;
    const recovery = this.store.recoverAfterRestart();
    for (const chatId of this.store.listQueuedConversationIds()) {
      void this.wake(chatId).catch((error: unknown) => this.onWorkerError?.(error, chatId));
    }
    return recovery;
  }

  ensureConversation(chatId: string): ChatSessionRecord {
    if (this.stopping) throw new Error("Chat Session Registry is shutting down");
    return this.store.ensureConversationSessionSet(chatId, () => this.factory.createSession(chatId));
  }

  wake(chatId: string): Promise<void> {
    if (this.stopping) throw new Error("Chat Session Registry is shutting down");
    if (this.deleting.has(chatId)) throw new Error(`Conversation '${chatId}' is being deleted`);
    this.ensureConversation(chatId);
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

  async stop(chatId: string): Promise<{ interrupted: boolean }> {
    const work = this.activeWork.get(chatId);
    if (!work) return { interrupted: false };
    this.forcedInterrupts.add(work.id);
    this.store.interruptWork(work.id);
    const runtime = this.runtimes.get(chatId);
    if (runtime) await (await runtime.driver).abort();
    return { interrupted: true };
  }

  async deleteConversation(chatId: string): Promise<number> {
    this.deleting.add(chatId);
    const cancelled = this.store.cancelQueuedWork(chatId);
    try {
      await this.stop(chatId);
      await this.workers.get(chatId)?.promise;
      await this.disposeRuntime(chatId);
      const sessions = this.store.deleteConversationSessionSet(chatId);
      await Promise.all(sessions.map((session) => this.factory.deleteSession(session)));
      return cancelled;
    } finally {
      this.deleting.delete(chatId);
    }
  }

  async shutdown(options: { graceMs?: number } = {}): Promise<void> {
    this.stopping = true;
    const workerPromises = [...this.workers.values()].map((worker) => worker.promise);
    const settled = await settlesWithin(workerPromises, options.graceMs ?? 30_000);
    if (!settled) {
      for (const work of this.activeWork.values()) {
        this.forcedInterrupts.add(work.id);
        this.store.interruptWork(work.id);
      }
      await Promise.allSettled(
        [...this.runtimes.values()].map(async (runtime) => (await runtime.driver).abort())
      );
      await Promise.allSettled(workerPromises);
    }
    await Promise.all([...this.runtimes.keys()].map((chatId) => this.disposeRuntime(chatId)));
  }

  private async drain(chatId: string, worker: ChatWorker): Promise<void> {
    do {
      worker.notified = false;
      let work: ConversationWork | null;
      while (
        !this.stopping &&
        !this.deleting.has(chatId) &&
        (work = this.store.claimNextWork(chatId))
      ) {
        this.activeWork.set(chatId, work);
        try {
          if (work.command === null) {
            const mapping = this.requireActiveSession(chatId);
            this.store.markChatSessionUsed(chatId, mapping.sessionId);
            const runtime = await this.getOrOpenRuntime(mapping);
            if (this.forcedInterrupts.has(work.id)) continue;
            await runtime.runTurn(work as ChatTurn);
          } else {
            await this.runSessionCommand(work);
          }
          if (!this.forcedInterrupts.has(work.id)) this.store.completeWork(work.id);
        } catch (error: unknown) {
          if (!this.forcedInterrupts.has(work.id)) this.store.interruptWork(work.id);
          if (work.command !== null && !this.forcedInterrupts.has(work.id)) {
            await this.replyCommandError(work, error);
          }
          this.onError?.(error, work);
        } finally {
          this.activeWork.delete(chatId);
          this.forcedInterrupts.delete(work.id);
        }
      }
    } while (!this.stopping && !this.deleting.has(chatId) && worker.notified);
  }

  private async runSessionCommand(work: ConversationWork): Promise<void> {
    const message = work.frame as ClawchatInboundMessage;
    const command = work.command!;
    if (command.type === "new") {
      const transition = this.store.createAndActivateChatSession(
        work.chatId,
        () => this.factory.createSession(work.chatId)
      );
      await this.disposeRuntime(work.chatId);
      if (transition.replacedEmpty) {
        await this.factory.deleteSession(transition.replacedEmpty);
      }
      await this.reply(message, `New session started: ${transition.session.sessionId}`);
      return;
    }
    if (command.type === "session") {
      const mapping = this.requireActiveSession(work.chatId);
      const info = await (await this.getOrOpenRuntime(mapping)).getInfo();
      await this.reply(message, formatSessionInfo(info));
      return;
    }
    if (command.type === "resume-list") {
      await this.reply(message, await this.formatResumePage(work.chatId, command.page));
      return;
    }

    const target = this.store.getChatSession(work.chatId, command.sessionId);
    if (!target) {
      await this.reply(message, `Session not found in this chat: ${command.sessionId}`);
      return;
    }
    if (target.active) {
      await this.reply(message, `Session already active: ${target.sessionId}`);
      return;
    }
    const transition = this.store.activateChatSession(work.chatId, target.sessionId);
    await this.disposeRuntime(work.chatId);
    if (transition.replacedEmpty) {
      await this.factory.deleteSession(transition.replacedEmpty);
    }
    await this.reply(message, `Session resumed: ${transition.session.sessionId}`);
  }

  private async formatResumePage(chatId: string, page: number): Promise<string> {
    const active = this.requireActiveSession(chatId);
    const history = this.store
      .listChatSessions(chatId)
      .filter((session) => !session.active && session.lastUsedAt !== null);
    if (history.length === 0) {
      return `Active session: ${active.sessionId}\nNo previous sessions in this chat.`;
    }
    const pages = Math.ceil(history.length / this.resumePageSize);
    if (page > pages) {
      return `Resume page ${page} does not exist. Available pages: 1-${pages}.`;
    }
    const start = (page - 1) * this.resumePageSize;
    const entries = history.slice(start, start + this.resumePageSize);
    const summaries = await Promise.all(entries.map((entry) => this.factory.inspectSession(entry)));
    const lines = entries.map((entry, index) => {
      const summary = summaries[index]!;
      const name = summary.name ? ` | name ${summary.name}` : "";
      return `- ${entry.sessionId}${name} | created ${new Date(entry.createdAt).toISOString()} | last active ${new Date(entry.lastUsedAt!).toISOString()} | messages ${summary.messageCount}`;
    });
    return [
      `Active session: ${active.sessionId}`,
      `Previous sessions (page ${page}/${pages}):`,
      ...lines,
      "Use /resume <session-id> to switch."
    ].join("\n");
  }

  private requireActiveSession(chatId: string): ChatSessionRecord {
    const mapping = this.store.getActiveChatSession(chatId);
    if (!mapping) throw new Error(`Conversation Session Set '${chatId}' does not exist`);
    return mapping;
  }

  private async getOrOpenRuntime(mapping: ChatSessionRecord): Promise<ChatSessionDriver> {
    const existing = this.runtimes.get(mapping.chatId);
    if (existing?.sessionId === mapping.sessionId) return existing.driver;
    if (existing) await this.disposeRuntime(mapping.chatId);
    const driver = this.factory.openSession(mapping);
    this.runtimes.set(mapping.chatId, { sessionId: mapping.sessionId, driver });
    return driver;
  }

  private async disposeRuntime(chatId: string): Promise<void> {
    const runtime = this.runtimes.get(chatId);
    if (!runtime) return;
    this.runtimes.delete(chatId);
    await (await runtime.driver).dispose();
  }

  private async replyCommandError(work: ConversationWork, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.reply(work.frame as ClawchatInboundMessage, `Session command failed: ${message}`).catch(
      () => undefined
    );
  }
}

function formatSessionInfo(info: ChatSessionInfo): string {
  const promptTokens = info.tokens.input + info.tokens.cacheRead + info.tokens.cacheWrite;
  return [
    "Session Info",
    ...(info.name ? [`Name: ${info.name}`] : []),
    `ID: ${info.sessionId}`,
    `Messages: total ${info.totalMessages}; user ${info.userMessages}; assistant ${info.assistantMessages}`,
    `Tools: ${info.toolCalls} calls; ${info.toolResults} results`,
    `Tokens: input ${promptTokens}; output ${info.tokens.output}; total ${info.tokens.total}`,
    `Cost: $${info.cost.toFixed(3)}`
  ].join("\n");
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
