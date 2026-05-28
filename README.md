# ClawChat Pi

Pi SDK adapter for ClawChat Protocol v2.

This project embeds Pi with `@earendil-works/pi-coding-agent`, connects to
ClawChat as a Protocol v2 client, and bridges ClawChat messages into Pi agent
sessions.

## Status

Initial adapter skeleton. The intended MVP is:

- exchange ClawChat invite codes with `platform: "pi"`
- connect to ClawChat Protocol v2 WebSocket
- dispatch inbound ClawChat messages to a Pi SDK `AgentSession`
- stream Pi assistant text back to ClawChat

## Commands

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run build
```

## Connect

The adapter defaults to the same production ClawChat endpoints used by the
OpenClaw and Hermes plugins:

- REST: `https://app.clawling.com`
- WebSocket: `wss://app.clawling.com/ws`

```bash
node dist/bin/clawchat-pi.js activate <invite-code>
CLAWCHAT_TOKEN=<access-token-from-activation> node dist/bin/clawchat-pi.js start
```
