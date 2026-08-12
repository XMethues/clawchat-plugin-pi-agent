import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

describe("GatewayStore", () => {
  it("keeps one Pi session mapping for a chat across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const firstStore = GatewayStore.open(path);

    const first = firstStore.getOrCreateChatSession("chat-1", () => ({
      sessionId: "session-1",
      sessionPath: "/sessions/session-1.jsonl"
    }));
    const same = firstStore.getOrCreateChatSession("chat-1", () => ({
      sessionId: "wrong-session",
      sessionPath: "/sessions/wrong.jsonl"
    }));
    firstStore.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.getChatSession("chat-1")).toEqual(first);
    expect(same).toEqual(first);
    reopened.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("admits each inbound message once and claims turns FIFO per chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));

    const first = store.admitInbound({
      dedupeKey: "message:msg-1",
      messageId: "msg-1",
      chatId: "chat-1",
      frame: { event: "message.send", payload: { text: "first" } },
      dispatch: true
    });
    const duplicate = store.admitInbound({
      dedupeKey: "message:msg-1",
      messageId: "msg-1",
      chatId: "chat-1",
      frame: { event: "message.reply", payload: { text: "final" } },
      dispatch: true
    });
    store.admitInbound({
      dedupeKey: "message:msg-2",
      messageId: "msg-2",
      chatId: "chat-1",
      frame: { event: "message.send", payload: { text: "second" } },
      dispatch: true
    });

    expect(first.status).toBe("accepted");
    expect(duplicate).toEqual({ status: "duplicate", turnId: first.turnId });
    const claimedFirst = store.claimNextTurn("chat-1");
    expect(claimedFirst).toMatchObject({ messageId: "msg-1", frame: { payload: { text: "final" } } });
    expect(store.claimNextTurn("chat-1")).toBeNull();
    store.completeTurn(claimedFirst!.id);
    expect(store.claimNextTurn("chat-1")).toMatchObject({ messageId: "msg-2" });
    store.close();
  });

  it("preserves an author-final reply when its provisional copy arrives later", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const authorFinal = {
      event: "message.reply",
      payload: { message_id: "msg-final-first", text: "polished", stream_merged: false }
    };

    const admitted = store.admitInbound({
      dedupeKey: "message:msg-final-first",
      messageId: "msg-final-first",
      chatId: "chat-1",
      frame: authorFinal,
      dispatch: true
    });
    const duplicate = store.admitInbound({
      dedupeKey: "message:msg-final-first",
      messageId: "msg-final-first",
      chatId: "chat-1",
      frame: {
        event: "message.reply",
        payload: { message_id: "msg-final-first", text: "draft", stream_merged: true }
      },
      dispatch: true
    });

    expect(duplicate).toEqual({ status: "duplicate", turnId: admitted.turnId });
    expect(store.claimNextTurn("chat-1")).toMatchObject({ frame: authorFinal });
    store.close();
  });

  it("atomically replaces a queued provisional reply with a later author-final reply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const provisional = store.admitInbound({
      dedupeKey: "message:msg-provisional-first",
      messageId: "msg-provisional-first",
      chatId: "chat-1",
      frame: {
        event: "message.reply",
        payload: { message_id: "msg-provisional-first", text: "draft", stream_merged: true }
      },
      dispatch: true
    });
    const authorFinal = {
      event: "message.reply",
      payload: { message_id: "msg-provisional-first", text: "polished" }
    };

    const duplicate = store.admitInbound({
      dedupeKey: "message:msg-provisional-first",
      messageId: "msg-provisional-first",
      chatId: "chat-1",
      frame: authorFinal,
      dispatch: true
    });

    expect(duplicate).toEqual({ status: "duplicate", turnId: provisional.turnId });
    expect(store.claimNextTurn("chat-1")).toMatchObject({
      id: provisional.turnId,
      frame: authorFinal
    });
    store.close();
  });

  it("preserves ordinary same-message-ID rewrites outside reply precedence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const admitted = store.admitInbound({
      dedupeKey: "message:msg-rewritten",
      messageId: "msg-rewritten",
      chatId: "chat-1",
      frame: { event: "message.send", payload: { message_id: "msg-rewritten", text: "before" } },
      dispatch: true
    });
    const rewritten = {
      event: "message.send",
      payload: { message_id: "msg-rewritten", text: "after", stream_merged: true }
    };

    const duplicate = store.admitInbound({
      dedupeKey: "message:msg-rewritten",
      messageId: "msg-rewritten",
      chatId: "chat-1",
      frame: rewritten,
      dispatch: true
    });

    expect(duplicate).toEqual({ status: "duplicate", turnId: admitted.turnId });
    expect(store.claimNextTurn("chat-1")).toMatchObject({ frame: rewritten });
    store.close();
  });

  it("does not replay a turn that was running when the Host stopped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const store = GatewayStore.open(path);
    const first = store.admitInbound({
      dedupeKey: "message:msg-1",
      messageId: "msg-1",
      chatId: "chat-1",
      frame: { payload: { text: "may have side effects" } },
      dispatch: true
    });
    store.admitInbound({
      dedupeKey: "message:msg-2",
      messageId: "msg-2",
      chatId: "chat-1",
      frame: { payload: { text: "never started" } },
      dispatch: true
    });
    store.claimNextTurn("chat-1");
    store.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.recoverAfterRestart()).toEqual({ interruptedTurnIds: [first.turnId] });
    expect(reopened.claimNextTurn("chat-1")).toMatchObject({ messageId: "msg-2" });
    reopened.close();
  });

  it("keeps materialized replies pending until the server acknowledges them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const store = GatewayStore.open(path);
    const frame = {
      event: "message.reply",
      trace_id: "trace-out-1",
      payload: { message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6" }
    };
    store.enqueueOutbound({
      traceId: "trace-out-1",
      chatId: "chat-1",
      frame
    });
    store.close();

    const attempted = GatewayStore.open(path);
    attempted.recordOutboundAttempt("trace-out-1", 1_776_162_600_000);
    attempted.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.listPendingOutbound()).toEqual([
      {
        traceId: "trace-out-1",
        messageId: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
        chatId: "chat-1",
        frame,
        serializedFrame: JSON.stringify(frame),
        attempts: 1,
        lastAttemptAt: 1_776_162_600_000
      }
    ]);
    reopened.acknowledgeOutbound("trace-out-1");
    expect(reopened.listPendingOutbound()).toEqual([]);
    reopened.close();
  });

  it("persists and clears per-chat tool-output overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));

    store.setToolOutputOverride("chat-1", "on");
    store.setToolOutputOverride("chat-2", "off");
    expect(store.getToolOutputOverrides()).toEqual({ "chat-1": "on", "chat-2": "off" });

    store.setToolOutputOverride("chat-1", "inherit");
    expect(store.getToolOutputOverrides()).toEqual({ "chat-2": "off" });
    store.close();
  });

  it("transactionally gives a pending legacy row one durable message identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE outbound_messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        frame_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        failed_at INTEGER,
        error_code TEXT,
        error_reason TEXT
      ) STRICT
    `);
    legacy
      .prepare(
        `INSERT INTO outbound_messages
          (message_id, chat_id, frame_json, status, attempts, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`
      )
      .run(
        "trace-out-1",
        "chat-1",
        JSON.stringify({ event: "message.reply", trace_id: "trace-out-1", payload: {} }),
        1
      );
    legacy.close();

    const migrated = GatewayStore.open(path);
    const [first] = migrated.listPendingOutbound();
    expect(first!.traceId).toBe("trace-out-1");
    expect(first!.messageId).toMatch(/^msg-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(first!.frame).toMatchObject({ payload: { message_id: first!.messageId } });
    expect(first!.serializedFrame).toBe(JSON.stringify(first!.frame));
    migrated.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.listPendingOutbound()).toEqual([first]);
    expect(() =>
      reopened.enqueueOutbound({
        traceId: "trace-out-2",
        chatId: "chat-1",
        frame: {
          event: "message.reply",
          trace_id: "trace-out-2",
          payload: { message_id: first!.messageId }
        }
      })
    ).toThrow();
    reopened.close();
  });

  it("durably advances reliable quarantine once per epoch and keeps raw input non-ackable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const first = GatewayStore.open(path);
    const poison = { version: "2", event: "future.poison", dseq: 1, payload: null };

    first.quarantineReliableInbound({
      ackEpoch: "epoch-1",
      dseq: 1,
      event: "future.poison",
      reason: "invalid outer envelope payload",
      frame: poison
    });
    first.quarantineReliableInbound({
      ackEpoch: "epoch-1",
      dseq: 1,
      event: "future.poison",
      reason: "a replay must not replace the original diagnosis",
      frame: poison
    });
    first.quarantineRawInbound({
      event: "<invalid-json>",
      reason: "invalid JSON",
      frame: "{"
    });

    expect(first.listQuarantinedFrames()).toEqual([
      expect.objectContaining({
        ackEpoch: "epoch-1",
        dseq: 1,
        ackable: true,
        event: "future.poison",
        reason: "invalid outer envelope payload",
        frame: poison
      }),
      expect.objectContaining({
        ackEpoch: null,
        dseq: null,
        ackable: false,
        event: "<invalid-json>",
        frame: "{"
      })
    ]);
    expect(first.getReliableHighWater("epoch-1")).toBe(1);
    first.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.getReliableHighWater("epoch-1")).toBe(1);
    expect(reopened.getStatus().quarantinedFrames).toBe(2);
    reopened.close();
  });
  it("persists a monotonic idempotent inbox history boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const first = GatewayStore.open(path);

    expect(first.recordInboxHistoryBoundary(20, 1_000)).toBe(true);
    expect(first.recordInboxHistoryBoundary(20, 2_000)).toBe(false);
    expect(first.recordInboxHistoryBoundary(10, 3_000)).toBe(false);
    expect(first.getStatus().inboxHistoryUnavailableBefore).toEqual({
      oldestSeq: 20,
      observedAt: 1_000
    });
    expect(first.recordInboxHistoryBoundary(30, 4_000)).toBe(true);
    first.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.getInboxHistoryBoundary()).toEqual({ oldestSeq: 30, observedAt: 4_000 });
    reopened.close();
  });

});
