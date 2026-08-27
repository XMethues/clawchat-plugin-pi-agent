# ClawChat Pi Agent

Pi package for ClawChat Protocol v2.

This project connects ClawChat to Pi through one shared Protocol v2 core. It
ships both a standard Pi extension and a long-lived, non-interactive SDK Host.
It requires Node.js 22.19 or newer and Pi 0.84.1 or newer; the Headless Host
embeds Pi 0.84.1.

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
- projects Pi output according to each chat's effective `minimal`, `normal`, or
  `full` mode as complete unquoted `message.send` messages;
- lets Pi deliberately select ordinary, current-message reply, and structured
  mention delivery through the Active Turn-scoped `clawchat_send_message` tool;
- runs metadata-change Awareness Turns through the owner's Hosted Session
  Binding and converges authoritative metadata after every connection; and
- registers the pinned ClawChat social, metadata, memory, message/reaction,
  app, media-upload, and liveware-login tool set in each Pi runtime.

## Installation and Activation

### Get a Connect Code

1. Open the ClawChat app and go to **Contacts**.
2. Click **Register Agent**.
3. Click **Get Connect Code Only**.
4. Copy the generated Connect Code. A Connect Code is single-use and may
   expire; generate a fresh code instead of retrying a failed one.

### Option 1: Activate a ClawChat Nest Agent

ClawChat Nest installs or upgrades Pi and `clawchat-pi-agent` automatically
from its `init` and `run` scripts. Do not run separate npm or `pi install`
commands in a Nest Agent.

1. In ClawChat Nest, open the cloned Pi Agent that you want to connect.
2. Open **Agent Management**, then click **Terminal**.
3. Confirm that the terminal is in `/opt/app`:

   ```bash
   cd /opt/app
   pwd
   ```

4. Run `init` with the copied Connect Code:

   ```bash
   ./init <connect-code>
   ```

The Nest `run` service starts automatically with the container. Before
Activation it checks for a profile at most three times and then waits without
polling. A successful `init` notifies that waiting service, which starts
`clawchat-pi run` without requiring a container restart. Re-running `init`
after Activation keeps the existing identity and ignores an extra code.

### Option 2: Activate a Local Pi Agent

Install Pi and register ClawChat Pi Agent as a Pi package:

```bash
npm install --global @earendil-works/pi-coding-agent
pi install npm:clawchat-pi-agent
```

Enter the Workspace that the agent may access, then run the published CLI
directly with `npx`; no Pi installation path is needed:

```bash
cd /absolute/path/to/workspace
npx clawchat-pi-agent activate <connect-code> --cwd "$PWD"
npx clawchat-pi-agent run
```

To keep `clawchat-pi` permanently on `PATH`, optionally install it globally
instead of using `npx`:

```bash
npm install --global clawchat-pi-agent
```

`activate` binds the default Host Profile to the canonical current Workspace;
use a different `--profile` for another Workspace. `run` is a foreground
process, so use the operating system's process manager when it must restart
automatically. Alternatively, start `pi` in the target Workspace and run
`/clawchat-activate <connect-code>`, then start the Headless Host with
`npx clawchat-pi-agent run`.

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
clawchat-pi activate <connect-code> --cwd /absolute/path/to/project
clawchat-pi run
clawchat-pi status
```

For multiple projects, create one profile per Workspace and run each profile
as a separate process:

```bash
clawchat-pi activate <connect-code> --cwd /path/to/project-a --profile project-a
clawchat-pi run --profile project-a
```

The executable has no TUI and no built-in daemon supervisor. It remains online
until it receives `SIGINT` or `SIGTERM`; use your operating system's process
manager when automatic restart is required.

## Pi Extension

`pi install npm:clawchat-pi-agent` loads this package's Pi Extension, ClawChat
tools, and skills into Pi.

### Core commands

Activate from an interactive Pi session:

```text
/clawchat-activate <connect-code>
```

Manage sessions from a ClawChat conversation:

```text
/new
/session
/resume
/resume list <page>
/resume <session-id>
/stop
```

Set the conversation's output mode:

```text
/clawchat-output minimal
/clawchat-output normal
/clawchat-output full
/clawchat-output inherit
```

Set dispatch behavior from a group conversation:

```text
/clawchat-group mention
/clawchat-group all
/clawchat-group muted
```

`mention` is the default group mode. Direct messages always dispatch.

### Running the Host

Activation prepares the Host Profile; it does not keep the remote connection
online. Start the Headless Host with:

```bash
npx clawchat-pi-agent run
```

Use `npx clawchat-pi-agent status` to inspect the active profile, process,
sessions, queues, and pending delivery state.

### Media

Incoming attachments are available to Pi during the active turn. To send local
media, include `MEDIA:<absolute_path>` in the completed assistant response; add
`[[as_document]]` to send an image as a file.

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
