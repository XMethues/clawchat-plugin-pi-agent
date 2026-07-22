import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayStore } from "../src/gateway-store.js";
import { PiChatSessionFactory } from "../src/pi-session-factory.js";

describe("PiChatSessionFactory", () => {
  it("creates isolated native Pi session paths in the Host Profile Workspace", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const sessionDir = join(agentDir, "sessions");
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir,
      store,
      transport: { send: async () => undefined }
    });

    const first = factory.createSession("chat-1");
    const second = factory.createSession("chat-2");

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(first.sessionPath).not.toBe(second.sessionPath);
    expect(first.sessionPath.startsWith(sessionDir)).toBe(true);
    expect(second.sessionPath.endsWith(".jsonl")).toBe(true);
    store.close();
  });

  it("opens and disposes an embedded Pi SDK runtime for a mapped chat", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const factory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      store,
      transport: { send: async () => undefined }
    });
    const created = factory.createSession("chat-1");

    const driver = await factory.openSession({ chatId: "chat-1", ...created });

    await expect(driver.dispose()).resolves.toBeUndefined();
    store.close();
  });

  it("recovers an unmaterialized Pi session with the same session ID after restart", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "clawchat-pi-sdk-"));
    const workspace = join(agentDir, "project");
    const sessionDir = join(agentDir, "sessions");
    await mkdir(workspace);
    const store = GatewayStore.open(join(agentDir, "gateway.sqlite"));
    const firstFactory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir,
      store,
      transport: { send: async () => undefined }
    });
    const original = store.getOrCreateChatSession("chat-1", () => firstFactory.createSession("chat-1"));
    const restartedFactory = new PiChatSessionFactory({
      workspace,
      agentDir,
      sessionDir,
      store,
      transport: { send: async () => undefined }
    });

    const driver = await restartedFactory.openSession(original);

    const recovered = store.getChatSession("chat-1");
    expect(recovered?.sessionId).toBe(original.sessionId);
    expect(recovered?.sessionPath).toContain(original.sessionId);
    await driver.dispose();
    store.close();
  });
});
