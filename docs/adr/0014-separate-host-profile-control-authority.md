# Separate Host Profile control authority from Pi execution authority

ADR-0009 continues to apply to every message admitted to Pi: participants receive the same native tools and process permissions. ClawChat Control Commands scoped to the shared Host Profile are authorized separately and require the current owner. Reactive refresh-token rotation may update credentials in place for the same identity, but an invite-code Activation is a Profile Rebinding governed by ADR-0016 and is not a live Gateway reconnect command.
