# Automatic priority by secondary quota reset

In account management, open **Automatic switching** and enable **Prioritize earlier secondary resets**.
Automatic switching and the local proxy must already be running. Enabling the rule also enables custom
priorities. Disabling custom priorities disables the rule.

The account table shows effective ranks starting at 1. Smaller ranks take priority. Accounts with the
same secondary reset timestamp share a rank. Unknown, failed or elapsed reset times follow confirmed
future resets. The rule compares the next reset timestamp, not the quota window duration.

Manual priorities remain in their existing account files. Automatic ranks are response projections,
never metadata writes. Turning the rule off restores the saved manual values. Quota refreshes recompute
the ranks, and settings changed during a refresh are resolved before choosing the next account.

Quota eligibility, disabled accounts, remaining-quota thresholds, exclusion of already tried accounts,
Provider fallback, concurrent session affinity and explicit image targets retain their existing rules.
This setting does not immediately switch the active account. It determines priority when the existing
switching or routing flow next selects an account. The GUI chat's separate automatic switching settings
remain independent from account management settings.

Desktop local and hosted desktop use the same command and status field. The Web account page provides
a computer selector and reads or changes the selected computer's preferences through its authenticated
connection. Remote status returns only account IDs, effective priorities, eligibility flags and reset
timestamps. A failed write is reported instead of presenting an unconfirmed setting as saved.

Web consumes the immutable customized i18n prerelease from `MengKaiTao88/remoteai-i18n`. Its two changed
shared sources are exported from committed Git objects with `scripts/export-web-source-overlay.mjs`;
per-file provenance preserves the ownership of the remaining independent dependency snapshot.
Public deployments require the updated Web frontend; a desktop update alone cannot add its controls.

Validation covers routing order, equal/missing/elapsed resets, eligibility, refreshes, manual restoration,
concurrent routing, image fallback, remote validation and filtered responses. The browser fixture uses
the actual desktop controls and Web settings editor with deterministic accounts and confirmed responses.
