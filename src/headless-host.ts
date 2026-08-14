import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ClawchatAwarenessCoordinator } from "./clawchat-awareness.js";
import { ClawchatPlaintextHistorySync } from "./clawchat-history-sync.js";
import {
  ClawChatGateway,
  isClawchatGatewayEvent,
  type ClawchatGatewayEvent
} from "./gateway.js";
import { GatewayStore } from "./gateway-store.js";
import {
  HostProfileRepository,
  type HostProfileOperationLease
} from "./host-profile.js";
import { ClawchatInboundRouter } from "./inbound-router.js";
import { ClawchatOutputProjector } from "./output-projector.js";
import {
  PiChatSessionFactory,
  type PiChatSessionFactoryOptions
} from "./pi-session-factory.js";
import { ChatSessionRegistry } from "./session-registry.js";
import type { ClawchatInboundMessage, ClawchatTransport } from "./types.js";

const STOP_ABORT_TIMEOUT_MS = 2_000;
import { createClawchatToolRuntime } from "./clawchat-runtime.js";

export interface HeadlessPiHostOptions {
  profileName?: string;
  agentDir?: string;
  profiles?: HostProfileRepository;
  onStatus?: (status: string) => void;
  onAwarenessSignal?: (event: ClawchatGatewayEvent) => Promise<void>;
  onHistoryTransit?: (event: ClawchatGatewayEvent) => Promise<void>;
  onDeliveryReceipt?: (event: ClawchatGatewayEvent) => Promise<void> | void;
  recoveryRetryDelay?: (attempt: number) => number;
  gatewayReconnectDelay?: (attempt: number) => number;
  createAgentSessionFn?: PiChatSessionFactoryOptions["createAgentSessionFn"];
}

export class HeadlessPiHost {
  private readonly profileName: string;
  private readonly agentDir: string;
  private readonly profiles: HostProfileRepository;
  private readonly onStatus: ((status: string) => void) | undefined;
  private readonly onAwarenessSignal: ((event: ClawchatGatewayEvent) => Promise<void>) | undefined;
  private readonly onHistoryTransit: ((event: ClawchatGatewayEvent) => Promise<void>) | undefined;
  private readonly onDeliveryReceipt: ((event: ClawchatGatewayEvent) => Promise<void> | void) | undefined;
  private readonly recoveryRetryDelay: ((attempt: number) => number) | undefined;
  private readonly gatewayReconnectDelay: ((attempt: number) => number) | undefined;
  private readonly createAgentSessionFn: PiChatSessionFactoryOptions["createAgentSessionFn"];
  private operationLease: HostProfileOperationLease | undefined;
  private store: GatewayStore | undefined;
  private gateway: ClawChatGateway | undefined;
  private registry: ChatSessionRegistry | undefined;
  private readonly awarenessRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly historyRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private recoveryRetryTimer: NodeJS.Timeout | undefined;
  private recoveryInFlight: Promise<void> | undefined;
  private recoveryRequested = false;
  private recoveryAttempt = 0;
  private stopping = false;
  private started = false;

