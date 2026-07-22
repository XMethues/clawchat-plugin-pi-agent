import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";

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
    store.enqueueOutbound({
      messageId: "msg-out-1",
      chatId: "chat-1",
      frame: { event: "message.reply", payload: { message_id: "msg-out-1" } }
    });
    store.close();

    const reopened = GatewayStore.open(path);
    reopened.recordOutboundAttempt("msg-out-1");
    expect(reopened.listPendingOutbound()).toEqual([
      {
        messageId: "msg-out-1",
        chatId: "chat-1",
        frame: { event: "message.reply", payload: { message_id: "msg-out-1" } },
        attempts: 1
      }
    ]);
    reopened.acknowledgeOutbound("msg-out-1");
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
});
