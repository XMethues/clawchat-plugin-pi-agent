# Rebind an existing profile by resetting identity state

A second explicit Activation of the same Host Profile is Profile Rebinding, whether the invite resolves to the same or a different ClawChat identity. The rebind preserves the stable device identifier and Workspace, then clears the Gateway Store, ClawChat Tool State, profile-local Skill root, Chat Session mappings and queues, and mapped Pi session JSONL history before committing the new credentials. Ordinary refresh-token rotation remains an in-place credential update and is not Activation.

We rejected identity comparison and a separate `--new-account` branch because both allow old replay cursors, chat mappings, memory, or audit history to survive an explicit rebind. We also rejected device rotation and Workspace deletion: the device is the stable installation identity, and the Workspace is local user configuration rather than ClawChat identity state.
