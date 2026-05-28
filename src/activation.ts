export interface ActivateClawchatOptions {
  code: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
  deviceId?: string;
}

export interface ActivationResult {
  accessToken: string;
  refreshToken?: string;
  agent: {
    id?: string;
    userId: string;
    ownerId: string;
  };
  baseUrl: string;
}

interface RawActivationResponse {
  code?: unknown;
  data?: unknown;
  msg?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  agent?: {
    id?: unknown;
    user_id?: unknown;
    owner_id?: unknown;
  };
}

function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Activation response missing ${field}`);
  }
  return value.trim();
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function unwrapActivationResponse(raw: RawActivationResponse): RawActivationResponse {
  if ("data" in raw || "code" in raw || "msg" in raw) {
    if (raw.code !== 0 && raw.code !== "0") {
      const message = typeof raw.msg === "string" && raw.msg.trim() ? raw.msg.trim() : "activation failed";
      throw new Error(`ClawChat activation failed: ${message}`);
    }
    if (!raw.data || typeof raw.data !== "object") {
      throw new Error("ClawChat activation response missing data");
    }
    return raw.data as RawActivationResponse;
  }
  return raw;
}

export async function activateClawchat(options: ActivateClawchatOptions): Promise<ActivationResult> {
  const code = options.code.trim();
  if (!code) {
    throw new Error("Activation code is required");
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchFn ?? fetch;
  const response = await fetchImpl(`${baseUrl}/v1/agents/connect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-device-id": options.deviceId ?? `clawchat-pi-${crypto.randomUUID()}`
    },
    body: JSON.stringify({
      code,
      platform: "pi",
      type: "clawbot"
    })
  });

  if (!response.ok) {
    throw new Error(`ClawChat activation failed with HTTP ${response.status}`);
  }

  const raw = unwrapActivationResponse((await response.json()) as RawActivationResponse);
  const agent = raw.agent ?? {};
  const result: ActivationResult = {
    accessToken: requireTrimmedString(raw.access_token, "access_token"),
    baseUrl,
    agent: {
      userId: requireTrimmedString(agent.user_id, "agent.user_id"),
      ownerId: requireTrimmedString(agent.owner_id, "agent.owner_id")
    }
  };

  const refreshToken = optionalTrimmedString(raw.refresh_token);
  if (refreshToken) {
    result.refreshToken = refreshToken;
  }

  const agentId = optionalTrimmedString(agent.id);
  if (agentId) {
    result.agent.id = agentId;
  }

  return result;
}
