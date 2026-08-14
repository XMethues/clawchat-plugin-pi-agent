import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayStore,
  type ChatSessionMapping,
  type SessionCommand
} from "../src/gateway-store.js";
import {
  ChatSessionRegistry,
  type ChatSessionDriver,
  type ChatSessionFactory
} from "../src/session-registry.js";

describe("ChatSessionRegistry", () => {
  it("serializes turns within one chat while different chats run concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    admit(store, "chat-1", "msg-2");
    admit(store, "chat-2", "msg-3");
    const firstChatRelease = deferred<void>();
    const secondChatRelease = deferred<void>();
    const started: string[] = [];
    const disposed: string[] = [];
    const factory: ChatSessionFactory = {
      createSession: (chatId) => ({
        sessionId: `session-${chatId}`,
        sessionPath: `/sessions/${chatId}.jsonl`
      }),
      openSession: vi.fn(async (mapping: ChatSessionMapping): Promise<ChatSessionDriver> => ({
        runTurn: async (turn) => {
          started.push(turn.messageId);
          if (turn.messageId === "msg-1") await firstChatRelease.promise;
          if (turn.messageId === "msg-3") await secondChatRelease.promise;
        },
        getInfo: async () => sessionInfo(mapping.sessionId),
        abort: async () => undefined,
        dispose: async () => {
          disposed.push(mapping.chatId);
        }
      })),
      inspectSession: async () => ({ messageCount: 0 }),
      deleteSession: async () => undefined
    };
    const registry = new ChatSessionRegistry({ store, factory, reply: async () => undefined });

    const chat1 = registry.wake("chat-1");
    const chat2 = registry.wake("chat-2");
    await waitFor(() => started.includes("msg-1") && started.includes("msg-3"));
    expect(started).not.toContain("msg-2");

    firstChatRelease.resolve();
    await waitFor(() => started.includes("msg-2"));
    secondChatRelease.resolve();
    await Promise.all([chat1, chat2]);
    expect(started).toEqual(["msg-1", "msg-3", "msg-2"]);

    await registry.shutdown();
    expect(disposed.sort()).toEqual(["chat-1", "chat-2"]);
    store.close();
  });

  it("orders Pi-style new, session, and resume commands with ordinary turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    let nextSession = 0;
    const executed: string[] = [];
    const replies: string[] = [];
    const factory: ChatSessionFactory = {
      createSession: (chatId) => {
        nextSession += 1;
        return {
          sessionId: `session-${chatId}-${nextSession}`,
          sessionPath: `/sessions/${chatId}-${nextSession}.jsonl`
        };
      },
      openSession: async (mapping) => ({
        runTurn: async (turn) => {
          executed.push(`${mapping.sessionId}:${turn.messageId}`);
        },
        getInfo: async () => ({
          ...sessionInfo(mapping.sessionId),
          userMessages: 1,
          assistantMessages: 1,
          totalMessages: 2
        }),
        abort: async () => undefined,
        dispose: async () => undefined
      }),
      inspectSession: async () => ({ messageCount: 2 }),
      deleteSession: async () => undefined
    };
    const registry = new ChatSessionRegistry({
      store,
      factory,
      reply: async (_message, text) => {
        replies.push(text);
      }
    });

    admit(store, "chat-1", "msg-1");
    admitCommand(store, "chat-1", "cmd-new", { type: "new" });
    admit(store, "chat-1", "msg-2");
    await registry.wake("chat-1");

    expect(executed).toEqual([
      "session-chat-1-1:msg-1",
      "session-chat-1-2:msg-2"
    ]);
    expect(replies).toEqual(["New session started: session-chat-1-2"]);

    admitCommand(store, "chat-1", "cmd-info", { type: "session" });
    admitCommand(store, "chat-1", "cmd-list", { type: "resume-list", page: 1 });
    admitCommand(store, "chat-1", "cmd-resume", {
      type: "resume",
      sessionId: "session-chat-1-1"
    });
    admit(store, "chat-1", "msg-3");
    await registry.wake("chat-1");

    expect(replies[1]).toContain("ID: session-chat-1-2");
    expect(replies[2]).toContain("session-chat-1-1");
    expect(replies[2]).not.toContain("msg-1");
    expect(replies[3]).toBe("Session resumed: session-chat-1-1");
    expect(executed.at(-1)).toBe("session-chat-1-1:msg-3");
    expect(store.getActiveChatSession("chat-1")).toMatchObject({
      sessionId: "session-chat-1-1",
      active: true
    });
    await registry.shutdown();
    store.close();
  });


  it("maps stop to Pi Escape by aborting the active turn and cancelling earlier queued work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    admit(store, "chat-1", "msg-2");
    const release = deferred<void>();
    const executed: string[] = [];
    let aborted = false;
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: () => ({
          sessionId: "session-chat-1",
          sessionPath: "/sessions/chat-1.jsonl"
        }),
        openSession: async (mapping) => ({
          runTurn: async (turn) => {
            executed.push(turn.messageId);
            if (turn.messageId === "msg-1") await release.promise;
          },
          getInfo: async () => sessionInfo(mapping.sessionId),
          abort: async () => {
            aborted = true;
            release.resolve();
          },
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined
    });
    const worker = registry.wake("chat-1");
    await waitFor(() => executed.includes("msg-1"));

    const stop = store.admitInbound({
      dedupeKey: "message:stop",
      messageId: "stop",
      chatId: "chat-1",
      frame: { chat_id: "chat-1", payload: { message_id: "stop" } },
      dispatch: false,
      stop: true
    });
    expect(stop.cancelledWork).toBe(1);
    await expect(registry.stop("chat-1")).resolves.toEqual({ interrupted: true });
    admit(store, "chat-1", "msg-3");
    const afterStop = registry.wake("chat-1");
    await Promise.all([worker, afterStop]);

    expect(aborted).toBe(true);
    expect(executed).toEqual(["msg-1", "msg-3"]);
    await registry.shutdown();
    store.close();
  });

  it("aborts a running session command on stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admitCommand(store, "chat-1", "cmd-1", { type: "session" });
    const started = deferred<void>();
    const release = deferred<void>();
    let aborted = false;
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: () => ({
          sessionId: "session-chat-1",
          sessionPath: "/sessions/chat-1.jsonl"
        }),
        openSession: async (mapping) => ({
          runTurn: async () => undefined,
          getInfo: async () => {
            started.resolve();
            await release.promise;
            return sessionInfo(mapping.sessionId);
          },
          abort: async () => {
            aborted = true;
            release.resolve();
          },
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined
    });
    const worker = registry.wake("chat-1");
    await started.promise;

    const stopped = registry.stop("chat-1");
    await expect(stopped).resolves.toEqual({ interrupted: true });
    await worker;

    expect(aborted).toBe(true);
    expect(store.getStatus().sessions[0]).toMatchObject({ runningWork: 0 });
    await registry.shutdown();
    store.close();
  });

  it("deletes a conversation's session set, cancelling queued work and aborting the active turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    admit(store, "chat-1", "msg-2");
    const release = deferred<void>();
    const executed: string[] = [];
    const deleted: string[] = [];
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: () => ({
          sessionId: "session-chat-1",
          sessionPath: "/sessions/chat-1.jsonl"
        }),
        openSession: async (mapping) => ({
          runTurn: async (turn) => {
            executed.push(turn.messageId);
            if (turn.messageId === "msg-1") await release.promise;
          },
          getInfo: async () => sessionInfo(mapping.sessionId),
          abort: async () => {
            release.resolve();
          },
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async (mapping) => {
          deleted.push(mapping.sessionId);
        }
      },
      reply: async () => undefined
    });
    const worker = registry.wake("chat-1");
    await waitFor(() => executed.includes("msg-1"));

    const cancelled = await registry.deleteConversation("chat-1");
    await worker;

    expect(cancelled).toBe(1);
    expect(executed).toEqual(["msg-1"]);
    expect(deleted).toEqual(["session-chat-1"]);
    expect(store.getStatus().sessions).toEqual([]);
    await registry.shutdown();
    store.close();
  });

  it("bounds the runtime abort wait on stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    const release = deferred<void>();
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: () => ({
          sessionId: "session-chat-1",
          sessionPath: "/sessions/chat-1.jsonl"
        }),
        openSession: async (mapping) => ({
          runTurn: async () => {
            await release.promise;
          },
          getInfo: async () => sessionInfo(mapping.sessionId),
          abort: async () => {
            // A hung Pi abort must not block stop past the bound.
            await new Promise<void>(() => undefined);
          },
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined
    });
    const worker = registry.wake("chat-1");
    await waitFor(() => store.getStatus().sessions[0]?.runningWork === 1);

    const started = Date.now();
    const stopped = registry.stop("chat-1", { abortTimeoutMs: 20 });
    await expect(stopped).resolves.toEqual({ interrupted: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    release.resolve();
    await worker;
    await registry.shutdown();
    store.close();
  });

  it("does not start a turn stopped while its runtime is opening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    const opening = deferred<void>();
    const opened = deferred<void>();
    const runTurn = vi.fn(async () => undefined);
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: () => ({
          sessionId: "session-chat-1",
          sessionPath: "/sessions/chat-1.jsonl"
        }),
        openSession: async (mapping) => {
          opened.resolve();
          await opening.promise;
          return {
            runTurn,
            getInfo: async () => sessionInfo(mapping.sessionId),
            abort: async () => undefined,
            dispose: async () => undefined
          };
        },
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined
    });
    const worker = registry.wake("chat-1");
    await opened.promise;

    const stopped = registry.stop("chat-1");
    opening.resolve();
    await expect(stopped).resolves.toEqual({ interrupted: true });
    await worker;

    expect(runTurn).not.toHaveBeenCalled();
    expect(store.getStatus().sessions[0]).toMatchObject({ runningWork: 0 });
    await registry.shutdown();
    store.close();
  });

  it("marks a failed Pi turn interrupted and continues with later queued work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    admit(store, "chat-1", "msg-2");
    const attempted: string[] = [];
    const errors: string[] = [];
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async (mapping) => ({
          runTurn: async (turn) => {
            attempted.push(turn.messageId);
            if (turn.messageId === "msg-1") throw new Error("model failed");
          },
          getInfo: async () => sessionInfo(mapping.sessionId),
          abort: async () => undefined,
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined,
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error))
    });

    await registry.wake("chat-1");

    expect(attempted).toEqual(["msg-1", "msg-2"]);
    expect(errors).toEqual(["model failed"]);
    expect(store.getStatus().sessions[0]).toMatchObject({ queuedWork: 0, runningWork: 0 });
    await registry.shutdown();
    store.close();
  });

  it("recovers never-started queued turns without replaying an interrupted turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const path = join(directory, "gateway.sqlite");
    const beforeRestart = GatewayStore.open(path);
    const running = beforeRestart.admitInbound({
      dedupeKey: "message:msg-running",
      messageId: "msg-running",
      chatId: "chat-1",
      frame: { chat_id: "chat-1" },
      dispatch: true
    });
    beforeRestart.claimNextWork("chat-1");
    admit(beforeRestart, "chat-2", "msg-queued");
    beforeRestart.close();
    const store = GatewayStore.open(path);
    const attempted: string[] = [];
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async (mapping) => ({
          runTurn: async (turn) => {
            attempted.push(turn.messageId);
          },
          getInfo: async () => sessionInfo(mapping.sessionId),
          abort: async () => undefined,
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined
    });

    expect(registry.start()).toEqual({ interruptedWorkIds: [running.workId] });
    await waitFor(() => attempted.includes("msg-queued"));
    expect(attempted).toEqual(["msg-queued"]);
    await registry.shutdown();
    store.close();
  });

  it("returns from startup while recovered queued work continues in the background", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-queued");
    const release = deferred<void>();
    let running = false;
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async (mapping) => ({
          runTurn: async () => {
            running = true;
            await release.promise;
          },
          getInfo: async () => sessionInfo(mapping.sessionId),
          abort: async () => release.resolve(),
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined
    });

    expect(registry.start()).toEqual({ interruptedWorkIds: [] });
    await waitFor(() => running);

    release.resolve();
    await registry.shutdown();
    store.close();
  });

  it("interrupts and aborts an active Pi turn after the shutdown grace period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-registry-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    admit(store, "chat-1", "msg-1");
    const running = deferred<void>();
    let started = false;
    let aborted = false;
    const registry = new ChatSessionRegistry({
      store,
      factory: {
        createSession: (chatId) => ({
          sessionId: `session-${chatId}`,
          sessionPath: `/sessions/${chatId}.jsonl`
        }),
        openSession: async (mapping) => ({
          runTurn: async () => {
            started = true;
            await running.promise;
          },
          getInfo: async () => sessionInfo(mapping.sessionId),
          abort: async () => {
            aborted = true;
            running.resolve();
          },
          dispose: async () => undefined
        }),
        inspectSession: async () => ({ messageCount: 0 }),
        deleteSession: async () => undefined
      },
      reply: async () => undefined
    });
    void registry.wake("chat-1");
    await waitFor(() => started);

    await registry.shutdown({ graceMs: 0 });

    expect(aborted).toBe(true);
    expect(store.getStatus().sessions[0]).toMatchObject({ queuedWork: 0, runningWork: 0 });
    store.close();
  });
});

function sessionInfo(sessionId: string) {
  return {
    sessionId,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0
  };
}

function admit(store: GatewayStore, chatId: string, messageId: string): void {
  store.admitInbound({
    dedupeKey: `message:${messageId}`,
    messageId,
    chatId,
    frame: { chat_id: chatId, payload: { message_id: messageId } },
    dispatch: true
  });
}

function admitCommand(
  store: GatewayStore,
  chatId: string,
  messageId: string,
  sessionCommand: SessionCommand
): void {
  store.admitInbound({
    dedupeKey: `message:${messageId}`,
    messageId,
    chatId,
    frame: { chat_id: chatId, payload: { message_id: messageId } },
    dispatch: false,
    sessionCommand
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
