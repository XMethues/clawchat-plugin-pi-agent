import type {
  ExtensionAPI,
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent
} from "@earendil-works/pi-coding-agent";
import {
  ClawchatOutputProjector,
  outputTurnFromInbound,
  type OutputTurn,
  type OutputVisibility,
  type PiOutputEvent
} from "./output-projector.js";
import type { ClawchatInboundMessage, ClawchatTransport } from "./types.js";
import {
  appendClawchatMemoryPrompt,
  appendClawchatSystemPrompt,
  registerClawchatTools,
  uploadClawchatMediaFile,
  type ActiveClawchatTurn,
  type ClawchatToolEnvironment
} from "./clawchat-tools.js";

export interface HeadlessClawchatPiExtensionOptions {
  transport: ClawchatTransport;
  toolsVisible: (message: ClawchatInboundMessage) => boolean;
  now?: () => number;
  idFactory?: () => string;
  tools?: ClawchatToolEnvironment;
}

export interface HostedSessionBinding {
  target: OutputTurn;
  auditSource?: string;
  outputVisibility: OutputVisibility;
  toolContext: ActiveClawchatTurn;
}

export interface AwarenessTurnBinding extends Omit<HostedSessionBinding, "target"> {
  target: Extract<OutputTurn, { chatType: "direct" }>;
}

export interface HeadlessExtensionController {
  beginTurn(message: ClawchatInboundMessage): Promise<void>;
  beginAwarenessTurn(binding: AwarenessTurnBinding): Promise<void>;
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
  let active: HostedSessionBinding | undefined;
  let piApi: ExtensionAPI | undefined;
  let terminalReplySent = false;

  const activate = async (binding: HostedSessionBinding): Promise<void> => {
    if (active) {
      throw new Error(`A Hosted Session Binding is already active for ${active.target.chatId}`);
    }
    active = binding;
    terminalReplySent = false;
    try {
      await projector.beginTurn(binding.target);
    } catch (error: unknown) {
      active = undefined;
      throw error;
    }
  };

  const controller: HeadlessExtensionController = {
    beginTurn: async (message) => {
      if (!piApi) throw new Error("Headless Extension is not initialized");
      await activate({
        target: outputTurnFromInbound(message),
        auditSource: message.payload.message_id,
        outputVisibility: {
          thinking: piApi.getThinkingLevel() !== "off",
          tools: options.toolsVisible(message)
        },
        toolContext: {
          chatId: message.chat_id,
          chatType: message.chat_type,
          messageId: message.payload.message_id
        }
      });
    },
    beginAwarenessTurn: async (binding) => {
      if (!piApi) throw new Error("Headless Extension is not initialized");
      if (binding.toolContext.chatId !== binding.target.chatId) {
        throw new Error("Awareness tool context must target the owner direct Chat Session");
      }
      if (binding.toolContext.chatType !== "direct") {
        throw new Error("Awareness tool context must be direct");
      }
      await activate(binding);
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
    try {
      await projector.handle(event as PiOutputEvent, active.outputVisibility);
    } catch (error: unknown) {
      try {
        await controller.abortTurn();
      } catch {
        // Preserve the materialization failure while still clearing the binding in abortTurn's finally.
      }
      throw error;
    }
  };

  const extension = (pi: ExtensionAPI): void => {
    piApi = pi;
    if (options.tools) {
      registerClawchatTools(pi, {
        ...options.tools,
        activeTurn: () => active?.toolContext,
        recordToolCall: (record) =>
          options.tools?.recordToolCall?.({
            ...record,
            ...(active
              ? {
                  chatId: active.toolContext.chatId,
                  ...(active.auditSource ? { auditSource: active.auditSource } : {}),
                  ...(active.toolContext.messageId
                    ? { messageId: active.toolContext.messageId }
                    : {})
                }
              : {})
          }),
        onTerminalSend: () => {
          terminalReplySent = true;
        }
      });
    }
    pi.on("before_agent_start", async (event) => {
      let systemPrompt = appendClawchatSystemPrompt(event.systemPrompt);
      if (active && options.tools) {
        systemPrompt = await appendClawchatMemoryPrompt(
          systemPrompt,
          options.tools.memory,
          active.toolContext
        );
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
