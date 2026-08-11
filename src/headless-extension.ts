import type {
  ExtensionAPI,
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent
} from "@earendil-works/pi-coding-agent";
import {
  ClawchatOutputProjector,
  outputTurnFromInbound,
  type PiOutputEvent
} from "./output-projector.js";
import type { ClawchatInboundMessage, ClawchatTransport } from "./types.js";
import {
  appendClawchatMemoryPrompt,
  appendClawchatSystemPrompt,
  registerClawchatTools,
  uploadClawchatMediaFile,
  type ClawchatToolEnvironment
} from "./clawchat-tools.js";

export interface HeadlessClawchatPiExtensionOptions {
  transport: ClawchatTransport;
  toolsVisible: (message: ClawchatInboundMessage) => boolean;
  now?: () => number;
  idFactory?: () => string;
  tools?: ClawchatToolEnvironment;
}

export interface HeadlessExtensionController {
  beginTurn(message: ClawchatInboundMessage): Promise<void>;
  abortTurn(): Promise<void>;
  isActive(): boolean;
}

export function createHeadlessClawchatPiExtension(options: HeadlessClawchatPiExtensionOptions): {
  extension: (pi: ExtensionAPI) => void;
  controller: HeadlessExtensionController;
} {
  const projector = new ClawchatOutputProjector({
    transport: options.transport,
    ...(options.tools
      ? { uploadMedia: (filePath: string) => uploadClawchatMediaFile(options.tools!.api, filePath) }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {})
  });
  let active: ClawchatInboundMessage | undefined;
  let piApi: ExtensionAPI | undefined;
  let terminalReplySent = false;

  const controller: HeadlessExtensionController = {
    beginTurn: async (message) => {
      if (active) throw new Error(`A Headless Extension turn is already active for ${active.chat_id}`);
      active = message;
      terminalReplySent = false;
      try {
        await projector.beginTurn(outputTurnFromInbound(message));
      } catch (error: unknown) {
        active = undefined;
        throw error;
      }
    },
    abortTurn: async () => {
      if (!active) return;
      try {
        await projector.endTurn();
      } finally {
        active = undefined;
        terminalReplySent = false;
      }
    },
    isActive: () => active !== undefined
  };

  const handleOutput = async (
    event: MessageEndEvent | ToolExecutionStartEvent | ToolExecutionEndEvent
  ): Promise<void> => {
    if (!active || !piApi) return;
    if (terminalReplySent && (event.type === "message_end" || event.type === "tool_execution_end")) return;
    await projector.handle(event as PiOutputEvent, {
      thinking: piApi.getThinkingLevel() !== "off",
      tools: options.toolsVisible(active)
    });
  };

  const extension = (pi: ExtensionAPI): void => {
    piApi = pi;
    if (options.tools) {
      registerClawchatTools(pi, {
        ...options.tools,
        activeTurn: () =>
          active
            ? {
                chatId: active.chat_id,
                chatType: active.chat_type,
                messageId: active.payload.message_id
              }
            : undefined,
        recordToolCall: (record) =>
          options.tools?.recordToolCall?.({
            ...record,
            ...(active ? { chatId: active.chat_id, messageId: active.payload.message_id } : {})
          }),
        onTerminalSend: () => {
          terminalReplySent = true;
        }
      });
    }
    pi.on("before_agent_start", async (event) => {
      let systemPrompt = appendClawchatSystemPrompt(event.systemPrompt);
      if (active && options.tools) {
        systemPrompt = await appendClawchatMemoryPrompt(systemPrompt, options.tools.memory, {
          chatId: active.chat_id,
          chatType: active.chat_type
        });
      }
      return { systemPrompt };
    });
    pi.on("message_end", handleOutput);
    pi.on("tool_execution_start", handleOutput);
    pi.on("tool_execution_end", handleOutput);
    pi.on("agent_settled", async () => {
      await controller.abortTurn();
    });
    pi.on("session_shutdown", async () => {
      await controller.abortTurn();
    });
  };

  return { extension, controller };
}
