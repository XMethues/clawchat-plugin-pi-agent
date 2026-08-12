import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEDIA_URL,
  DEFAULT_REST_URL,
  DEFAULT_WEBSOCKET_URL,
  normalizeHttpOrigin,
  normalizeWebSocketUrl
} from "../src/config.js";

describe("ClawChat defaults", () => {
  it("matches the OpenClaw and Hermes production endpoints", () => {
    expect(DEFAULT_REST_URL).toBe("https://app.clawling.com");
    expect(DEFAULT_WEBSOCKET_URL).toBe("wss://app.clawling.com/ws");
    expect(DEFAULT_MEDIA_URL).toBe("https://app.clawling.com");
  });

  it("normalizes independent HTTP origins and validates WebSocket URLs", () => {
    expect(normalizeHttpOrigin("https://api.example.test/", "REST")).toBe(
      "https://api.example.test"
    );
    expect(normalizeWebSocketUrl("wss://gateway.example.test/ws", "WebSocket")).toBe(
      "wss://gateway.example.test/ws"
    );
    expect(() => normalizeHttpOrigin("https://api.example.test/v1", "REST")).toThrow(
      "without credentials, path, query, or fragment"
    );
    expect(() => normalizeWebSocketUrl("https://gateway.example.test/ws", "WebSocket")).toThrow(
      "must use WS or WSS"
    );
  });
});
