# ClawChat Pi

Pi package for ClawChat Protocol v2.

This project connects ClawChat to Pi through one shared Protocol v2 core. It
ships both a standard Pi extension and a long-lived, non-interactive SDK Host.
It requires Node.js 22.19 or newer and Pi 0.81.1 or newer.

## Status

The Headless Pi Host:

- keeps one authenticated WebSocket online per Host Profile and reconnects with
  the same stable device using bounded exponential backoff;
- maps every ClawChat `chat_id` to an isolated native Pi JSONL session;
- runs different chats concurrently and one chat strictly FIFO;
- persists inbound queues, deduplication, replay quarantine and truncation
  status, output settings, and the outbound Outbox in SQLite;
- implements reliable-delivery v1/v2, including frame-path ACK flushing,
  poison-frame quarantine, and replay barriers;
- gives every materialized outbound message a durable canonical `message_id`;
  lost ACKs time out and reconcile by reconnecting, waiting for replay, and
  resending that same identity;
- sends completed assistant, thinking, and optionally tool output as
  unquoted `message.send` messages in direct chats and quoted `message.reply`
  messages in group chats;
- runs metadata-change Awareness Turns through the owner's Hosted Session
  Binding and converges authoritative metadata after every connection; and
- registers the pinned ClawChat social, metadata, memory, mention/reaction,
  app, media-upload, and liveware-login tool set in each Pi runtime.

## Commands

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run build
npm run smoke:gateway
```

Activate a profile bound to one project Workspace, then run it in the
foreground:

```bash
clawchat-pi activate <invite-code> --cwd /absolute/path/to/project
clawchat-pi run
clawchat-pi status
```

For multiple projects, create one profile per Workspace and run each profile
as a separate process:

```bash
clawchat-pi activate <invite-code> --cwd /path/to/project-a --profile project-a
clawchat-pi run --profile project-a
```

The executable has no TUI and no built-in daemon supervisor. It remains online
until it receives `SIGINT` or `SIGTERM`; use your operating system's process
manager when automatic restart is required.

## Pi Extension

The package declares a Pi extension at `./dist/src/extension.js`.

The extension defaults to the same production ClawChat endpoints used by the
OpenClaw and Hermes plugins:

- REST: `https://app.clawling.com`
- WebSocket: `wss://app.clawling.com/ws`
- Media: `https://app.clawling.com`

Set `CLAWCHAT_BASE_URL`, `CLAWCHAT_WS_URL`, and `CLAWCHAT_MEDIA_URL` to
independent endpoints for a custom deployment. REST and Media values must be
absolute HTTP(S) origins; the WebSocket value must be an absolute `ws:` or
`wss:` URL. The Host Profile stores and `status` prints all three separately;
Media is never derived from WebSocket state. Legacy profiles with custom
endpoints require `CLAWCHAT_MEDIA_URL` for migration. Legacy profiles without
the structured agent ID, agent-user ID, and owner ID must be activated again.
Bearer access and refresh credentials are opaque strings: the package never
decodes them to obtain identity or endpoint authority.

Inside Pi, run `/clawchat-activate <invite-code>` once. Activated profiles
initialize REST and local tools automatically on `session_start`; `/clawchat`
is not a startup prerequisite. The ordinary Pi Extension is management-only:
it never opens a WebSocket or receives remote turns. `clawchat-pi run`
exclusively owns the profile's Gateway.

CLI and Management Extension Activation acquire the same exclusive Host
Profile operation lease used by `run` before reading profile state. The lease
is held through invite redemption, any Profile Rebinding reset, profile commit,
and output-setting restoration, then released on success or failure. Activation
therefore fails before its remote request while the Host owns the profile, and
Host startup fails while Activation is in progress.

Profile state is stored below Pi's agent directory:

```text
<agent-dir>/clawchat/profiles/<profile>/profile.json
<agent-dir>/clawchat/profiles/<profile>/gateway.sqlite
<agent-dir>/clawchat/profiles/<profile>/memory/{owner.md,users/,groups/}
<agent-dir>/clawchat/profiles/<profile>/skills/
<agent-dir>/clawchat/profiles/<profile>/run.lock
```

A second explicit Activation of an existing profile is a Profile Rebinding.
It preserves the profile's device ID and Workspace but deletes the prior
Gateway state, tool memory/audit state, profile-local skills, chat mappings,
queues, and mapped Pi session history before saving the new credentials.

Tool output defaults to `off`. From the current ClawChat conversation handled
by the Headless Pi Host, change it with:

```text
/clawchat-output tools on
/clawchat-output tools off
/clawchat-output tools inherit
```

`inherit` removes the per-chat override and returns to the Host Profile default.
These commands affect output visibility only; they do not enable or disable Pi
tools. Thinking visibility follows Pi's native thinking level and has no
ClawChat-specific duplicate switch.

Groups default to structured mention dispatch. From a group chat, use:

```text
/clawchat-group mention
/clawchat-group all
/clawchat-group muted
```

Control commands are durably accepted before group filtering, so a muted group
can unmute itself. Direct messages always dispatch.

The extension does not use ClawChat streaming lifecycle frames. Each visible
thinking block, assistant text block, or enabled completed tool call is sent as
a complete message while `typing.update` represents active work.

### Agent Conformance Profile

The running Headless Host advertises only the Protocol v2 behavior it implements:
`multi_device`, `device_replay`, `reliable_delivery`,
`reliable_delivery_v2`, `delivery_receipt`, and plaintext `history_sync`;
profiles with owner-awareness support also advertise `chat_meta_events` and
`notify_signals`. It does **not** advertise E2EE or `permission_events`, does not
subscribe to presence, does not emit production streaming lifecycle frames, and
does not produce read cursors (`message.read`). Streaming lifecycle downlinks
may be consumed and materialized after `message.done`; that does not make the
Host a streaming producer. History Sync remains plaintext-only.

On exact `authentication failed`, the Gateway permits one single-flight token
refresh since the previous successful `hello-ok`; another healthy connection
resets that allowance. An immediately rejected replacement cannot hot-loop.
Exact `nonce mismatch` and remote-auth-service failures reconnect with normal
backoff and reuse the current opaque token.

The package also declares `skills/clawchat-core` and
`skills/clawchat-liveware` as Pi skill resources. Both ordinary and Headless Pi
runtimes discover them with the extension. Owner memory is injected on every
ClawChat turn, current-group memory is added for group turns, and user memory
is available only through explicit memory tools.

To attach local media, include one or more `MEDIA:<absolute_path>` markers in a
completed assistant reply. Other text becomes the caption. Images, audio,
video, and files are uploaded to ClawChat and emitted as native fragments; add
`[[as_document]]` to force an image to a file fragment.

## Sessions and handoff

`clawchat-pi status` lists every `chat_id`, Pi session ID, queue counts, and
native JSONL path, plus pending/failed Outbox counts and quarantined inbound
frames. If the server reports `history.truncated`, status preserves and prints
the monotonic `oldest_seq` boundary and observation time as “Inbox history
before sequence … is unavailable”; it never turns replay loss into chat
content. To inspect or continue one session in Pi's TUI, stop the Host, run
`pi --session <path>` from the profile Workspace, exit Pi, then restart the
Host. Concurrent Host and TUI access to the same session file is unsupported.

The full runtime contract is in [docs/headless-host-spec.md](docs/headless-host-spec.md),
and the copied WebSocket contract is in [docs/client-integration.md](docs/client-integration.md).
