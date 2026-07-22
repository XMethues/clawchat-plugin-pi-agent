# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`, including its labels.
- **List issues**: use `gh issue list` with suitable state and label filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. When a bare reference such as `#42` is ambiguous, try `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is one GitHub issue with child issues as decision tickets.

- **Map**: label it `wayfinder:map` and keep Notes, Decisions-so-far, and Fog in its body.
- **Child ticket**: link it as a GitHub sub-issue. If sub-issues are unavailable, add it to the map’s task list and put `Part of #<map>` in the child body.
- **Ticket labels**: use `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use GitHub native issue dependencies. If unavailable, add `Blocked by: #<n>` to the child body.
- **Frontier**: select the first open, unassigned child with no open blockers.
- **Claim**: assign the ticket to the current user before changing it.
- **Resolve**: comment with the answer, close the child, and add its result to the map’s Decisions-so-far section.
