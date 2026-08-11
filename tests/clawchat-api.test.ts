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
      baseUrl: "https://app.clawling.com",
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
      baseUrl: "https://app.clawling.com",
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
      data: { access_token: "access-2", refresh_token: "refresh-2" }
    }));
    const api = new ClawchatApiClient({
      baseUrl: "https://app.clawling.com",
      accessToken: () => "access-1",
      fetchFn: fetchFn as typeof fetch
    });

    await expect(api.refresh("refresh-1", "device-1")).resolves.toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2"
    });
    expect(fetchFn).toHaveBeenCalledWith("https://app.clawling.com/v1/auth/refresh", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ refresh_token: "refresh-1" })
    }));
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
