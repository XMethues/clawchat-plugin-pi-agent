import { existsSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type SessionMessageEntry
} from "@earendil-works/pi-coding-agent";
import {
  isClawchatAwarenessFrame,
  materializeClawchatGroupIdentity,
  materializeClawchatGroupMemory,
  renderAwarenessPrompt
} from "./clawchat-awareness.js";
import type { ChatSessionMapping, ChatTurn, GatewayStore } from "./gateway-store.js";
import { clawchatMemoryTarget, hasParticipantIds } from "./clawchat-memory.js";
import { createHeadlessClawchatPiExtension } from "./headless-extension.js";
import {
  InboundMediaMaterializer,
  plainInboundTurn,
  type InboundMediaOptions,
  type MaterializedInboundTurn,
  type PiPromptImage
} from "./inbound-media.js";
import type { ChatSessionDriver, ChatSessionFactory } from "./session-registry.js";
import type { ClawchatInboundMessage, ClawchatTransport } from "./types.js";
import type { ClawchatOutputMode } from "./output-settings.js";
import type { ClawchatToolEnvironment } from "./clawchat-tools.js";

const DEFAULT_GROUP_MEMORY_ENRICHMENT_TIMEOUT_MS = 2_000;

type PiSessionSurface = {
  prompt(text: string, options?: { images?: PiPromptImage[] }): Promise<void>;
  sendCustomMessage: AgentSession["sendCustomMessage"];
  getSessionStats?: AgentSession["getSessionStats"];
  abort: AgentSession["abort"];
  dispose: AgentSession["dispose"];
};

type CreateAgentSessionFn = (
  options: CreateAgentSessionOptions
) => Promise<{ session: PiSessionSurface }>;

export interface PiChatSessionFactoryOptions {
  workspace: string;
  agentDir: string;
  store: GatewayStore;
  transport: ClawchatTransport;
  sessionDir?: string;
  outputModeDefault?: ClawchatOutputMode;
  tools: ClawchatToolEnvironment;
  groupMemoryEnrichmentTimeoutMs?: number;
  media?: InboundMediaOptions;
  createAgentSessionFn?: CreateAgentSessionFn;
}

export class PiChatSessionFactory implements ChatSessionFactory {
  private readonly workspace: string;
  private readonly agentDir: string;
  private readonly store: GatewayStore;
  private readonly transport: ClawchatTransport;
  private readonly newSessions = new Map<string, SessionManager>();
  private readonly sessionDir: string | undefined;
  private readonly outputModeDefault: ClawchatOutputMode;
  private readonly tools: ClawchatToolEnvironment;
  private readonly groupMemoryEnrichmentTimeoutMs: number;
  private readonly mediaMaterializer: InboundMediaMaterializer | undefined;
  private readonly createAgentSessionFn: CreateAgentSessionFn;

  constructor(options: PiChatSessionFactoryOptions) {
    this.workspace = realpathSync(options.workspace);
    this.agentDir = options.agentDir;
    this.store = options.store;
    this.transport = options.transport;
    this.sessionDir = options.sessionDir;
    this.outputModeDefault = options.outputModeDefault ?? "normal";
    this.tools = options.tools;
    this.groupMemoryEnrichmentTimeoutMs =
      options.groupMemoryEnrichmentTimeoutMs ?? DEFAULT_GROUP_MEMORY_ENRICHMENT_TIMEOUT_MS;
    if (
      !Number.isFinite(this.groupMemoryEnrichmentTimeoutMs) ||
      this.groupMemoryEnrichmentTimeoutMs <= 0
    ) {
      throw new Error("groupMemoryEnrichmentTimeoutMs must be positive");
    }
    this.mediaMaterializer = options.media
      ? new InboundMediaMaterializer(options.media)
      : undefined;
    this.createAgentSessionFn = options.createAgentSessionFn ?? createAgentSession;
  }

  async cleanupStaleInboundMedia(): Promise<void> {
    await this.mediaMaterializer?.cleanupStaleLeases();
  }

  /**
   * Writes the mandatory group identity and, until it is present, enriches the
   * group memory with authoritative participant ids. Returns whether the group
   * memory now has participant ids (used to skip re-enrichment in later turns).
   */
  private async enrichGroupMemory(
    chatId: string,
    signal: AbortSignal,
    alreadyEnriched: boolean
  ): Promise<boolean> {
    await materializeClawchatGroupIdentity(this.tools.memory, chatId);
    if (signal.aborted) throw new Error("Group memory enrichment was aborted");
    let enriched = alreadyEnriched;
    if (!enriched) {
      const current = await this.tools.memory.read(clawchatMemoryTarget("group", chatId));
      enriched = hasParticipantIds(current.metadata);
    }
    if (enriched) return true;
    try {
      const refreshGeneration = this.tools.memory.beginMetadataRefresh(
        clawchatMemoryTarget("group", chatId)
      );
      const conversationState = await waitForGroupMemoryEnrichment(
        this.tools.api.get(`/v1/conversations/${encodeURIComponent(chatId)}`),
        signal,
        this.groupMemoryEnrichmentTimeoutMs
      );
      if (signal.aborted) throw new Error("Group memory enrichment was aborted");
      await materializeClawchatGroupMemory({
        api: this.tools.api,
        memory: this.tools.memory,
        chatId,
        conversationState,
        requireGroup: true,
        signal,
        refreshGeneration
      });
      const enrichedMemory = await this.tools.memory.read(clawchatMemoryTarget("group", chatId));
      return hasParticipantIds(enrichedMemory.metadata);
    } catch (error: unknown) {
      if (signal.aborted) throw new Error("Group memory enrichment was aborted", { cause: error });
      return enriched;
    }
  }

