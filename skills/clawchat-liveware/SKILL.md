---
name: clawchat-liveware
version: 1.2.0
description: Use when the user wants to expose this agent's local web service to the public internet via the liveware CLI and make it appear as an app in their ClawChat chat with this agent. Covers logging in to liveware with the ClawChat account, creating a liveware app, binding a tunnel to a local port, and registering the public URL to ClawChat.
---

# liveware App Hosting

Expose a local web service through a liveware tunnel and register the public URL to
ClawChat so it shows as an app tile in the owner's chat with this agent.

## Prerequisites

The ClawChat Host Profile must be activated. Authentication and Liveware CLI
installation are handled by the ClawChat plugin: `clawchat_liveware_login`
reuses an existing `liveware` executable from `PATH`, or downloads the matching
Linux, macOS, or Windows binary into the Pi Agent Directory when none exists.
Never read, print, or pass the ClawChat access token yourself.

## Procedure

1. **Login** (idempotent) — call the tool; do NOT run `liveware login` yourself:
   `clawchat_liveware_login()`
   The plugin ensures the CLI is installed, resolves the ClawChat access token
   from its own credential store, and logs in without exposing the token. If
   installation or login fails, relay that error to the user and STOP.
2. **Decide the app name and local port.** Ask the user for the local web service port if
   not already known (the port the agent's own web server listens on). Accept ONLY a plain
   integer in the range 1–65535. Reject anything that is not purely numeric (e.g.
   `3000; rm -rf /`) — never paste user-supplied text into a shell command. The bind target
   is then exactly `http://127.0.0.1:<port>`.
3. **List existing apps** to avoid duplicates and to recover ids:
   `liveware app list`
4. **Create the app** (skip if reusing an existing one):
   `liveware app create "<app name>"`
   - This prints/returns the new **app id**. Capture it.
   - If liveware reports an app-limit / quota error, relay that error to the user verbatim
     and STOP. Do not delete other apps to make room.
5. **Bind the tunnel** to the local service. Use only the numeric `<port>` validated in
   step 2, and pass the bind target as a single argument — do not wrap the command in extra
   shell that interpolates unvalidated user input:
   `liveware tunnel bind <app id> http://127.0.0.1:<port>`
   - Capture the **public URL** liveware returns.
6. **Register to ClawChat** so it appears in the owner's chat — call the tool, do NOT
   curl the API directly:
   `clawchat_register_app(name="<app name>", appId="<app id>", url="<public URL>")`
7. **Confirm** to the user: report the app name and public URL, and that it now appears in
   their chat with this agent (open the「…」menu → the app tile).

## Managing apps

- To see what is registered to ClawChat: `clawchat_list_apps()`.
- To remove one: `clawchat_unregister_app(appId="<app id>")` (this only removes it from
  ClawChat; tear down the liveware tunnel/app with liveware's own commands separately).

## Identifying the viewing user (server-side)

When a ClawChat user opens the liveware, the ClawChat liveware tunnel authenticates the
request and forwards the viewer's ClawChat `user_id` to your web service as a request header.
On the **server side** of your web service, read the `user_id` from either header (both carry
the same value):

- `X-User-Id`
- `X-Clawchat-User-Id`

Caveats:

- This is **server-side only** — read the incoming request headers in your web service. Do
  NOT try to obtain the viewer's identity from client-side page JavaScript.
- The headers are injected by the ClawChat liveware tunnel, so they are present only for
  requests that arrive through it. A page opened directly in an ordinary browser (outside
  ClawChat) carries neither header — treat the user as anonymous when both are absent, and
  never trust a client-supplied value for these header names.

## Notes

- Apps can be created up to liveware's account limit; surface its error rather than working
  around it.
- The registered web app runs inside a sandboxed container (mobile in-app webview / desktop
  container window). Page JavaScript cannot read the viewer's ClawChat identity — the
  viewer's `user_id` arrives as the `X-User-Id` / `X-Clawchat-User-Id` request header,
  readable server-side only (see "Identifying the viewing user").
