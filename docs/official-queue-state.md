# Official Codex queue state

Official desktop input queues and the Remote AI outbox are separate stores. A native conversation
stream snapshot does not include the official queued submissions. A persisted local error therefore
cannot establish whether an independently queued official message failed.

The local gateway now reads both the desktop `queued-follow-ups` field in `.codex-global-state.json`
and the newer `queue_1.sqlite` store in SQLite read-only/query-only mode, after authorizing the requested
conversation through the existing session store. The user's live test on 2026-11-13 confirmed that
the desktop store contained the queued test while the server queue was empty. The adapter accepts
only the verified queue schemas, bounds message count and payload sizes, binds the exact thread ID, and
exports text previews and image counts. It never writes to the database or sends native commands.
Missing/unsupported/unreadable storage omits the capability; a successful empty read explicitly clears
the displayed official queue. The bridge also refreshes after an idle long poll because queue storage
has an independent revision from conversation streaming.

Owner queue updates use `thread/nativeQueue/updated` and the optional `Thread.nativeQueue` field. Local,
remote and Web views display these entries with the Codex source label and prevent local edit, delete,
reorder or dispatch actions. Native consumes the same queue projection and disables these actions too.
The owner remains responsible for managing and sending its queue. A newer notification received during
an older history request takes precedence, including an authoritative empty queue.

Remote AI drafts retain their own IDs, content and error/review lifecycle. Restoring a failed draft in
official mode requires review and displays the existing uncertain-outcome message, rather than
presenting an old local failure as an authoritative official failure. These drafts remain durable and
are not automatically replayed. Standalone GUI restoration keeps its original pre-send classification.
No message is deduplicated or deleted by matching its text: repeated identical prompts can be distinct
submissions. A nonempty owner queue also blocks flushing the local outbox ahead of it.

Verification covers exact-thread read isolation, queue order, read-only behavior, empty/unknown states,
restoration without replay, queue-aware dispatch, local/remote reducers and stale history reconciliation.
Browser evidence covers local, remote and Web layouts in light/default and dark/enlarged modes plus
mobile Web widths. Actual Native physical-device verification must be reported separately.
