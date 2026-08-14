import type {
  ExtensionAPI,
  MessageEndEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent
} from "@earendil-works/pi-coding-agent";
import { extractInboundText } from "./inbound.js";
import {
  ClawchatOutputProjector,
  outputTurnFromInbound,
  type OutputTurn,
  type PiOutputEvent
} from "./output-projector.js";
import type { ClawchatOutputMode } from "./output-settings.js";
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
  outputMode: (message: ClawchatInboundMessage) => ClawchatOutputMode;
  now?: () => number;
  idFactory?: () => string;
  tools?: ClawchatToolEnvironment;
}

export interface HostedSessionBinding {
  target: OutputTurn;
  auditSource?: string;
  outputMode: ClawchatOutputMode;
  toolContext: ActiveClawchatTurn;
}

export interface AwarenessTurnBinding extends Omit<HostedSessionBinding, "outputMode" | "target"> {
  target: Extract<OutputTurn, { chatType: "direct" }>;
}
type ActiveHostedSessionBinding =
  | (HostedSessionBinding & { projectOutput: true })
  | (AwarenessTurnBinding & { projectOutput: false });

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
  let active: ActiveHostedSessionBinding | undefined;
  let piApi: ExtensionAPI | undefined;
  let terminalReplySent = false;

  const activate = async (binding: ActiveHostedSessionBinding): Promise<void> => {
    if (active) {
      throw new Error(`A Hosted Session Binding is already active for ${active.target.chatId}`);
    }
    active = binding;
    terminalReplySent = false;
    if (!binding.projectOutput) return;
    try {
      await projector.beginTurn(binding.target);
    } catch (error: unknown) {
      active = undefined;
      throw error;
    }
  };

  const deactivate = async (discardPendingAssistantText: boolean): Promise<void> => {
    if (!active) return;
    if (active.projectOutput && discardPendingAssistantText) {
      projector.discardPendingAssistantText();
    }
    try {
      if (active.projectOutput) await projector.endTurn();
    } finally {
      active = undefined;
      terminalReplySent = false;
    }
  };

  const controller: HeadlessExtensionController = {
    beginTurn: async (message) => {
      if (!piApi) throw new Error("Headless Extension is not initialized");
      const text = extractInboundText(message);
      await activate({
        target: outputTurnFromInbound(message),
        auditSource: message.payload.message_id,
        outputMode: options.outputMode(message),
        toolContext: {
          chatId: message.chat_id,
          chatType: message.chat_type,
          messageId: message.payload.message_id,
          sender: message.sender,
          preview: text
            ? [{ kind: "text", text: text.length > 240 ? `${text.slice(0, 237)}...` : text }]
            : []
        },
        projectOutput: true
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
      await activate({ ...binding, projectOutput: false });
    },
    abortTurn: async () => {
      await deactivate(true);
    },
    isActive: () => active !== undefined
  };

  const handleOutput = async (
    event: MessageEndEvent | ToolExecutionStartEvent | ToolExecutionEndEvent
  ): Promise<void> => {
    if (!active || !active.projectOutput || !piApi) return;
    if (terminalReplySent && (event.type === "message_end" || event.type === "tool_execution_end")) return;
    try {
      await projector.handle(event as PiOutputEvent, active.outputMode);
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
          projector.discardPendingAssistantText();
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
      await deactivate(false);
    });
    pi.on("session_shutdown", async () => {
      await controller.abortTurn();
    });
  };

  return { extension, controller };
}
