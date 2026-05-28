import { describe, expect, it, vi } from "vitest";
import { activateClawchat } from "../src/activation.js";

describe("activateClawchat", () => {
  it("exchanges an invite code with the pi platform", async () => {
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "token-1",
          agent: {
            id: "agent-1",
            user_id: "user-1",
            owner_id: "owner-1"
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await activateClawchat({
      code: "invite-1",
      baseUrl: "https://clawchat.example",
      fetchFn
    });

    expect(result.accessToken).toBe("token-1");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://clawchat.example/v1/agents/connect",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-device-id": expect.stringContaining("clawchat-pi")
        }),
        body: JSON.stringify({
          code: "invite-1",
          platform: "pi",
          type: "clawbot"
        })
      })
    );
  });
});
