# Official conversation delivery and usage compatibility

Remote queue acceptance must confirm durable storage before slow history hydration. The computer
validates the message and model selection, saves the full draft and its originating client receipt,
then returns the existing queue response. A per-conversation preparation guard prevents dispatch until
history has loaded. A failed preparation retains the draft for review without claiming a send occurred.
This keeps old conversations from timing out at the phone while the computer continues the operation.

The originating `clientId` survives queue snapshots and SQLite restoration. Transport retries still
use their existing request identity, and uncertain submissions are not automatically replayed.
Optimistic outboxes also reconcile a matching late receipt after timeout, without matching identical
message text or replaying the submission. This client improvement requires the updated client build.

Large saved conversations retain the requested, bounded 640 MiB loopback response allowance. Hydrating
settled history publishes a history snapshot rather than a new completion event, preserving real turn
timing and message bodies while continuing old chats.

Native usage has separate cumulative billing and last-request/context counters. The pinned gateway's
presentation previously kept only `contextUsage`, dropping `latestTokenUsageInfo.total`. The local
`native_usage.py` compatibility module preserves validated public counters without modifying the pinned
gateway source. The Rust adapter includes them in history and emits `thread/tokenUsage/updated` when
they change, even if no message body changes. Existing desktop, Web and Native clients consume that
protocol. Missing counters remain unknown rather than being inferred from context occupancy.

Regression checks cover delayed history acceptance, preparation failures, client receipt persistence,
distinct cumulative/context counters, cached native usage, and live usage events without new turns.
