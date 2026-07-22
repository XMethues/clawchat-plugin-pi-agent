# ClawChat Pi

This context covers the headless Pi runtime and extension that let ClawChat act as the user-facing interface for isolated, persistent Pi sessions over ClawChat Protocol v2.

## Language

**ClawChat Pi Package**:
The installable package that ships both the reusable ClawChat Pi Extension and the `clawchat-pi` Headless Pi Host executable while keeping one shared protocol implementation.
_Avoid_: extension-only package, two independent adapters

**ClawChat Pi Extension**:
A Pi extension package loaded into a Pi runtime that presents ClawChat messages to the active Pi session and publishes Pi responses back through ClawChat.
_Avoid_: Pi agent bridge, standalone Pi agent, generic ClawChat client, Pi SDK adapter

**Headless Pi Host**:
The long-lived, non-interactive Node.js process that runs one Host Profile, embeds Pi through the SDK, owns its ClawChat Gateway and Chat Session Registry, and loads a ClawChat Pi Extension for each active Pi runtime.
_Avoid_: hidden Pi process, TUI, standalone extension

**Host Profile**:
The local runtime configuration that binds one ClawChat agent identity and stable device to one Workspace and one Chat Session namespace. Run another profile for another Workspace.
_Avoid_: project binding, dynamic workspace, shared agent profile

**Activation**:
The invite-code exchange that creates or refreshes a Host Profile's ClawChat credentials and stable identity. Headless use enters through the local `clawchat-pi activate` command, while an interactive Pi host may enter through `/clawchat-activate`; both persist the same state.
_Avoid_: project binding, chat login, separate CLI credentials

**Workspace**:
The locally configured Pi `cwd` and its project resources, tools, and context files. Every Chat Session in a Host Profile uses the same Workspace.
_Avoid_: chat-selected project, remote path, arbitrary cwd

**ClawChat Gateway**:
The single ClawChat Protocol v2 connection for a Host Profile that owns handshake, reconnect, replay, deduplication, acknowledgements, and frame transport for every chat handled by that profile.
_Avoid_: per-session WebSocket, session transport

**Gateway Store**:
The per-Host-Profile SQLite record that durably owns accepted inbound frames, deduplication keys, reliable-delivery admission state, Chat Turn Queues, Chat Session mappings, and materialized outbound delivery attempts. It does not store Pi conversation context, which remains in Pi's native session JSONL files.
_Avoid_: Pi session database, in-memory queue, global state database

**Online Host Profile**:
A started Headless Pi Host that continuously maintains or reconnects its ClawChat Gateway until the process is stopped. A temporary network interruption does not end the profile's online lifetime.
_Avoid_: request-scoped connection, disconnect-driven shutdown

**Chat Session**:
An isolated, persistent Pi session identified by one ClawChat `chat_id`. Direct and group chats use the same isolation rule, and different chats never share model context.
_Avoid_: shared agent session, sender session, global conversation

**Chat Session Registry**:
The Headless Pi Host component that automatically resolves each inbound `chat_id` to exactly one Chat Session in the Host Profile's Workspace and owns creation and restoration of its `AgentSessionRuntime`. Once loaded, that runtime remains resident for the Online Host Profile's lifetime and is disposed during Host shutdown rather than by an idle timeout or LRU policy.
_Avoid_: message router, global session

**Chat Turn Queue**:
The durable FIFO queue owned by one Chat Session for messages accepted while that session is busy. A session dispatches only one Pi turn at a time and starts the next item after the current turn settles; different Chat Sessions may run concurrently. Queued messages neither interrupt nor steer the active turn, and admission does not produce a separate busy acknowledgement in chat.
_Avoid_: global queue, interrupt-on-message, steer, concurrent turns

**Group Dispatch Mode**:
The per-group policy `mention`, `all`, or `muted` that controls whether an accepted ClawChat message enters its Chat Session. `muted` still consumes, deduplicates, and acknowledges frames but never dispatches them to Pi; direct chats always dispatch, while groups default to `mention`.
_Avoid_: subscription state, WebSocket mute, replay pause

**Execution Authority**:
The native tool and operating-system authority of the Pi process. The ClawChat integration does not add owner-only execution, group read-only behavior, tool allowlists, approval prompts, or a sandbox; every message admitted by its Group Dispatch Mode runs with the same Pi configuration and process permissions.
_Avoid_: ClawChat permission gate, sender-based tool policy, implicit sandbox

**Reply Delivery**:
The non-token-streaming projection of Pi output into complete materialized ClawChat messages. Final assistant text is forwarded without adapter-authored rewriting; completed thinking output is also forwarded when the Chat Session's native Pi thinking level is enabled, while tool-call visibility is controlled by persisted ClawChat output configuration that can be changed through an Extension slash command. A turn may therefore produce more than one complete message, but never `message.created` / `message.add` / `message.done` lifecycle frames or synthetic failure prose; `typing.update` brackets the active turn.
_Avoid_: token streaming, synthetic assistant reply, adapter-owned thinking switch, unconditional tool progress

**Tool Output Visibility**:
The effective `on` or `off` policy for materializing completed Pi tool calls in ClawChat. A Host Profile provides the default, and each Chat Session may persist an `on`, `off`, or `inherit` override through `/clawchat-output tools`; `inherit` removes the session override and follows the profile default. A command in one chat never changes another chat's override.
_Avoid_: global-only toggle, model instruction, tool execution policy

**Active Session Owner**:
The single running Pi runtime allowed to operate one persisted Chat Session. A Headless Pi Host and a separate Pi TUI must not concurrently own the same session, although one host may own multiple different Chat Sessions.
_Avoid_: shared session process, concurrent session writer

**Session Handoff**:
Sequential transfer of a persisted Pi session between the Headless Pi Host and Pi TUI after the current Active Session Owner has stopped.
_Avoid_: live session sharing, simultaneous TUI attachment
