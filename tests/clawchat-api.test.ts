import { describe, expect, it, vi } from "vitest";
import { ClawchatApiClient, ClawchatApiError } from "../src/clawchat-api.js";

describe("ClawchatApiClient", () => {
  it("refreshes and retries one 401 with the rotated bearer token", async () => {
    let accessToken = "access-1";
    const seenTokens: string[] = [];
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenTokens.push(headers.get("authorization") ?? "");
      if (seenTokens.length === 1) {
        return jsonResponse({ code: 10003, msg: "expired", data: null }, 401);
      }
      return jsonResponse({ code: 0, data: { id: "user-1" } });
    });
    const refreshAccessToken = vi.fn(async () => {
      accessToken = "access-2";
    });
    const api = new ClawchatApiClient({
      restUrl: "https://app.clawling.com",
      mediaUrl: "https://app.clawling.com",
      accessToken: () => accessToken,
      refreshAccessToken,
      fetchFn: fetchFn as typeof fetch
    });

    await expect(api.get("/v1/users/me")).resolves.toEqual({ id: "user-1" });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(seenTokens).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("does not retry transport failures", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const api = new ClawchatApiClient({
      restUrl: "https://app.clawling.com",
      mediaUrl: "https://app.clawling.com",
      accessToken: () => "access-1",
      fetchFn: fetchFn as typeof fetch
    });

    const error = await api.get("/v1/users/me").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ClawchatApiError);
    expect(error).toMatchObject({ kind: "transport", options: { retryable: true } });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("parses rotated tokens only from a successful refresh envelope", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({
      code: 0,
      data: { access_token: " opaque-access ", refresh_token: " opaque-refresh " }
    }));
    const api = new ClawchatApiClient({
      restUrl: "https://app.clawling.com",
      mediaUrl: "https://media.example.test",
      accessToken: () => "access-1",
      fetchFn: fetchFn as typeof fetch
    });

    await expect(api.refresh(" refresh input ", "device-1")).resolves.toEqual({
      accessToken: " opaque-access ",
      refreshToken: " opaque-refresh "
    });
    expect(fetchFn).toHaveBeenCalledWith("https://app.clawling.com/v1/auth/refresh", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ refresh_token: " refresh input " })
    }));
  });
  it("routes media uploads to the gateway origin without moving REST uploads", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse({ code: 0, data: { url: "https://cdn.example/file", mime: "text/plain", size: 1 } });
    });
    const api = new ClawchatApiClient({
      restUrl: "https://api.example.test",
      mediaUrl: "https://gateway.example.test",
      accessToken: () => "access-1",
      fetchFn: fetchFn as typeof fetch
    });
    const file = { bytes: new Uint8Array([65]), filename: "a.txt", mime: "text/plain" };

    await api.upload("/media/upload", file);
    await api.upload("/v1/files/upload-url", file);

    expect(urls).toEqual([
      "https://gateway.example.test/media/upload",
      "https://api.example.test/v1/files/upload-url"
    ]);
  });

  it("refreshes and retries media uploads rejected with code 40101", async () => {
    let accessToken = "access-1";
    const seenTokens: string[] = [];
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      if (seenTokens.length === 1) {
        return jsonResponse({ code: 40101, msg: "invalid token", data: null }, 401);
      }
      return jsonResponse({ code: 0, data: { url: "https://cdn.example/file" } });
    });
    const refreshAccessToken = vi.fn(async () => {
      accessToken = "access-2";
    });
    const api = new ClawchatApiClient({
      restUrl: "https://api.example.test",
      mediaUrl: "https://gateway.example.test",
      accessToken: () => accessToken,
      refreshAccessToken,
      fetchFn: fetchFn as typeof fetch
    });

    await expect(api.upload("/media/upload", {
      bytes: new Uint8Array([65]),
      filename: "a.txt",
      mime: "text/plain"
    })).resolves.toEqual({ url: "https://cdn.example/file" });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(seenTokens).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("uses envelope codes as the response and authentication authority", async () => {
    let accessToken = "access-1";
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 10003, msg: "expired", data: null }, 200))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: "user-1" } }, 503))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { id: "user-2" } }, 500));
    const refreshAccessToken = vi.fn(async () => {
      accessToken = "access-2";
    });
    const api = new ClawchatApiClient({
      restUrl: "https://app.clawling.com",
      mediaUrl: "https://app.clawling.com",
      accessToken: () => accessToken,
      refreshAccessToken,
      fetchFn: fetchFn as typeof fetch
    });

    await expect(api.get("/v1/users/me")).resolves.toEqual({ id: "user-1" });
    await expect(api.get("/v1/users/user-2")).resolves.toEqual({ id: "user-2" });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
