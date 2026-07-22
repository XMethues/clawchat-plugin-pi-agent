# Preserve Pi's native execution authority

The ClawChat integration will not add sender-based authorization, owner-only tool execution, group read-only behavior, tool allowlists, approval prompts, or an additional sandbox. Every direct or group message admitted by Group Dispatch Mode enters its Chat Session with the tools, project trust, extensions, and operating-system permissions configured for the underlying Pi process.

This keeps ClawChat behavior aligned with running Pi locally and avoids inventing a second permission model that Pi does not provide. Operators therefore treat every admitted ClawChat participant as trusted: a model turn triggered by any such participant can read or modify local files and run commands with the Headless Pi Host's operating-system authority. Isolation, if required, belongs in the Host's operating-system, container, account, Workspace, or Pi configuration rather than this integration.
