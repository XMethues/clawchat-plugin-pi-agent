import { existsSync, realpathSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
import type { ChatSessionRecord, ChatTurn, GatewayStore } from "./gateway-store.js";
import { createHeadlessClawchatPiExtension } from "./headless-extension.js";
import { renderInboundPrompt } from "./inbound.js";
import type { ChatSessionDriver, ChatSessionFactory } from "./session-registry.js";
import type { ClawchatInboundMessage, ClawchatTransport } from "./types.js";

export interface PiChatSessionFactoryOptions {
  workspace: string;
  agentDir: string;
  store: GatewayStore;
  transport: ClawchatTransport;
  sessionDir?: string;
  toolCallsDefault?: "on" | "off";
}

export class PiChatSessionFactory implements ChatSessionFactory {
  private readonly workspace: string;
  private readonly agentDir: string;
  private readonly store: GatewayStore;
  private readonly transport: ClawchatTransport;
  private readonly newSessions = new Map<string, SessionManager>();
  private readonly sessionDir: string | undefined;
  private readonly toolCallsDefault: "on" | "off";

  constructor(options: PiChatSessionFactoryOptions) {
    this.workspace = realpathSync(options.workspace);
    this.agentDir = options.agentDir;
    this.store = options.store;
    this.transport = options.transport;
    this.sessionDir = options.sessionDir;
    this.toolCallsDefault = options.toolCallsDefault ?? "off";
  }

  createSession(_chatId: string): { sessionId: string; sessionPath: string } {
    const sessionManager = SessionManager.create(this.workspace, this.sessionDir);
    const sessionPath = sessionManager.getSessionFile();
    if (!sessionPath) throw new Error("Pi did not allocate a persisted session path");
    sessionManager.appendCustomEntry("clawchat.chat-session", { chatId: _chatId });
    this.newSessions.set(sessionPath, sessionManager);
    return { sessionId: sessionManager.getSessionId(), sessionPath };
  }

  async openSession(mapping: ChatSessionRecord): Promise<ChatSessionDriver> {
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
      toolsVisible: () => {
        const override = this.store.getToolOutputOverrides()[mapping.chatId];
        return (override ?? this.toolCallsDefault) === "on";
      }
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
    const { session } = await createAgentSession({
      cwd: this.workspace,
      agentDir: this.agentDir,
      sessionManager,
      settingsManager,
      resourceLoader,
      sessionStartEvent: { type: "session_start", reason: "startup" }
    });

    return {
      runTurn: async (turn: ChatTurn) => {
        const message = requireInboundMessage(turn.frame);
        const prompt = renderInboundPrompt(message);
        if (!prompt) throw new Error(`Turn '${turn.id}' has no supported text content`);
        await headless.controller.beginTurn(message);
        try {
          await session.prompt(prompt);
        } finally {
          await headless.controller.abortTurn();
        }
      },
      abort: async () => {
        await session.abort();
        await headless.controller.abortTurn();
      },
      dispose: async () => {
        await headless.controller.abortTurn();
        session.dispose();
      }
    };
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

function isInteractiveClawchatExtension(extension: { path: string; resolvedPath: string }): boolean {
  const paths = [extension.path, extension.resolvedPath].map((path) => path.replaceAll("\\", "/"));
  return paths.some(
    (path) =>
      path.endsWith("/clawchat-plugin-pi-agent/dist/src/extension.js") ||
      (path.includes("/@newbase-clawchat/clawchat-pi/") && path.endsWith("/dist/src/extension.js"))
  );
}
