import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClawchatMemoryStore, clawchatMemoryTarget } from "../src/clawchat-memory.js";

describe("ClawchatMemoryStore", () => {
  it("injects owner and current-group memory but never user memory automatically", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawchat-pi-memory-"));
    const memory = new ClawchatMemoryStore(root);
    await memory.writeBody(clawchatMemoryTarget("owner", "owner"), "replace", "owner preference");
    await memory.writeBody(clawchatMemoryTarget("group", "group-1"), "replace", "group rule");
    await memory.writeBody(clawchatMemoryTarget("user", "user-1"), "replace", "private user note");

    const direct = await memory.renderTurnContext({ chatType: "direct", chatId: "chat-1" });
    expect(direct).toContain("owner preference");
    expect(direct).not.toContain("private user note");

    const group = await memory.renderTurnContext({ chatType: "group", chatId: "group-1" });
    expect(group).toContain("owner preference");
    expect(group).toContain("group rule");
    expect(group).not.toContain("private user note");
    await expect(memory.read(clawchatMemoryTarget("user", "user-1"))).resolves.toMatchObject({
      body: "private user note"
    });
  });

  it("rejects traversal-like explicit target ids", async () => {
    expect(() => clawchatMemoryTarget("user", "../owner")).toThrow("single safe file id");
  });
});
