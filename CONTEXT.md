# ClawChat Pi

This context covers the Headless Pi Host and management extension that let ClawChat act as the user-facing interface for isolated, persistent Pi sessions over ClawChat Protocol v2 without tying the ClawChat connection to an ordinary Pi TUI.

## Language

**ClawChat Pi Package**:
The installable package that ships the ClawChat Pi Management Extension, ClawChat Pi Skills, and the `clawchat-pi` Headless Pi Host executable while keeping one shared integration core.
_Avoid_: extension-only package, two independent adapters

**ClawChat Pi Management Extension**:
The package extension loaded by an ordinary Pi TUI for local Activation, Host Profile configuration, and ClawChat REST or local tools. It never owns a ClawChat Gateway or receives remote Chat Turns.
_Avoid_: chat runtime extension, WebSocket extension, second Gateway owner

**ClawChat Pi Skill**:
Pi-native operating guidance packaged with the ClawChat Pi Package and automatically discovered alongside its extension in ordinary and Headless Pi runtimes.
_Avoid_: extension source-code behavior, runtime-downloaded prompt

**Headless Pi Host**:
The long-lived, non-interactive Node.js process that runs one Host Profile, embeds Pi through the SDK, exclusively owns its ClawChat Gateway and Chat Session Registry, and creates a Hosted Session Binding for each loaded Chat Session.
_Avoid_: hidden Pi process, TUI, standalone extension, shared Gateway owner

**Hosted Session Binding**:
The Host-minted binding that gives one Headless Chat Session its Active ClawChat Turn, ClawChat tools, and Reply Delivery through the Host-owned integration core. It cannot create, start, stop, or reconnect a ClawChat Gateway.
_Avoid_: per-session Gateway, public runtime client, standalone session extension

**Host Profile**:
The local runtime configuration that binds one ClawChat agent identity and stable device at a time to one Workspace and one Chat Session namespace. Run another profile for another Workspace.
_Avoid_: project binding, dynamic workspace, shared agent profile

**ClawChat Tool State**:
The Host-Profile-owned social memory, synchronized metadata, registered-app state, and tool-call history used by ClawChat tools. It is never shared across Host Profiles, even when they bind the same Workspace.
_Avoid_: Workspace tool state, global ClawChat memory, shared social cache

**Turn Memory Context**:
The bounded, read-only snapshot injected at turn start: owner memory for every ClawChat turn plus current-group memory for a Group Chat. User memory is never injected automatically and must be read through an explicit tool target.
_Avoid_: user-memory auto-injection, global memory dump, mutable mid-turn memory

**Activation**:
The invite-code exchange that creates a Host Profile or explicitly rebinds an existing Host Profile while preserving its stable device and Workspace.
_Avoid_: token refresh, project binding, chat login, implicit background identity switch

**Profile Rebinding**:
The second explicit Activation of an existing Host Profile. It preserves only the Host Profile's stable device and Workspace while clearing the former identity's Gateway Store, ClawChat Tool State, profile-local Skill root, Chat Session mappings, queues, and mapped Pi session history.
_Avoid_: token refresh, `--new-account` mode, device rotation, Workspace reset

**ClawChat Control Command**:
A `/clawchat-*` command intercepted by the ClawChat Pi Package instead of dispatched to Pi. Each command declares Chat Session, Group, or Host Profile scope; Host Profile commands require the current owner, while narrower commands remain available to admitted chat participants.
_Avoid_: Pi slash command, model prompt, unrestricted remote command

**Workspace**:
The locally configured Pi `cwd` and its project resources, tools, and context files. Every Chat Session in a Host Profile uses the same Workspace.
_Avoid_: chat-selected project, remote path, arbitrary cwd

**ClawChat Gateway**:
The single ClawChat Protocol v2 connection for a Host Profile that owns handshake, reconnect, replay, deduplication, acknowledgements, and frame transport for every chat handled by that profile.
_Avoid_: per-session WebSocket, session transport

**Agent Conformance Profile**:
The non-encrypted ClawChat Protocol v2 behavior applicable to a ClawChat agent identity: reliable message transport plus agent-facing metadata, delivery, notification, plaintext history, media, and awareness behavior. It excludes owner-only permission decisions, message encryption, and UI-only producer APIs that Pi does not use.
_Avoid_: full generic client, owner client, partial reliable delivery

