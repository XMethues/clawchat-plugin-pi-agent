import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadClawchatState, saveClawchatState } from "../src/state.js";

describe("ClawChat Pi state", () => {
  it("stores activation credentials in a Pi agent state file with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawchat-pi-state-"));
    const path = join(dir, "clawchat.json");

    await saveClawchatState(
      {
        baseUrl: "https://app.clawling.com",
        websocketUrl: "wss://app.clawling.com/ws",
        accessToken: "token-1",
        refreshToken: "refresh-1",
        agent: {
          id: "agent-1",
          userId: "user-1",
          ownerId: "owner-1"
        }
      },
      { path }
    );

    await expect(loadClawchatState({ path })).resolves.toMatchObject({
      accessToken: "token-1",
      websocketUrl: "wss://app.clawling.com/ws",
      agent: { userId: "user-1" }
    });
    await expect(readFile(path, "utf8")).resolves.toContain("\"accessToken\"");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("returns null when the state file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clawchat-pi-state-"));

    await expect(loadClawchatState({ path: join(dir, "missing.json") })).resolves.toBeNull();
  });
});
