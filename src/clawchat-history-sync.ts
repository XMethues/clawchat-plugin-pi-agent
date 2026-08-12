import type { GatewayStore, HistoryTransferState } from "./gateway-store.js";
import type { ClawchatGatewayEvent } from "./gateway.js";

interface HistoryApi {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

export interface ClawchatPlaintextHistorySyncOptions {
  api: HistoryApi;
  store: GatewayStore;
  deviceId: string;
  userId: string;
  send(frame: unknown): Promise<void>;
  createTraceId?: () => string;
  now?: () => number;
  pageSize?: number;
}

interface HistoryMessage extends Record<string, unknown> {
  id: string;
}

export class ClawchatPlaintextHistorySync {
  private readonly api: HistoryApi;
  private readonly store: GatewayStore;
  private readonly deviceId: string;
  private readonly userId: string;
  private readonly send: (frame: unknown) => Promise<void>;
  private readonly createTraceId: () => string;
  private readonly now: () => number;
  private readonly pageSize: number;

  constructor(options: ClawchatPlaintextHistorySyncOptions) {
    this.api = options.api;
    this.store = options.store;
    this.deviceId = requireNonEmpty(options.deviceId, "deviceId");
    this.userId = requireNonEmpty(options.userId, "userId");
    this.send = options.send;
    this.createTraceId = options.createTraceId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
    this.pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 100) {
      throw new Error("pageSize must be an integer between 1 and 100");
    }
  }

  async handle(event: ClawchatGatewayEvent): Promise<void> {
    if (event.event !== "history.transit") return;
    if (event.target_device_id && event.target_device_id !== this.deviceId) return;
    const sourceId = requireNonEmpty(event.trace_id, "trace_id");
    if (this.store.isHistorySourceProcessed(sourceId)) return;
    const payload = requireRecord(event.payload, "history.transit payload");
    const payloadSource =
      typeof payload.source_device_id === "string" && payload.source_device_id.trim() !== ""
        ? payload.source_device_id
        : undefined;
    const envelopeSource =
      typeof event.origin_device_id === "string" && event.origin_device_id.trim() !== ""
        ? event.origin_device_id
        : undefined;
    const sourceDeviceId = payloadSource ?? envelopeSource;
    if (!sourceDeviceId) {
      this.store.rejectHistorySource(
        sourceId,
        "History Sync source device is missing; expected payload.source_device_id or origin_device_id"
      );
      return;
    }
    const kind = requireNonEmpty(payload.kind, "history.transit payload.kind");

    if (kind === "history_sync_request") {
      if (sourceDeviceId !== this.deviceId) await this.exportTo(sourceDeviceId);
    } else if (kind === "history_sync_message") {
      const chatId = requireNonEmpty(payload.chat_id, "history_sync_message chat_id");
      const messages = requireMessages(payload.messages);
      this.store.admitHistoryPage({
        sourceId,
        chatId,
        sourceDeviceId,
        messages
      });
      return;
    } else if (kind === "history_sync_progress") {
      this.updateTransfer(sourceDeviceId, "import", "active", {
        chatId: optionalNonEmpty(payload.chat_id),
        messagesTransferred: optionalCount(payload.messages_sent, "messages_sent")
      });
    } else if (kind === "history_sync_done") {
      this.updateTransfer(sourceDeviceId, "import", "complete", {
        messagesTransferred: optionalCount(payload.messages_sent, "messages_sent"),
        conversationsTransferred: optionalCount(
          payload.conversations_sent,
          "conversations_sent"
        )
      });
    } else if (kind === "history_sync_cancel") {
      this.updateTransfer(sourceDeviceId, "import", "cancelled", {
        reason: optionalNonEmpty(payload.reason)
      });
    }

    this.store.markHistorySourceProcessed(sourceId);
  }