  createSession(_chatId: string): { sessionId: string; sessionPath: string } {
    const sessionManager = SessionManager.create(this.workspace, this.sessionDir);
    const sessionPath = sessionManager.getSessionFile();
    if (!sessionPath) throw new Error("Pi did not allocate a persisted session path");
    sessionManager.appendCustomEntry("clawchat.chat-session", { chatId: _chatId });
    this.newSessions.set(sessionPath, sessionManager);
    return { sessionId: sessionManager.getSessionId(), sessionPath };
  }

  async inspectSession(mapping: ChatSessionMapping): Promise<{
    name?: string;
    messageCount: number;
  }> {
    const prepared = this.newSessions.get(mapping.sessionPath);
    const manager = prepared ??
      (existsSync(mapping.sessionPath)
        ? SessionManager.open(mapping.sessionPath, this.sessionDir)
        : undefined);
    if (!manager) return { messageCount: 0 };
    const name = manager.getSessionName();
    const messageCount = sessionMessages(manager).length;
    return {
      ...(name ? { name } : {}),
      messageCount
    };
  }

  async deleteSession(mapping: ChatSessionMapping): Promise<void> {
    this.newSessions.delete(mapping.sessionPath);
    rmSync(mapping.sessionPath, { force: true });
  }

  async openSession(mapping: ChatSessionMapping): Promise<ChatSessionDriver> {
    const prepared = this.newSessions.get(mapping.sessionPath);
    this.newSessions.delete(mapping.sessionPath);
    let sessionManager: SessionManager;
    if (prepared) {
      sessionManager = prepared;
    } else if (!existsSync(mapping.sessionPath)) {
      sessionManager = SessionManager.create(this.workspace, this.sessionDir, { id: mapping.sessionId });
      const replacementPath = sessionManager.getSessionFile();
      if (!replacementPath) throw new Error("Pi did not allocate a recovery session path");
      this.store.updateChatSessionPath(mapping.chatId, mapping.sessionId, replacementPath);
    } else {
      sessionManager = SessionManager.open(mapping.sessionPath, this.sessionDir);
    }
    if (sessionManager.getSessionId() !== mapping.sessionId) {
      throw new Error(`Pi session ID mismatch for chat '${mapping.chatId}'`);
    }
    if (realpathSync(sessionManager.getCwd()) !== this.workspace) {
      throw new Error(`Pi session Workspace mismatch for chat '${mapping.chatId}'`);
    }

    const settingsManager = SettingsManager.create(this.workspace, this.agentDir);
    const headless = createHeadlessClawchatPiExtension({
      transport: this.transport,
      outputMode: () =>
        this.store.getOutputModeOverrides()[mapping.chatId] ?? this.outputModeDefault,
      tools: this.tools
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.workspace,
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: [{ name: "clawchat-headless", factory: headless.extension, hidden: true }],
      extensionsOverride: (loaded) => ({
        ...loaded,
        extensions: loaded.extensions.filter((extension) => !isInteractiveClawchatExtension(extension))
      })
    });
    await resourceLoader.reload();
    const { session } = await this.createAgentSessionFn({
      cwd: this.workspace,
      agentDir: this.agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      sessionStartEvent: { type: "session_start", reason: "startup" }
    });
    let activeTurn: {
      materializationAbort: AbortController | undefined;
      completion: Promise<void>;
    } | undefined;
    let groupMemoryEnriched = false;
    const runTrackedTurn = async (
      materializationAbort: AbortController | undefined,
      operation: () => Promise<void>
    ): Promise<void> => {
      const { promise: completion, resolve: complete } = Promise.withResolvers<void>();
      const trackedTurn = { materializationAbort, completion };
      activeTurn = trackedTurn;
      try {
        await operation();
      } finally {
        complete();
        if (activeTurn === trackedTurn) activeTurn = undefined;
      }
    };
    const abortCurrentTurn = async (abortPiWhenIdle: boolean): Promise<void> => {
      const trackedTurn = activeTurn;
      trackedTurn?.materializationAbort?.abort();
      let abortFailed = false;
      let abortFailure: unknown;
      const piAbort =
        trackedTurn || abortPiWhenIdle
          ? Promise.resolve()
              .then(() => session.abort())
              .catch((error: unknown) => {
                abortFailed = true;
                abortFailure = error;
              })
          : Promise.resolve();
      await Promise.all([piAbort, trackedTurn?.completion ?? Promise.resolve()]);
      if (!trackedTurn) {
        try {
          await headless.controller.abortTurn();
        } catch (error: unknown) {
          if (!abortFailed) {
            abortFailed = true;
            abortFailure = error;
          }
        }
      }
      if (abortFailed) throw abortFailure;
    };

    return {
      runTurn: async (turn: ChatTurn) => {
        if (isClawchatAwarenessFrame(turn.frame)) {
          const awarenessFrame = turn.frame;
          await runTrackedTurn(undefined, async () => {
            await headless.controller.beginAwarenessTurn({
              target: { chatId: mapping.chatId, chatType: "direct" },
              auditSource: turn.messageId,
              toolContext: { chatId: mapping.chatId, chatType: "direct" }
            });
            try {
              await session.sendCustomMessage(
                {
                  customType: "clawchat.awareness",
                  content: renderAwarenessPrompt(awarenessFrame),
                  display: false,
                  details: awarenessFrame
                },
                { triggerTurn: true }
              );
            } finally {
              await headless.controller.abortTurn();
            }
          });
          return;
        }

        const message = requireInboundMessage(turn.frame);
        const materializationAbort = new AbortController();
        await runTrackedTurn(materializationAbort, async () => {
          let materialized: MaterializedInboundTurn | undefined;
          if (message.chat_type === "group") {
            groupMemoryEnriched = await this.enrichGroupMemory(
              message.chat_id,
              materializationAbort.signal,
              groupMemoryEnriched
            );
          }
          if (materializationAbort.signal.aborted) {
            throw new Error("Inbound Turn materialization was aborted");
          }
          await headless.controller.beginTurn(message);
          try {
            materialized = this.mediaMaterializer
              ? await this.mediaMaterializer.materialize(message, materializationAbort.signal)
              : plainInboundTurn(message);
            if (materializationAbort.signal.aborted) {
              throw new Error("Inbound media materialization was aborted");
            }
            if (!materialized.prompt) {
              throw new Error(`Turn '${turn.id}' has no supported text or image content`);
            }
            await session.prompt(
              materialized.prompt,
              materialized.images.length > 0 ? { images: materialized.images } : undefined
            );
          } finally {
            try {
              await materialized?.release();
            } finally {
              await headless.controller.abortTurn();
            }
          }
        });
      },
      getInfo: async () => {
        const stats = session.getSessionStats?.();
        const name = sessionManager.getSessionName();
        if (stats) {
          return {
            ...(name ? { name } : {}),
            sessionId: stats.sessionId,
            userMessages: stats.userMessages,
            assistantMessages: stats.assistantMessages,
            toolCalls: stats.toolCalls,
            toolResults: stats.toolResults,
            totalMessages: stats.totalMessages,
            tokens: stats.tokens,
            cost: stats.cost
          };
        }
        const messages = sessionMessages(sessionManager);
        return {
          ...(name ? { name } : {}),
          sessionId: mapping.sessionId,
          userMessages: messages.filter((message) => message.role === "user").length,
          assistantMessages: messages.filter((message) => message.role === "assistant").length,
          toolCalls: 0,
          toolResults: messages.filter((message) => message.role === "toolResult").length,
          totalMessages: messages.length,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0
        };
      },
      abort: async () => {
        await abortCurrentTurn(true);
      },
      dispose: async () => {
        try {
          await abortCurrentTurn(false);
        } finally {
          await session.dispose();
        }
      }
    };
  }

}

