import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_WEBSOCKET_URL } from "../src/config.js";

describe("ClawChat defaults", () => {
  it("matches the OpenClaw and Hermes production endpoints", () => {
    expect(DEFAULT_BASE_URL).toBe("https://app.clawling.com");
    expect(DEFAULT_WEBSOCKET_URL).toBe("wss://app.clawling.com/ws");
  });
});
