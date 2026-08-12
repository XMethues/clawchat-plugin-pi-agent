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

    await sync.handle(transit("device-old", "", {
      kind: "history_sync_request",
      source_device_id: "device-new"
    }));

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
      expect(frame).toMatchObject({
        payload: { source_device_id: "device-old" }
      });
      expect(frame).not.toHaveProperty("ciphertext_fragments");
      expect(frame).not.toHaveProperty("payload.ciphertext_fragments");
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
    const page = transit("device-new", "conflicting-envelope-device", {
      kind: "history_sync_message",
      source_device_id: "device-old",
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

    await sync.handle(transit("device-new", "", {
      kind: "history_sync_done",
      source_device_id: "device-old",
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

  it("falls back to envelope source while preserving target and self-export filtering", async () => {
    const store = await openStore();
    const api = {
      get: vi.fn(async () => ({ conversations: [] })),
      post: vi.fn(async () => ({}))
    };
    const send = vi.fn(async (_frame: unknown) => undefined);
    const sync = new ClawchatPlaintextHistorySync({
      api,
      store,
      deviceId: "device-new",
      userId: "user-1",
      send
    });

    await sync.handle(transit("another-device", "", {
      kind: "history_sync_request",
      source_device_id: "target-filtered-source"
    }, "target-filtered"));
    await sync.handle(transit("device-new", "fallback-device", {
      kind: "history_sync_request"
    }, "fallback-source"));
    await sync.handle(transit("device-new", "different-envelope-device", {
      kind: "history_sync_request",
      source_device_id: "device-new"
    }, "self-source"));

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      target_device_id: "fallback-device",
      payload: expect.objectContaining({
        kind: "history_sync_done",
        source_device_id: "device-new"
      })
    }));
    expect(store.isHistorySourceProcessed("target-filtered")).toBe(false);
    expect(store.isHistorySourceProcessed("fallback-source")).toBe(true);
    expect(store.isHistorySourceProcessed("self-source")).toBe(true);
    store.close();
  });

  it("durably rejects and processes a transfer with no usable source identity", async () => {
    const store = await openStore();
    const api = {
      get: vi.fn(async () => ({})),
      post: vi.fn(async () => ({}))
    };
    const send = vi.fn(async (_frame: unknown) => undefined);
    const sync = new ClawchatPlaintextHistorySync({
      api,
      store,
      deviceId: "device-new",
      userId: "user-1",
      send
    });
    const malformed = transit("device-new", "", {
      kind: "history_sync_request",
      source_device_id: " "
    }, "malformed-source");

    await expect(sync.handle(malformed)).resolves.toBeUndefined();
    await expect(sync.handle(malformed)).resolves.toBeUndefined();

    expect(store.isHistorySourceProcessed("malformed-source")).toBe(true);
    expect(store.getHistorySourceRejection("malformed-source")).toEqual({
      sourceId: "malformed-source",
      status: "rejected",
      reason:
        "History Sync source device is missing; expected payload.source_device_id or origin_device_id"
    });
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
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
