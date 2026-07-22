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

export interface HeadlessClawchatPiExtensionOptions {
  transport: ClawchatTransport;
  toolsVisible: (message: ClawchatInboundMessage) => boolean;
  now?: () => number;
  idFactory?: () => string;
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
    ...(options.now ? { now: options.now } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {})
  });
  let active: ClawchatInboundMessage | undefined;
  let piApi: ExtensionAPI | undefined;

  const controller: HeadlessExtensionController = {
    beginTurn: async (message) => {
      if (active) throw new Error(`A Headless Extension turn is already active for ${active.chat_id}`);
      active = message;
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
      }
    },
    isActive: () => active !== undefined
  };

  const handleOutput = async (
    event: MessageEndEvent | ToolExecutionStartEvent | ToolExecutionEndEvent
  ): Promise<void> => {
    if (!active || !piApi) return;
    await projector.handle(event as PiOutputEvent, {
      thinking: piApi.getThinkingLevel() !== "off",
      tools: options.toolsVisible(active)
    });
  };

  const extension = (pi: ExtensionAPI): void => {
    piApi = pi;
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
