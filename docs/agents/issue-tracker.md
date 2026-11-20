# GitHub Issue Tracker

Specs and tickets live in GitHub Issues for `MengKaiTao88/remoteai`. Pass `--repo MengKaiTao88/remoteai` to `gh issue` and `gh pr` commands. Use `repos/MengKaiTao88/remoteai/` for `gh api` requests.

## Issue operations

- Publish a spec or ticket with `gh issue create --repo MengKaiTao88/remoteai --title "..." --body-file <file>`.
- Fetch a ticket with `gh issue view <number> --repo MengKaiTao88/remoteai --json number,title,body,state,labels,comments`.
- List tickets with `gh issue list --repo MengKaiTao88/remoteai --state open --json number,title,body,labels,comments`. Set filters and the result limit for the task.
- Apply the labels in [triage-labels.md](triage-labels.md) with `gh issue edit <number> --repo MengKaiTao88/remoteai --add-label <label>` or `--remove-label <label>`.
- Add context with `gh issue comment <number> --repo MengKaiTao88/remoteai --body-file <file>`. To resolve an issue, post the explanation first, then run `gh issue close <number> --repo MengKaiTao88/remoteai`.

## Sub-issues and dependencies

- Link a child issue using `--parent <parent>` at creation or `gh issue edit <parent> --repo MengKaiTao88/remoteai --add-sub-issue <child>`. Where the feature is unavailable, add `Part of #<parent>` to the child's body.
- Record dependencies using `--blocked-by <blocker>` at creation or `gh issue edit <child> --repo MengKaiTao88/remoteai --add-blocked-by <blocker>`. Where the feature is unavailable, add `Blocked by: #<blocker>` to the child's body.
- Check open dependencies with `gh api repos/MengKaiTao88/remoteai/issues/<number> --jq .issue_dependencies_summary.blocked_by`. For blockers recorded in the body, check each referenced issue's state. A ticket is ready when every blocker is closed.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When set to `yes`, triage external PRs using the same labels and states. Use `gh pr view`, `gh pr diff`, `gh pr comment`, `gh pr edit`, and `gh pr close` with the repository specified above.

## Wayfinding

- Store the map as an issue with the `wayfinder:map` label. Store tickets as sub-issues with the relevant `wayfinder:<type>` label (`research`, `prototype`, `grilling`, or `task`). Create the labels used by the map as needed.
- List children with `gh api --paginate repos/MengKaiTao88/remoteai/issues/<map>/sub_issues`. If sub-issues are unavailable, keep a task list in the map body and link each child to the map in its body.
- Pick the first open child in map order that has no open blockers or assignee. Claim it with `gh issue edit <number> --repo MengKaiTao88/remoteai --add-assignee @me`.
- Resolve a ticket by posting the answer, closing the ticket, and recording the decision and ticket link in the map.
