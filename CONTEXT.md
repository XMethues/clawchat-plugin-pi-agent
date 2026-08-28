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
The long-lived, non-interactive Node.js process that runs one Host Profile, embeds Pi through the SDK, exclusively owns its ClawChat Gateway and Chat Session Registry, and creates a Hosted Session Binding for each loaded Active Chat Session.
_Avoid_: hidden Pi process, TUI, standalone extension, shared Gateway owner

**Hosted Session Binding**:
The Host-minted binding that gives one loaded Active Chat Session its Active ClawChat Turn, ClawChat tools, and Reply Delivery through the Host-owned integration core. It cannot create, start, stop, or reconnect a ClawChat Gateway.
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
A reserved Slash Command intercepted by the ClawChat Pi Package instead of dispatched to Pi. Commands that manage a Host Profile or Conversation Session Set require the current owner, while Group Dispatch and Output Mode commands remain available to admitted chat participants.
_Avoid_: model prompt, unrestricted remote command, implicit Pi turn

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

**Conversation Session Set**:
The persistent aggregate owned by one ClawChat conversation identified by `chat_id`. It contains that conversation's Chat Sessions, exactly one Active Chat Session, and one Conversation Work Queue; no Chat Session can move between sets.
_Avoid_: shared session pool, global session list, cross-chat history

**Chat Session**:
An isolated, persistent Pi session identified by `session_id` and owned by exactly one Conversation Session Set. A non-empty historical Chat Session can be resumed only within its owning conversation.
_Avoid_: conversation, sender session, global session

**Active Chat Session**:
The one Chat Session in a Conversation Session Set that receives the next Chat Turn after all earlier Conversation Work has settled. Replacing it never moves history across ClawChat conversations.
_Avoid_: latest session, global current session, Active Session Owner

**Chat Session Registry**:
The Headless Pi Host component that creates or restores Conversation Session Sets, loads the Active Chat Session required by queued work, and keeps each loaded runtime resident for the Online Host Profile's lifetime unless an explicit Session Transition or conversation deletion disposes it.
_Avoid_: message router, global session

**Conversation Work Queue**:
The durable FIFO owned by one Conversation Session Set for accepted Chat Turns and ordered Session Commands. Work before a Session Transition uses the former Active Chat Session and later work uses the replacement; `/stop` alone interrupts outside the FIFO and cancels earlier queued work.
_Avoid_: global queue, Chat Turn Queue, interrupt-on-message, steer

**ClawChat Awareness Turn**:
A Pi turn created from an actionable, content-free ClawChat signal after authoritative state is refreshed, rather than from a user's chat message. It is routed only to the owner's direct Chat Session; moment-comment signals remain distinct, while lower-priority contact and conversation changes may be consolidated.
_Avoid_: synthetic user message, notification reply, signal-per-turn

**Sibling Plaintext History Sync**:
The non-encrypted transfer of retained ClawChat message pages between two devices of the same user through `history.transit`. The receiving Host Profile durably imports each message by message identity, without turning transferred history into Pi conversation context.
_Avoid_: server replay, Pi session import, encrypted history sync

**Group Dispatch Mode**:
The per-group policy `mention`, `all`, or `muted` that controls whether an accepted ClawChat message becomes a Chat Turn. It never controls whether the group's Conversation Session Set exists; `muted` still consumes, deduplicates, and acknowledges frames without invoking Pi, direct chats always dispatch, and groups default to `mention`.
_Avoid_: subscription state, Session creation policy, WebSocket mute, replay pause

**Silent Turn**:
A dispatched Group Chat Turn that Pi deliberately completes without Reply Delivery because responding would not be useful or relevant. Pi prefers a No-Reply Completion and may use the Silent Marker only as a compatibility fallback; either choice remains part of the Chat Session context.
_Avoid_: muted message, skipped inbound frame, empty response, failed delivery

**No-Reply Completion**:
The structured, terminal choice by which Pi selects an eligible Silent Turn without producing assistant text. It is unavailable in private chats and when the group message directly mentions the Agent.
_Avoid_: empty assistant reply, failed send, message deletion, Silent Marker

**Silent Marker**:
The exact group-only assistant response `[SILENT]` retained as a compatibility fallback when No-Reply Completion is unavailable. It is retained in the Chat Session but never becomes Reply Delivery.
_Avoid_: preferred silent path, private-chat marker, partial-text match, lowercase variant, empty response

**Group-wide Mention**:
A structured `@everyone` mention addressed to all participants in a Group Chat. It admits the message to an Agent using mention dispatch but does not require that Agent to reply.
_Avoid_: `@all`, direct Agent mention, mandatory Agent response

**Execution Authority**:
The native tool and operating-system authority of the Pi process. Every message admitted by Group Dispatch Mode runs with the same Pi configuration and process permissions; this equality does not grant Host Profile administration, whose ClawChat Control Commands require the current owner.
_Avoid_: ClawChat tool permission gate, sender-based tool policy, implicit sandbox

**Reply Delivery**:
The non-token-streaming projection of Pi output into complete materialized ClawChat messages according to the effective Output Mode. `minimal` selects only the last non-empty assistant block; `normal` selects all assistant blocks; `full` additionally selects completed thinking and tool output. Direct Chat selections project immediately, while Group Chat selections wait until the Turn settles so a No-Reply Completion or fallback Silent Marker can suppress the whole automatic projection. Automatic projection uses ordinary, unquoted `message.send`; explicit reply or structured-mention delivery uses `clawchat_send_message`, whose successful send owns delivery and suppresses any automatic duplicate. A Turn may produce zero or more complete messages, but never streaming lifecycle frames or synthetic failure prose; `typing.update` brackets the active Turn.
_Avoid_: token streaming, synthetic assistant reply, adapter-authored rewriting, unconditional tool progress

**Inbound Stream Materialization**:
The conversion of one completed ClawChat streaming-message lifecycle into one accepted message and one possible Pi turn after `message.done`. Partial additions never create turns, failed streams create none, and a later materialized reply with the same message identity never creates a duplicate turn.
_Avoid_: token-per-turn dispatch, partial-message turn, duplicate polished reply

**Inbound Media Materialization**:
The bounded conversion or Turn-scoped local handoff of ordered ClawChat image, audio, video, and file fragments without exposing remote media URLs. Original media exists only under a private lease until that Turn settles; native inputs, extracted text, or other derived content may remain in Pi conversation context.
_Avoid_: URL forwarding, permanent attachment storage, Workspace upload

**Output Mode**:
The effective `minimal`, `normal`, or `full` policy for projecting Pi output into ClawChat. A Host Profile defaults to `normal`, and each ClawChat conversation may persist an override through `/clawchat-output minimal|normal|full|inherit`; `inherit` removes the conversation override and follows the profile default. Session Transitions never change it, and no mode changes Pi tool execution.
_Avoid_: tool-execution policy, global-only toggle, model instruction, independent thinking switch

**Active Session Owner**:
The single running Pi runtime allowed to operate one persisted Chat Session. A Headless Pi Host and a separate Pi TUI must not concurrently own the same session, although one host may own multiple different Chat Sessions.
_Avoid_: shared session process, concurrent session writer

**Session Handoff**:
Sequential transfer of a persisted Pi session between the Headless Pi Host and Pi TUI after the current Active Session Owner has stopped.
_Avoid_: live session sharing, simultaneous TUI attachment
