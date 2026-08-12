import { join } from "node:path";
import { ClawchatApiClient } from "./clawchat-api.js";
import { ClawchatMemoryStore, clawchatMemoryTarget } from "./clawchat-memory.js";
import type { ClawchatToolEnvironment } from "./clawchat-tools.js";
import { HostProfileRepository, type HostProfile } from "./host-profile.js";

export interface ClawchatToolRuntime {
  environment: ClawchatToolEnvironment;
  profile: () => HostProfile;
  refreshAccessToken: () => Promise<string>;
}

export async function createClawchatToolRuntime(options: {
  profiles: HostProfileRepository;
  profileName: string;
}): Promise<ClawchatToolRuntime> {
  const loadedProfile = await options.profiles.load(options.profileName);
  if (!loadedProfile) throw new Error(`Host Profile '${options.profileName}' is not activated`);
  let profile: HostProfile = loadedProfile;
  let refreshInFlight: Promise<string> | undefined;
  let api: ClawchatApiClient;

  const refreshAccessToken = async (): Promise<string> => {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        if (!profile.refreshToken) throw new Error("Host Profile does not contain a refresh token");
        const rotated = await api.refresh(profile.refreshToken, profile.deviceId);
        profile = await options.profiles.updateTokens(
          options.profileName,
          rotated.accessToken,
          rotated.refreshToken
        );
        return profile.accessToken;
      })().finally(() => {
        refreshInFlight = undefined;
      });
    }
    return refreshInFlight;
  };

  api = new ClawchatApiClient({
    baseUrl: profile.baseUrl,
    mediaBaseUrl: websocketHttpOrigin(profile.websocketUrl),
    accessToken: () => profile.accessToken,
    refreshAccessToken: async () => {
      await refreshAccessToken();
    }
  });
  const memory = new ClawchatMemoryStore(
    join(options.profiles.profileDirectory(options.profileName), "memory")
  );
  const ownerTarget = clawchatMemoryTarget("owner", "owner");
  const ownerMemory = await memory.read(ownerTarget);
  await memory.writeMetadata(ownerTarget, {
    ...ownerMemory.metadata,
    agent_user_id: profile.agent.userId,
    agent_owner_id: profile.agent.ownerId
  });

  return {
    profile: () => profile,
    refreshAccessToken,
    environment: {
      profile: () => profile,
      api,
      memory
    }
  };
}

function websocketHttpOrigin(websocketUrl: string): string {
  const url = new URL(websocketUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}
