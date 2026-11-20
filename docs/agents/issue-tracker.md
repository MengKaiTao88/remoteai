# Issue Tracker

Store issues and specs as local Markdown under `.scratch/` at the repository root.

- Use `.scratch/<feature-slug>/spec.md` for the specification.
- Put each implementation ticket in `issues/<NN>-<slug>.md` within that feature folder. Start numbering at `01`.
- Record the ticket's `Status:` using `triage-labels.md`. Append discussion under `## Comments`.
- Publish a ticket by creating its file. Fetch a ticket by reading the referenced file.
- Keep `.scratch/` outside version control.

## Wayfinding

- Store the map at `.scratch/<effort>/map.md` and child tickets under `.scratch/<effort>/issues/`.
- Record each ticket's `Type:` and any `Blocked by:` ticket numbers.
- Pick the first open, unblocked, unclaimed ticket by number.
- Claim a ticket with `Status: claimed`. Resolve it by adding an `## Answer` section, setting `Status: resolved`, and recording the outcome in the map.
