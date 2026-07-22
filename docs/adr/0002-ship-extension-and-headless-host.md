# Ship an extension and a headless SDK host

The package will expose both a standard Pi extension and a `clawchat-pi` executable that embeds Pi through the SDK. The shared integration core remains the single implementation of ClawChat wire behavior and Pi lifecycle projection; the extension binds that behavior to one Pi session, while the executable owns process startup, the process-wide Gateway, session runtimes, persistence, and shutdown. This supports headless ClawChat use without duplicating the integration state machine or requiring a separate Pi TUI/RPC process.
