# Default group chats to mention-only dispatch

Direct-chat messages will dispatch to their Chat Session by default, while group chats default to dispatching only messages that structurally mention the connected ClawChat agent. A group may be configured as `all` or `muted`; muted frames are still received, deduplicated, durably admitted, and acknowledged by the Gateway but never reach Pi, and unmuting does not replay them into the model. This keeps protocol replay healthy while preventing ambient group traffic from consuming model/tool capacity or acting on the Workspace unexpectedly.
