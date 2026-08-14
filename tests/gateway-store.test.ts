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
  it("keeps the active Pi session mapping for a chat across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const firstStore = GatewayStore.open(path);

    const first = firstStore.ensureConversationSessionSet("chat-1", () => ({
      sessionId: "session-1",
      sessionPath: "/sessions/session-1.jsonl"
    }));
    const same = firstStore.ensureConversationSessionSet("chat-1", () => ({
      sessionId: "wrong-session",
      sessionPath: "/sessions/wrong.jsonl"
    }));
    firstStore.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.getActiveChatSession("chat-1")).toEqual(first);
    expect(same).toEqual(first);
    reopened.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("migrates legacy one-session chat mappings without losing ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE chat_sessions (
        chat_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        session_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO chat_sessions (chat_id, session_id, session_path, created_at)
      VALUES ('chat-legacy', 'session-legacy', '/sessions/legacy.jsonl', 42);
    `);
    legacy.close();

    const migrated = GatewayStore.open(path);
    expect(migrated.getActiveChatSession("chat-legacy")).toEqual({
      chatId: "chat-legacy",
      sessionId: "session-legacy",
      sessionPath: "/sessions/legacy.jsonl",
      createdAt: 42,
      lastUsedAt: 42,
      active: true
    });
    expect(migrated.listChatSessions("chat-legacy")).toHaveLength(1);
    migrated.close();
  });

  it("owns multiple sessions per chat and removes only replaced empty sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const initial = store.ensureConversationSessionSet("chat-1", () => ({
      sessionId: "session-1",
      sessionPath: "/sessions/session-1.jsonl"
    }));

    const firstTransition = store.createAndActivateChatSession("chat-1", () => ({
      sessionId: "session-2",
      sessionPath: "/sessions/session-2.jsonl"
    }));
    expect(firstTransition.replacedEmpty).toEqual(initial);
    expect(store.listChatSessions("chat-1").map((session) => session.sessionId)).toEqual([
      "session-2"
    ]);

    store.markChatSessionUsed("chat-1", "session-2");
    const secondTransition = store.createAndActivateChatSession("chat-1", () => ({
      sessionId: "session-3",
      sessionPath: "/sessions/session-3.jsonl"
    }));
    expect(secondTransition.replacedEmpty).toBeNull();
    expect(store.listChatSessions("chat-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-2", active: false }),
        expect.objectContaining({ sessionId: "session-3", active: true })
      ])
    );

    const resumed = store.activateChatSession("chat-1", "session-2");
    expect(resumed.replacedEmpty).toMatchObject({ sessionId: "session-3" });
    expect(store.listChatSessions("chat-1").map((session) => session.sessionId)).toEqual([
      "session-2"
    ]);
    expect(() => store.activateChatSession("chat-2", "session-2")).toThrow(
      "not owned by chat 'chat-2'"
    );
    store.close();
  });

  it("deletes a conversation's sessions and work while preserving inbound dedupe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    store.ensureConversationSessionSet("chat-1", () => ({
      sessionId: "session-1",
      sessionPath: "/sessions/session-1.jsonl"
    }));
    const admitted = store.admitInbound({
      dedupeKey: "message:msg-1",
      messageId: "msg-1",
      chatId: "chat-1",
      frame: { payload: { message_id: "msg-1" } },
      dispatch: true
    });

    expect(store.deleteConversationSessionSet("chat-1")).toEqual([
      expect.objectContaining({ sessionId: "session-1" })
    ]);
    expect(store.listConversationIds()).not.toContain("chat-1");
    expect(store.listQueuedConversationIds()).not.toContain("chat-1");
    expect(
      store.admitInbound({
        dedupeKey: "message:msg-1",
        messageId: "msg-1",
        chatId: "chat-1",
        frame: { payload: { message_id: "msg-1" } },
        dispatch: true
      })
    ).toEqual({ status: "duplicate", workId: null, cancelledWork: 0 });
    expect(admitted.workId).not.toBeNull();
    store.close();
  });

  it("uses stop admission as an atomic boundary around queued work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const running = store.admitInbound({
      dedupeKey: "message:running",
      messageId: "running",
      chatId: "chat-1",
      frame: { payload: { message_id: "running" } },
      dispatch: true
    });
    store.claimNextWork("chat-1");
    store.admitInbound({
      dedupeKey: "message:before-stop",
      messageId: "before-stop",
      chatId: "chat-1",
      frame: { payload: { message_id: "before-stop" } },
      dispatch: true
    });

    const stopped = store.admitInbound({
      dedupeKey: "message:stop",
      messageId: "stop",
      chatId: "chat-1",
      frame: { payload: { message_id: "stop" } },
      dispatch: false,
      stop: true
    });
    expect(stopped).toMatchObject({ status: "accepted", workId: null, cancelledWork: 1 });

    store.admitInbound({
      dedupeKey: "message:after-stop",
      messageId: "after-stop",
      chatId: "chat-1",
      frame: { payload: { message_id: "after-stop" } },
      dispatch: true
    });
    expect(store.claimNextWork("chat-1")).toBeNull();
    store.interruptWork(running.workId!);
    expect(store.claimNextWork("chat-1")).toMatchObject({ messageId: "after-stop" });
    store.close();
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
    expect(duplicate).toEqual({ status: "duplicate", workId: first.workId, cancelledWork: 0 });
    const claimedFirst = store.claimNextWork("chat-1");
    expect(claimedFirst).toMatchObject({ messageId: "msg-1", frame: { payload: { text: "final" } } });
    expect(store.claimNextWork("chat-1")).toBeNull();
    store.completeWork(claimedFirst!.id);
    expect(store.claimNextWork("chat-1")).toMatchObject({ messageId: "msg-2" });
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

    expect(duplicate).toEqual({ status: "duplicate", workId: admitted.workId, cancelledWork: 0 });
    expect(store.claimNextWork("chat-1")).toMatchObject({ frame: authorFinal });
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

    expect(duplicate).toEqual({ status: "duplicate", workId: provisional.workId, cancelledWork: 0 });
    expect(store.claimNextWork("chat-1")).toMatchObject({
      id: provisional.workId,
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

    expect(duplicate).toEqual({ status: "duplicate", workId: admitted.workId, cancelledWork: 0 });
    expect(store.claimNextWork("chat-1")).toMatchObject({ frame: rewritten });
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
    store.claimNextWork("chat-1");
    store.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.recoverAfterRestart()).toEqual({ interruptedWorkIds: [first.workId] });
    expect(reopened.claimNextWork("chat-1")).toMatchObject({ messageId: "msg-2" });
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

  it("persists mode overrides across restarts and clears inherit overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const store = GatewayStore.open(path);

    store.setOutputModeOverride("chat-1", "minimal");
    store.setOutputModeOverride("chat-2", "full");
    store.close();

    const reopened = GatewayStore.open(path);
    expect(reopened.getOutputModeOverrides()).toEqual({ "chat-1": "minimal", "chat-2": "full" });
    reopened.setOutputModeOverride("chat-1", "inherit");
    expect(reopened.getOutputModeOverrides()).toEqual({ "chat-2": "full" });
    reopened.close();
  });

  it("maps legacy tool-output overrides onto output modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const path = join(directory, "gateway.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE chat_output_settings (
        chat_id TEXT PRIMARY KEY,
        tool_calls TEXT NOT NULL CHECK (tool_calls IN ('on', 'off')),
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO chat_output_settings (chat_id, tool_calls, updated_at)
      VALUES ('chat-full', 'on', 1), ('chat-normal', 'off', 2);
    `);
    legacy.close();

    const migrated = GatewayStore.open(path);
    expect(migrated.getOutputModeOverrides()).toEqual({
      "chat-full": "full",
      "chat-normal": "normal"
    });
    migrated.close();
  });

  it("rejects invalid output modes explicitly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-gateway-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));

    expect(() => store.setOutputModeOverride("chat-1", "verbose" as never)).toThrow(
      "Invalid ClawChat output mode"
    );
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
