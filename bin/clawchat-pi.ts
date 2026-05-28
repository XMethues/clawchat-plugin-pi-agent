#!/usr/bin/env node
import { activateClawchat, ClawchatPiAdapter, ClawchatWebSocketClient, createPiSdkSession } from "../src/index.js";
import { DEFAULT_BASE_URL, DEFAULT_WEBSOCKET_URL } from "../src/config.js";

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  if (command === "activate") {
    const baseUrl = process.env.CLAWCHAT_BASE_URL ?? DEFAULT_BASE_URL;
    const result = await activateClawchat({
      code: arg ?? "",
      baseUrl
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command !== "start") {
    console.error("Usage: clawchat-pi activate <code> | start");
    process.exitCode = 1;
    return;
  }

  const accessToken = process.env.CLAWCHAT_TOKEN;
  if (!accessToken) {
    throw new Error("CLAWCHAT_TOKEN is required for start");
  }

  const session = await createPiSdkSession({
    cwd: process.env.CLAWCHAT_PI_CWD ?? process.cwd()
  });

  let adapter: ClawchatPiAdapter | undefined;
  const client = new ClawchatWebSocketClient({
    websocketUrl: process.env.CLAWCHAT_WS_URL ?? DEFAULT_WEBSOCKET_URL,
    accessToken,
    deviceId: process.env.CLAWCHAT_DEVICE_ID ?? "clawchat-pi",
    onStatus: (message) => console.error(message),
    onInboundMessage: async (message) => {
      if (!adapter) throw new Error("Adapter not initialized");
      await adapter.handleInboundMessage(message);
    }
  });

  adapter = new ClawchatPiAdapter({ session, transport: client });
  await client.connect();

  process.once("SIGINT", () => {
    adapter?.dispose();
    client.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