**Gateway Store**:
The per-Host-Profile SQLite record that durably owns accepted inbound frames, deduplication keys, reliable-delivery admission state, Chat Turn Queues, Chat Session mappings, imported sibling-device history, and materialized outbound delivery attempts. It does not store Pi conversation context, which remains in Pi's native session JSONL files.
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
The durable FIFO queue owned by one Chat Session for accepted ClawChat messages and ClawChat Awareness Turns while that session is busy. A session dispatches only one Pi turn at a time and starts the next item after the current turn settles; different Chat Sessions may run concurrently. Queued work neither interrupts nor steers the active turn, and admission does not produce a separate busy acknowledgement in chat.
_Avoid_: global queue, interrupt-on-message, steer, concurrent turns

**ClawChat Awareness Turn**:
A Pi turn created from an actionable, content-free ClawChat signal after authoritative state is refreshed, rather than from a user's chat message. It is routed only to the owner's direct Chat Session; moment-comment signals remain distinct, while lower-priority contact and conversation changes may be consolidated.
_Avoid_: synthetic user message, notification reply, signal-per-turn

**Sibling Plaintext History Sync**:
The non-encrypted transfer of retained ClawChat message pages between two devices of the same user through `history.transit`. The receiving Host Profile durably imports each message by message identity, without turning transferred history into Pi conversation context.
_Avoid_: server replay, Pi session import, encrypted history sync

**Group Dispatch Mode**:
The per-group policy `mention`, `all`, or `muted` that controls whether an accepted ClawChat message enters its Chat Session. `muted` still consumes, deduplicates, and acknowledges frames but never dispatches them to Pi; direct chats always dispatch, while groups default to `mention`.
_Avoid_: subscription state, WebSocket mute, replay pause

**Execution Authority**:
The native tool and operating-system authority of the Pi process. Every message admitted by Group Dispatch Mode runs with the same Pi configuration and process permissions; this equality does not grant Host Profile administration, whose ClawChat Control Commands require the current owner.
_Avoid_: ClawChat tool permission gate, sender-based tool policy, implicit sandbox

**Reply Delivery**:
The non-token-streaming projection of Pi output into complete materialized ClawChat messages according to the effective Output Mode. `minimal` buffers assistant text and sends only the last non-empty block at turn end; `normal` sends all assistant text blocks; `full` additionally sends completed thinking under a Markdown heading with fenced content and completed tool output under an emoji-labelled Markdown heading with fenced arguments and results. A turn may therefore produce one or more complete messages, but never `message.created` / `message.add` / `message.done` lifecycle frames or synthetic failure prose; `typing.update` brackets the active turn.
_Avoid_: token streaming, synthetic assistant reply, adapter-authored rewriting, unconditional tool progress

**Inbound Stream Materialization**:
The conversion of one completed ClawChat streaming-message lifecycle into one accepted message and one possible Pi turn after `message.done`. Partial additions never create turns, failed streams create none, and a later materialized reply with the same message identity never creates a duplicate turn.
_Avoid_: token-per-turn dispatch, partial-message turn, duplicate polished reply

**Output Mode**:
The effective `minimal`, `normal`, or `full` policy for projecting Pi output into ClawChat. A Host Profile defaults to `normal`, and each Chat Session may persist a mode override through `/clawchat-output minimal|normal|full|inherit`; `inherit` removes the session override and follows the profile default. A command in one chat never changes another chat's override, and no mode changes Pi tool execution.
_Avoid_: tool-execution policy, global-only toggle, model instruction, independent thinking switch

**Active Session Owner**:
The single running Pi runtime allowed to operate one persisted Chat Session. A Headless Pi Host and a separate Pi TUI must not concurrently own the same session, although one host may own multiple different Chat Sessions.
_Avoid_: shared session process, concurrent session writer

**Session Handoff**:
Sequential transfer of a persisted Pi session between the Headless Pi Host and Pi TUI after the current Active Session Owner has stopped.
_Avoid_: live session sharing, simultaneous TUI attachment
