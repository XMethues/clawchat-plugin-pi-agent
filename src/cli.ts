import { join } from "node:path";
import { activateClawchat, type ActivateClawchatOptions, type ActivationResult } from "./activation.js";
import { DEFAULT_BASE_URL, DEFAULT_WEBSOCKET_URL } from "./config.js";
import { GatewayStore } from "./gateway-store.js";
import { HeadlessPiHost } from "./headless-host.js";
import { HostProfileRepository } from "./host-profile.js";

export interface CliDependencies {
  profiles?: HostProfileRepository;
  activate?: (options: ActivateClawchatOptions) => Promise<ActivationResult>;
  write?: (line: string) => void;
  environment?: NodeJS.ProcessEnv;
  runHost?: (profileName: string, write: (line: string) => void) => Promise<void>;
}

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const profiles = dependencies.profiles ?? new HostProfileRepository();
  const activate = dependencies.activate ?? activateClawchat;
  const write = dependencies.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const environment = dependencies.environment ?? process.env;
  const runHost =
    dependencies.runHost ??
    ((profileName: string, status: (line: string) => void) =>
      runHostUntilSignal(profileName, profiles, status));
  const [command, ...rest] = args;

  if (command === "activate") {
    const parsed = parseCommand(rest, { positional: "invite-code", requireCwd: true });
    const prepared = await profiles.prepareActivation(parsed.profile, parsed.cwd!);
    const activation = await activate({
      code: parsed.positional!,
      baseUrl: environment.CLAWCHAT_BASE_URL ?? DEFAULT_BASE_URL,
      deviceId: prepared.deviceId
    });
    const profile = await profiles.completeActivation(parsed.profile, activation, {
      websocketUrl: environment.CLAWCHAT_WS_URL ?? DEFAULT_WEBSOCKET_URL,
      resetIdentityState: true
    });
    write(`Activated Host Profile '${profile.name}'.`);
    write(`Workspace: ${profile.workspace}`);
    write(`Device: ${profile.deviceId}`);
    return 0;
  }

  if (command === "status") {
    const parsed = parseCommand(rest, {});
    const profile = await profiles.load(parsed.profile);
    if (!profile) {
      write(`Host Profile '${parsed.profile}' is not activated.`);
      return 1;
    }
    write(`Host Profile: ${profile.name}`);
    write("Activation: active");
    write(`Workspace: ${profile.workspace}`);
    write(`Device: ${profile.deviceId}`);
    const lock = await profiles.getLockStatus(profile.name);
    write(lock.running ? `Process: running (pid ${lock.pid})` : "Process: stopped");
    const gatewayPath = join(profiles.profileDirectory(profile.name), "gateway.sqlite");
    write(`Gateway Store: ${gatewayPath}`);
    const gateway = GatewayStore.open(gatewayPath);
    try {
      const status = gateway.getStatus();
      write(`Chat Sessions: ${status.sessions.length}`);
      for (const session of status.sessions) {
        write(
          `  ${session.chatId} -> ${session.sessionId} queued=${session.queuedTurns} running=${session.runningTurns} ${session.sessionPath}`
        );
      }
      write(`Outbound pending: ${status.pendingOutbound}`);
      write(`Outbound failed: ${status.failedOutbound}`);
      write(`Inbound quarantined: ${status.quarantinedFrames}`);
    } finally {
      gateway.close();
    }
    return 0;
  }

  if (command === "run") {
    const parsed = parseCommand(rest, {});
    await runHost(parsed.profile, write);
    return 0;
  }

  write(usage());
  return command === undefined || command === "help" || command === "--help" || command === "-h" ? 0 : 1;
}

interface ParsedCommand {
  profile: string;
  cwd?: string;
  positional?: string;
}

function parseCommand(
  args: string[],
  options: { positional?: string; requireCwd?: boolean }
): ParsedCommand {
  let profile = "default";
  let cwd: string | undefined;
  let positional: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--profile") {
      profile = requireOptionValue(args, ++index, "--profile");
    } else if (argument === "--cwd") {
      cwd = requireOptionValue(args, ++index, "--cwd");
    } else if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else if (positional === undefined && options.positional) {
      positional = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }

  if (options.positional && !positional) {
    throw new Error(`Missing ${options.positional}`);
  }
  if (options.requireCwd && !cwd) {
    throw new Error("Missing --cwd <path>");
  }
  return {
    profile,
    ...(cwd ? { cwd } : {}),
    ...(positional ? { positional } : {})
  };
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`Missing value for ${option}`);
  return value;
}

function usage(): string {
  return [
    "Usage:",
    "  clawchat-pi activate <invite-code> --cwd <path> [--profile <name>]",
    "  clawchat-pi run [--profile <name>]",
    "  clawchat-pi status [--profile <name>]"
  ].join("\n");
}

async function runHostUntilSignal(
  profileName: string,
  profiles: HostProfileRepository,
  write: (line: string) => void
): Promise<void> {
  const host = new HeadlessPiHost({ profileName, profiles, onStatus: write });
  await host.start();
  write(`Host Profile '${profileName}' is online.`);
  try {
    await waitForShutdownSignal();
  } finally {
    write(`Stopping Host Profile '${profileName}'.`);
    await host.stop();
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
