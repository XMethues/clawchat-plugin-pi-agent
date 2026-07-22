# Scope tool-output visibility per Chat Session

A Host Profile defines the default Tool Output Visibility, while each Chat Session may persist its own override. The Extension command `/clawchat-output tools on|off|inherit` changes only the Chat Session in which the command was received; `inherit` removes the override and resumes following the profile default.

This separates display policy from tool execution authority and prevents a command in one direct or group chat from changing the output seen by unrelated chats. The effective setting controls only whether completed Pi tool calls are materialized into ClawChat messages. It does not enable, disable, approve, or otherwise alter tool execution.
