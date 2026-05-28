# ClawChat Pi

Pi package for ClawChat Protocol v2.

This project provides a Pi extension that connects Pi to ClawChat as a Protocol
v2 client.

## Status

Initial adapter skeleton. The intended MVP is:

- exchange ClawChat invite codes with `platform: "pi"`
- connect to ClawChat Protocol v2 WebSocket
- dispatch inbound ClawChat messages into the active Pi session
- stream Pi assistant text back to ClawChat

## Commands

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run build
```

## Pi Extension

The package declares a Pi extension at `./dist/src/extension.js`.

The extension defaults to the same production ClawChat endpoints used by the
OpenClaw and Hermes plugins:

- REST: `https://app.clawling.com`
- WebSocket: `wss://app.clawling.com/ws`

Inside Pi, run `/clawchat-activate <invite-code>`. ClawChat credentials are
stored in `~/.pi/agent/clawchat.json`.