function sessionMessages(manager: SessionManager): SessionMessageEntry["message"][] {
  return manager
    .getEntries()
    .filter((entry): entry is SessionMessageEntry => entry.type === "message")
    .map((entry) => entry.message);
}

async function waitForGroupMemoryEnrichment<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Group memory enrichment was aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => reject(new Error(`Group memory enrichment timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function requireInboundMessage(frame: unknown): ClawchatInboundMessage {
  if (!frame || typeof frame !== "object") throw new Error("Chat Turn frame is not an object");
  const message = frame as Partial<ClawchatInboundMessage>;
  if (
    (message.event !== "message.send" && message.event !== "message.reply") ||
    typeof message.chat_id !== "string" ||
    typeof message.payload?.message_id !== "string" ||
    !Array.isArray(message.payload.message?.body?.fragments)
  ) {
    throw new Error("Chat Turn does not contain a valid materialized ClawChat message");
  }
  return message as ClawchatInboundMessage;
}

const INTERACTIVE_CLAWCHAT_EXTENSION_PATH = fileURLToPath(
  new URL("./extension.js", import.meta.url)
).replaceAll("\\", "/");

export function isInteractiveClawchatExtension(extension: { path: string; resolvedPath: string }): boolean {
  return [extension.path, extension.resolvedPath]
    .map((path) => path.replaceAll("\\", "/"))
    .includes(INTERACTIVE_CLAWCHAT_EXTENSION_PATH);
}
