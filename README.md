# ClawChat Pi

Pi package for ClawChat Protocol v2.

This project connects ClawChat to Pi through one shared Protocol v2 core. It
ships both a standard Pi extension and a long-lived, non-interactive SDK Host.
It requires Node.js 22.19 or newer and Pi 0.81.1 or newer.

## Status

The Headless Pi Host:

- keeps one authenticated WebSocket online per Host Profile;
- maps every ClawChat `chat_id` to an isolated native Pi JSONL session;
- runs different chats concurrently and one chat strictly FIFO;
- persists inbound queues, deduplication, output settings, and the outbound
  outbox in SQLite;
- reconnects with the same device and implements reliable-delivery v1/v2;
- sends completed assistant, thinking, and optionally tool output as
  materialized `message.reply` messages;
- registers the pinned ClawChat social, metadata, memory, mention/reaction,
  app, media-upload, and liveware-login tool set in each Pi runtime.

## Commands

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run build
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

Inside Pi, run `/clawchat-activate <invite-code>` once. Activated profiles
initialize REST and local tools automatically on `session_start`; `/clawchat`
is not a startup prerequisite. The ordinary Pi Extension is management-only:
it never opens a WebSocket or receives remote turns. `clawchat-pi run`
exclusively owns the profile's Gateway.

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
native JSONL path. To inspect or continue one session in Pi's TUI, stop the Host,
run `pi --session <path>` from the profile Workspace, exit Pi, then restart the
Host. Concurrent Host and TUI access to the same session file is unsupported.

The full runtime contract is in [docs/headless-host-spec.md](docs/headless-host-spec.md),
and the copied WebSocket contract is in [docs/client-integration.md](docs/client-integration.md).