  constructor(options: HeadlessPiHostOptions = {}) {
    this.profileName = options.profileName ?? "default";
    this.agentDir = options.agentDir ?? getAgentDir();
    this.profiles = options.profiles ??
      new HostProfileRepository({
        agentDir: this.agentDir,
        ...(process.env.CLAWCHAT_MEDIA_URL
          ? { legacyMediaUrl: process.env.CLAWCHAT_MEDIA_URL }
          : {})
      });
    this.onStatus = options.onStatus;
    this.onAwarenessSignal = options.onAwarenessSignal;
    this.onHistoryTransit = options.onHistoryTransit;
    this.onDeliveryReceipt = options.onDeliveryReceipt;
    this.recoveryRetryDelay = options.recoveryRetryDelay;
    this.gatewayReconnectDelay = options.gatewayReconnectDelay;
    this.createAgentSessionFn = options.createAgentSessionFn;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (this.started) throw new Error("Headless Pi Host is already started");
    this.recoveryRequested = false;
    this.recoveryAttempt = 0;
    this.operationLease = await this.profiles.acquireOperationLease(this.profileName);

    try {
      const profile = await this.profiles.load(this.profileName);
      if (!profile) throw new Error(`Host Profile '${this.profileName}' is not activated`);
      const toolRuntime = await createClawchatToolRuntime({
        profiles: this.profiles,
        profileName: this.profileName
      });
      const profileDirectory = this.profiles.profileDirectory(this.profileName);
      const store = GatewayStore.open(join(profileDirectory, "gateway.sqlite"));
      this.store = store;
      let gateway: ClawChatGateway | undefined;
      const transport: ClawchatTransport = {
        send: async (message) => {
          if (!gateway) throw new Error("ClawChat Gateway is not started");
          await gateway.send(message);
        }
      };
      const replyProjector = new ClawchatOutputProjector({ transport });
      const reply = async (message: ClawchatInboundMessage, text: string): Promise<void> => {
        await replyProjector.replyTo(message, text);
      };
      const router = new ClawchatInboundRouter({
        store,
        agentUserId: profile.agent.userId,
        agentOwnerId: profile.agent.ownerId,
        modeDefault: profile.output.modeDefault,
        reply
      });
      const factory = new PiChatSessionFactory({
        workspace: profile.workspace,
        agentDir: this.agentDir,
        store,
        transport,
        outputModeDefault: profile.output.modeDefault,
        media: { rootDir: join(profileDirectory, "inbound-media") },
        ...(this.createAgentSessionFn
          ? { createAgentSessionFn: this.createAgentSessionFn }
          : {}),
        tools: {
          ...toolRuntime.environment,
          sendFrame: async (frame) => {
            if (!gateway) throw new Error("ClawChat Gateway is not started");
            await gateway.send(frame);
          },
          recordToolCall: (record) => store.recordToolCall(record),
          onConversationLeft: async (chatId) => {
            void this.registry?.deleteConversation(chatId).catch((error: unknown) => {
              this.onStatus?.(
                `conversation ${chatId} deletion failed: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          }
        }
      });
      await factory.cleanupStaleInboundMedia();
      const registry = new ChatSessionRegistry({
        store,
        factory,
        reply,
        onError: (error, work) => {
          this.onStatus?.(
            `work ${work.id} interrupted: ${error instanceof Error ? error.message : String(error)}`
          );
        },
        onWorkerError: (error, chatId) => {
          this.onStatus?.(
            `chat ${chatId} worker failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      });
      this.registry = registry;
      const awarenessOwnerChatId = profile.ownerChatId;
      const awarenessAgentId = profile.agent.id;
      const awareness = awarenessOwnerChatId && awarenessAgentId
        ? new ClawchatAwarenessCoordinator({
            api: toolRuntime.environment.api,
            store,
            ownerChatId: awarenessOwnerChatId,
            agentId: awarenessAgentId,
            agentUserId: profile.agent.userId,
            agentOwnerId: profile.agent.ownerId,
            memory: toolRuntime.environment.memory,
            wake: (chatId) => {
              if (this.stopping) return;
              void registry.wake(chatId).catch((error: unknown) => {
                this.onStatus?.(
                  `awareness turn for ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`
                );
              });
            },
            observeConversation: (chatId) => {
              if (!this.stopping) registry.ensureConversation(chatId);
            },
            deleteConversation: async (chatId) => {
              if (!this.stopping) await registry.deleteConversation(chatId);
            },
          })
        : undefined;
      const historySync = new ClawchatPlaintextHistorySync({
        api: toolRuntime.environment.api,
        store,
        deviceId: profile.deviceId,
        userId: profile.agent.userId,
        send: async (frame) => {
          if (!gateway) throw new Error("ClawChat Gateway is not started");
          await gateway.send(frame);
        }
      });

      gateway = new ClawChatGateway({
        websocketUrl: profile.websocketUrl,
        accessToken: toolRuntime.profile().accessToken,
        refreshAccessToken: toolRuntime.refreshAccessToken,
        deviceId: profile.deviceId,
        userId: profile.agent.userId,
        store,
        classifyInbound: (message) => router.classify(message),
        onAcceptedControl: async (message, decision, result) => {
          if (decision.stop) {
            // Bound the Pi abort so a stuck runtime cannot stall the gateway
            // frame queue while the /stop frame is being processed.
            const stopped = await registry.stop(message.chat_id, {
              abortTimeoutMs: STOP_ABORT_TIMEOUT_MS
            });
            await reply(
              message,
              `Stopped: active turn ${stopped.interrupted ? "interrupted" : "not running"}; queued work cancelled ${result.cancelledWork}.`
            );
            return;
          }
          await router.applyAcceptedControl(message, decision);
        },
        onConversationObserved: (message) => {
          if (!this.stopping) registry.ensureConversation(message.chat_id);
        },
        onInboundMessage: async (message) => {
          void registry.wake(message.chat_id).catch((error: unknown) => {
            this.onStatus?.(
              `chat ${message.chat_id} worker failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        },
        ...(awareness
          ? {
              onAwarenessSignal: async (event: ClawchatGatewayEvent) => {
                void (async () => {
                  await this.processAwareness(awareness, event);
                  await this.onAwarenessSignal?.(event);
                })().catch((error: unknown) => {
                  this.onStatus?.(
                    `awareness observer failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  );
                });
              },
              onConnectionReady: () => {
                this.requestRecovery(awareness);
              }
            }
          : {}),
        onHistoryTransit: async (event: ClawchatGatewayEvent) => {
          void (async () => {
            await this.processHistory(historySync, event);
            await this.onHistoryTransit?.(event);
          })().catch((error: unknown) => {
            this.onStatus?.(
              `history observer failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
        },
        onDeliveryReceipt: async (event) => {
          this.onStatus?.(`message ${String(event.payload?.message_id ?? "unknown")} delivered`);
          await this.onDeliveryReceipt?.(event);
        },
        ...(this.gatewayReconnectDelay
          ? { reconnectDelay: this.gatewayReconnectDelay }
          : {}),
        ...(this.onStatus ? { onStatus: this.onStatus } : {})
      });
      this.gateway = gateway;
      registry.start();
      await gateway.start();
      if (awareness) {
        for (const frame of store.listReliableFrames("notify.signal")) {
          if (isClawchatGatewayEvent(frame)) await this.processAwareness(awareness, frame);
        }
      }
      for (const frame of store.listReliableFrames("history.transit")) {
        if (isClawchatGatewayEvent(frame)) await this.processHistory(historySync, frame);
      }
      this.started = true;
    } catch (error: unknown) {
      await this.stopComponents();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.stopComponents();
  }

  private async processAwareness(
    awareness: ClawchatAwarenessCoordinator,
    event: ClawchatGatewayEvent,
    attempt = 0
  ): Promise<void> {
    try {
      await awareness.handle(event);
    } catch (error: unknown) {
      if (this.stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      this.onStatus?.(
        `awareness refresh failed; retrying in ${delay}ms: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      const timer = setTimeout(() => {
        this.awarenessRetryTimers.delete(timer);
        void this.processAwareness(awareness, event, attempt + 1);
      }, delay);
      this.awarenessRetryTimers.add(timer);
    }
  }

  private requestRecovery(awareness: ClawchatAwarenessCoordinator): void {
    if (this.stopping) return;
    this.recoveryRequested = true;
    if (this.recoveryRetryTimer) {
      clearTimeout(this.recoveryRetryTimer);
      this.recoveryRetryTimer = undefined;
    }
    this.startRecovery(awareness);
  }

  private startRecovery(awareness: ClawchatAwarenessCoordinator): void {
    if (this.stopping || this.recoveryInFlight || !this.recoveryRequested) return;
    this.recoveryRequested = false;
    const recovery = (async () => {
      try {
        await awareness.recover();
        this.recoveryAttempt = 0;
      } catch (error: unknown) {
        if (this.stopping) return;
        this.recoveryRequested = true;
        const configuredDelay = this.recoveryRetryDelay?.(this.recoveryAttempt);
        const delay = Math.max(
          0,
          Math.min(
            30_000,
            configuredDelay ?? 1_000 * 2 ** Math.min(this.recoveryAttempt, 5)
          )
        );
        this.recoveryAttempt += 1;
        this.onStatus?.(
          `metadata recovery failed; retrying in ${delay}ms: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        this.recoveryRetryTimer = setTimeout(() => {
          this.recoveryRetryTimer = undefined;
          this.startRecovery(awareness);
        }, delay);
      }
    })();
    this.recoveryInFlight = recovery;
    void recovery.finally(() => {
      if (this.recoveryInFlight === recovery) this.recoveryInFlight = undefined;
      if (!this.recoveryRetryTimer) this.startRecovery(awareness);
    });
  }

  private async processHistory(
    historySync: ClawchatPlaintextHistorySync,
    event: ClawchatGatewayEvent,
    attempt = 0
  ): Promise<void> {
    try {
      await historySync.handle(event);
    } catch (error: unknown) {
      if (this.stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      this.onStatus?.(
        `history sync failed; retrying in ${delay}ms: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      const timer = setTimeout(() => {
        this.historyRetryTimers.delete(timer);
        void this.processHistory(historySync, event, attempt + 1);
      }, delay);
      this.historyRetryTimers.add(timer);
    }
  }

  private async stopComponents(): Promise<void> {
    this.started = false;
    this.stopping = true;
    for (const timer of this.awarenessRetryTimers) clearTimeout(timer);
    this.awarenessRetryTimers.clear();
    for (const timer of this.historyRetryTimers) clearTimeout(timer);
    this.historyRetryTimers.clear();
    clearTimeout(this.recoveryRetryTimer);
    this.recoveryRetryTimer = undefined;
    this.recoveryRequested = false;

    const registry = this.registry;
    this.registry = undefined;
    const registryShutdown = registry?.shutdown({ graceMs: 0 });
    const recovery = this.recoveryInFlight;
    await recovery;
    if (this.recoveryInFlight === recovery) this.recoveryInFlight = undefined;

    await registryShutdown;

    const gateway = this.gateway;
    this.gateway = undefined;
    await gateway?.stop();

    const store = this.store;
    this.store = undefined;
    store?.close();

    const operationLease = this.operationLease;
    await operationLease?.release();
    if (this.operationLease === operationLease) this.operationLease = undefined;
  }
}
