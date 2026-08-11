# Limit sibling history sync to plaintext transfer

The Agent Conformance Profile advertises `history_sync` and implements the plaintext `history.transit` request, page, progress, completion, cancellation, and idempotent import path, but does not advertise or implement E2EE. This preserves useful sibling-device continuity without claiming cryptographic behavior whose key management and ratchet contract are outside this package.