  private async exportTo(targetDeviceId: string): Promise<void> {
    let conversationsSent = 0;
    let messagesSent = 0;
    this.updateTransfer(targetDeviceId, "export", "active");
    try {
      const response = await this.api.get("/v1/conversations?limit=100");
      for (const chatId of conversationIds(response)) {
        let cursor: string | null = null;
        const observedCursors = new Set<string>();
        do {
          const page = historyPage(
            await this.api.post(`/v1/conversations/${encodeURIComponent(chatId)}/history/page`, {
              cursor,
              page_size: this.pageSize
            })
          );
          if (page.messages.length > 0) {
            await this.sendTransit(targetDeviceId, {
              kind: "history_sync_message",
              chat_id: chatId,
              messages: page.messages
            });
            messagesSent += page.messages.length;
          }
          await this.sendTransit(targetDeviceId, {
            kind: "history_sync_progress",
            chat_id: chatId,
            messages_sent: messagesSent
          });
          this.updateTransfer(targetDeviceId, "export", "active", {
            chatId,
            messagesTransferred: messagesSent,
            conversationsTransferred: conversationsSent
          });
          if (!page.hasMore) break;
          const nextCursor = requireNonEmpty(page.nextCursor, "history page next_cursor");
          if (observedCursors.has(nextCursor)) throw new Error("history page cursor repeated");
          observedCursors.add(nextCursor);
          cursor = nextCursor;
        } while (true);
        conversationsSent += 1;
        this.updateTransfer(targetDeviceId, "export", "active", {
          chatId,
          messagesTransferred: messagesSent,
          conversationsTransferred: conversationsSent
        });
      }
      await this.sendTransit(targetDeviceId, {
        kind: "history_sync_done",
        conversations_sent: conversationsSent,
        messages_sent: messagesSent
      });
      this.updateTransfer(targetDeviceId, "export", "complete", {
        messagesTransferred: messagesSent,
        conversationsTransferred: conversationsSent
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.updateTransfer(targetDeviceId, "export", "cancelled", {
        messagesTransferred: messagesSent,
        conversationsTransferred: conversationsSent,
        reason
      });
      await this.sendTransit(targetDeviceId, {
        kind: "history_sync_cancel",
        reason
      });
    }
  }

  private updateTransfer(
    deviceId: string,
    direction: HistoryTransferState["direction"],
    status: HistoryTransferState["status"],
    patch: {
      chatId?: string | undefined;
      messagesTransferred?: number | undefined;
      conversationsTransferred?: number | undefined;
      reason?: string | undefined;
    } = {}
  ): void {
    const previous = this.store.getHistoryTransfer(deviceId, direction);
    const chatId = patch.chatId ?? previous?.chatId;
    this.store.updateHistoryTransfer({
      deviceId,
      direction,
      status,
      ...(chatId ? { chatId } : {}),
      messagesTransferred:
        patch.messagesTransferred ?? previous?.messagesTransferred ?? 0,
      conversationsTransferred:
        patch.conversationsTransferred ?? previous?.conversationsTransferred ?? 0,
      ...(patch.reason ? { reason: patch.reason } : {})
    });
  }

  private async sendTransit(targetDeviceId: string, payload: Record<string, unknown>): Promise<void> {
    await this.send({
      version: "2",
      event: "history.transit",
      trace_id: this.createTraceId(),
      emitted_at: this.now(),
      target_device_id: targetDeviceId,
      sender: { id: this.userId },
      origin_device_id: this.deviceId,
      payload: { ...payload, source_device_id: this.deviceId }
    });
  }
}

function conversationIds(value: unknown): string[] {
  const record = Array.isArray(value) ? null : requireRecord(value, "conversation list");
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(record?.conversations)
      ? record.conversations
      : Array.isArray(record?.items)
        ? record.items
        : [];
  const ids: string[] = [];
  for (const candidate of candidates) {
    const conversation = requireRecord(candidate, "conversation");
    ids.push(requireNonEmpty(conversation.id, "conversation.id"));
  }
  return ids;
}

function historyPage(value: unknown): {
  messages: HistoryMessage[];
  hasMore: boolean;
  nextCursor: unknown;
} {
  const page = requireRecord(value, "history page");
  return {
    messages: requireMessages(page.messages),
    hasMore: page.has_more === true,
    nextCursor: page.next_cursor
  };
}

function requireMessages(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) throw new Error("history messages must be an array");
  if (!value.every(isHistoryMessage)) throw new Error("every history message requires a string id");
  return value;
}

function isHistoryMessage(value: unknown): value is HistoryMessage {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.trim() !== ""
  );
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalNonEmpty(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNonEmpty(value, "history field");
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}
