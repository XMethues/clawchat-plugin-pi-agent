import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClawchatPlaintextHistorySync } from "../src/clawchat-history-sync.js";
import { GatewayStore } from "../src/gateway-store.js";

describe("ClawchatPlaintextHistorySync", () => {
  it("pages REST history into plaintext sibling-device transit frames", async () => {
    const store = await openStore();
    const api = {
      get: vi.fn(async (_path: string) => ({ conversations: [{ id: "chat-1" }] })),
      post: vi.fn(async (_path: string, body: unknown) => {
        const cursor =
          body && typeof body === "object" && "cursor" in body ? body.cursor : undefined;
        return cursor
          ? { messages: [{ id: "message-2", content: "later" }], has_more: false }
          : {
              messages: [{ id: "message-1", content: "earlier" }],
              has_more: true,
              next_cursor: "cursor-2"
            };
      })
    };
    const send = vi.fn(async (_frame: unknown) => undefined);
    const sync = new ClawchatPlaintextHistorySync({
      api,
      store,
      deviceId: "device-old",
      userId: "user-1",
      send,
      createTraceId: () => "history-trace",
      now: () => 1776162700400
    });

    await sync.handle(transit("device-old", "device-new", { kind: "history_sync_request" }));

    expect(api.get).toHaveBeenCalledWith("/v1/conversations?limit=100");
    expect(api.post.mock.calls).toEqual([
      ["/v1/conversations/chat-1/history/page", { cursor: null, page_size: 100 }],
      ["/v1/conversations/chat-1/history/page", { cursor: "cursor-2", page_size: 100 }]
    ]);
    expect(send.mock.calls.map(([frame]) => frame)).toMatchObject([
      {
        version: "2",
        event: "history.transit",
        target_device_id: "device-new",
        origin_device_id: "device-old",
        sender: { id: "user-1" },
        payload: {
          kind: "history_sync_message",
          chat_id: "chat-1",
          messages: [{ id: "message-1" }]
        }
      },
      {
        payload: {
          kind: "history_sync_progress",
          chat_id: "chat-1",
          messages_sent: 1
        }
      },
      {
        payload: {
          kind: "history_sync_message",
          chat_id: "chat-1",
          messages: [{ id: "message-2" }]
        }
      },
      {
        payload: {
          kind: "history_sync_progress",
          chat_id: "chat-1",
          messages_sent: 2
        }
      },
      {
        payload: {
          kind: "history_sync_done",
          conversations_sent: 1,
          messages_sent: 2
        }
      }
    ]);
    for (const [frame] of send.mock.calls) {
      expect(frame).not.toHaveProperty("ciphertext_fragments");
    }
    store.close();
  });

  it("durably imports plaintext message pages idempotently", async () => {
    const store = await openStore();
    const sync = new ClawchatPlaintextHistorySync({
      api: { get: async () => ({}), post: async () => ({}) },
      store,
      deviceId: "device-new",
      userId: "user-1",
      send: async () => undefined
    });
    const page = transit("device-new", "device-old", {
      kind: "history_sync_message",
      chat_id: "chat-1",
      messages: [
        { id: "message-1", content: "hello", created_at: 10 },
        { id: "message-2", content: "world", created_at: 20 }
      ]
    });

    await sync.handle(page);
    await sync.handle(page);

    expect(store.listHistoryMessages("chat-1")).toEqual([
      { id: "message-1", content: "hello", created_at: 10 },
      { id: "message-2", content: "world", created_at: 20 }
    ]);
    expect(store.isHistorySourceProcessed("incoming-history-trace")).toBe(true);

    await sync.handle(transit("device-new", "device-old", {
      kind: "history_sync_progress",
      chat_id: "chat-1",
      messages_sent: 2
    }, "history-progress"));
    expect(store.getHistoryTransfer("device-old", "import")).toMatchObject({
      status: "active",
      chatId: "chat-1",
      messagesTransferred: 2
    });

    await sync.handle(transit("device-new", "device-old", {
      kind: "history_sync_done",
      conversations_sent: 1,
      messages_sent: 2
    }, "history-done"));
    expect(store.getHistoryTransfer("device-old", "import")).toMatchObject({
      status: "complete",
      conversationsTransferred: 1,
      messagesTransferred: 2
    });

    await sync.handle(transit("device-new", "device-old", {
      kind: "history_sync_cancel",
      reason: "stopped"
    }, "history-cancel"));
    expect(store.getHistoryTransfer("device-old", "import")).toMatchObject({
      status: "cancelled",
      reason: "stopped"
    });
    store.close();
  });
});

async function openStore(): Promise<GatewayStore> {
  const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-history-"));
  return GatewayStore.open(join(directory, "gateway.sqlite"));
}

function transit(
  targetDeviceId: string,
  originDeviceId: string,
  payload: Record<string, unknown>,
  traceId = "incoming-history-trace"
) {
  return {
    version: "2" as const,
    event: "history.transit",
    trace_id: traceId,
    emitted_at: 1,
    target_device_id: targetDeviceId,
    origin_device_id: originDeviceId,
    sender: { id: "user-1" },
    payload
  };
}
