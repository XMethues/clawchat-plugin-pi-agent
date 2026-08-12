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
      restUrl: "https://clawchat.example/",
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

  it("accepts opaque credentials from the production response envelope unchanged", async () => {
    const accessToken = "deliberately-not-a-jwt";
    const refreshToken = "opaque refresh token";
    const fetchFn = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            access_token: accessToken,
            refresh_token: refreshToken,
            agent: {
              id: "agent-2",
              user_id: "user-2",
              owner_id: "owner-2"
            },
            conversation: {
              id: "owner-chat-2"
            }
          },
          msg: "ok"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const result = await activateClawchat({
      code: "invite-2",
      restUrl: "https://app.clawling.com/",
      fetchFn
    });

    expect(result).toMatchObject({
      accessToken,
      refreshToken,
      restUrl: "https://app.clawling.com",
      agent: { id: "agent-2", userId: "user-2", ownerId: "owner-2" },
      ownerChatId: "owner-chat-2"
    });
  });

  it.each([
    ["agent.id", { user_id: "user-2", owner_id: "owner-2" }],
    ["agent.user_id", { id: "agent-2", owner_id: "owner-2" }],
    ["agent.owner_id", { id: "agent-2", user_id: "user-2" }]
  ])("rejects an activation response missing %s", async (field, agent) => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "opaque", agent }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      activateClawchat({
        code: "invite",
        restUrl: "https://app.clawling.com",
        fetchFn
      })
    ).rejects.toThrow(`Activation response missing ${field}`);
  });
});
