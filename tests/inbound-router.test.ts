import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";
import { ClawchatInboundRouter } from "../src/inbound-router.js";
import type { ClawchatInboundMessage } from "../src/types.js";

describe("ClawchatInboundRouter", () => {
  it("dispatches canonical, legacy, and everyone mentions in mention mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-router-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const router = new ClawchatInboundRouter({
      store,
      agentUserId: "agent-user-1",
      reply: async () => undefined
    });

    expect(router.classify(groupMessage("canonical", [{ user_id: "agent-user-1" }]))).toEqual({
      dispatch: true
    });
    expect(router.classify(groupMessage("legacy", ["agent-user-1"]))).toEqual({ dispatch: true });
    expect(router.classify(groupMessage("everyone", [{ user_id: "all" }]))).toEqual({
      dispatch: true
    });
    expect(router.classify(groupMessage("other", [{ user_id: "human-2" }, "human-3"]))).toEqual({
      dispatch: false
    });
    store.close();
  });

  it("ignores malformed and unknown opaque mention data without throwing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-router-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const router = new ClawchatInboundRouter({
      store,
      agentUserId: "agent-user-1",
      reply: async () => undefined
    });
    const missingContext = groupMessage("missing context", []);
    delete missingContext.payload.message.context;
    const missingMentions = groupMessage("missing mentions", []);
    missingMentions.payload.message.context = { reply: null };

    expect(router.classify(missingContext)).toEqual({ dispatch: false });
    expect(router.classify(missingMentions)).toEqual({ dispatch: false });
    expect(router.classify(groupMessage("non-array", { user_id: "agent-user-1" }))).toEqual({
      dispatch: false
    });
    expect(
      router.classify(
        groupMessage("malformed", [
          null,
          undefined,
          7,
          true,
          {},
          { id: "agent-user-1" },
          { user_id: null },
          { user_id: 42 }
        ])
      )
    ).toEqual({ dispatch: false });
    store.close();
  });

  it("preserves direct and explicit group mode dispatch behavior", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-router-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const router = new ClawchatInboundRouter({
      store,
      agentUserId: "agent-user-1",
      reply: async () => undefined
    });
    const direct = groupMessage("direct", null);
    direct.chat_type = "direct";

    expect(router.classify(direct)).toEqual({ dispatch: true });
    store.setGroupDispatchMode("group-1", "all");
    expect(router.classify(groupMessage("all mode", null))).toEqual({ dispatch: true });
    store.setGroupDispatchMode("group-1", "muted");
    expect(router.classify(groupMessage("muted", [{ user_id: "all" }]))).toEqual({
      dispatch: false
    });
    store.close();
  });

  it("admits media-only messages through direct and configured group dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-router-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const router = new ClawchatInboundRouter({
      store,
      agentUserId: "agent-user-1",
      reply: async () => undefined
    });
    const direct = imageOnlyMessage(null);
    direct.chat_type = "direct";

    const invalidDirect = imageOnlyMessage(null, " \t");
    invalidDirect.chat_type = "direct";

    expect(router.classify(invalidDirect)).toEqual({ dispatch: true });
    expect(router.classify(imageOnlyMessage(null, ""))).toEqual({ dispatch: false });
    expect(router.classify(imageOnlyMessage([{ user_id: "agent-user-1" }], " "))).toEqual({
      dispatch: true
    });
    expect(router.classify(direct)).toEqual({ dispatch: true });
    expect(router.classify(imageOnlyMessage([{ user_id: "agent-user-1" }]))).toEqual({
      dispatch: true
    });
    store.setGroupDispatchMode("group-1", "all");
    expect(router.classify(imageOnlyMessage(null, "\t"))).toEqual({ dispatch: true });
    store.setGroupDispatchMode("group-1", "muted");
    expect(router.classify(imageOnlyMessage([{ user_id: "all" }], ""))).toEqual({
      dispatch: false
    });
    store.close();
  });

  it("accepts an integration command while muted and can unmute the group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-router-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    store.setGroupDispatchMode("group-1", "muted");
    const replies: string[] = [];
    const router = new ClawchatInboundRouter({
      store,
      agentUserId: "agent-user-1",
      reply: async (_message, text) => {
        replies.push(text);
      }
    });
    const command = groupMessage("/clawchat-group all", []);

    const decision = router.classify(command);
    expect(decision).toMatchObject({ dispatch: false, control: { type: "group", value: "all" } });
    await router.applyAcceptedControl(command, decision);

    expect(store.getGroupDispatchMode("group-1")).toBe("all");
    expect(router.classify(groupMessage("ordinary message", []))).toEqual({ dispatch: true });
    expect(replies).toEqual(["ClawChat group dispatch: all."]);
    store.close();
  });
  it("accepts the documented output modes and rejects the retired tools toggle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-router-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const router = new ClawchatInboundRouter({
      store,
      agentUserId: "agent-user-1",
      reply: async () => undefined
    });

    for (const mode of ["minimal", "normal", "full", "inherit"] as const) {
      expect(router.classify(groupMessage(`/clawchat-output ${mode}`, []))).toEqual({
        dispatch: false,
        control: { type: "output", value: mode }
      });
    }
    expect(router.classify(groupMessage("/clawchat-output tools on", []))).toEqual({
      dispatch: false
    });
    expect(router.classify(groupMessage("/clawchat-output verbose", []))).toEqual({
      dispatch: false
    });
    const retiredDirect = groupMessage("/clawchat-output tools on", []);
    retiredDirect.chat_type = "direct";
    expect(router.classify(retiredDirect)).toEqual({ dispatch: false });
    const missingDirect = groupMessage("/clawchat-output", []);
    missingDirect.chat_type = "direct";
    expect(router.classify(missingDirect)).toEqual({ dispatch: false });
    store.close();
  });

  it("reports the effective output mode, profile default, and chat override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clawchat-pi-router-"));
    const store = GatewayStore.open(join(directory, "gateway.sqlite"));
    const replies: string[] = [];
    const router = new ClawchatInboundRouter({
      store,
      agentUserId: "agent-user-1",
      modeDefault: "normal",
      reply: async (_message, text) => {
        replies.push(text);
      }
    });
    const full = groupMessage("/clawchat-output full", []);
    const inherit = groupMessage("/clawchat-output inherit", []);

    await router.applyAcceptedControl(full, router.classify(full));
    await router.applyAcceptedControl(inherit, router.classify(inherit));

    expect(replies).toEqual([
      "ClawChat output mode: effective full; profile default normal; override full.",
      "ClawChat output mode: effective normal; profile default normal; override inherit."
    ]);
    store.close();
  });

});

function groupMessage(text: string, mentions: unknown): ClawchatInboundMessage {
  return {
    version: "2",
    event: "message.send",
    trace_id: "trace-1",
    emitted_at: 1,
    chat_id: "group-1",
    chat_type: "group",
    sender: { id: "human-1", type: "group", nick_name: "Alice" },
    payload: {
      message_id: "msg-01HVB6S7K8L9M0N1P2Q3R4S5T6",
      message: {
        body: { fragments: [{ kind: "text", text }] },
        context: { mentions, reply: null }
      }
    }
  };
}

function imageOnlyMessage(
  mentions: unknown,
  url = "https://media.clawling.com/capabilities/image-secret"
): ClawchatInboundMessage {
  const message = groupMessage("", mentions);
  message.payload.message.body.fragments = [
    {
      kind: "image",
      url,
      name: "pixel.png",
      mime: "image/png"
    }
  ];
  return message;
}
