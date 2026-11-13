# Desktop state v13 and failed queue recovery

The pinned gateway accepts `thread-stream-state-changed` version 11. Codex desktop
26.1111.2228 emits version 13 with the same snapshot and patch envelope. The gateway
previously invalidated every affected desktop session when receiving that event.
The phone could still connect to the authenticated Remote AI relay and read saved
history, but the desktop queue could not resume the official conversation before sending.

Read-only diagnosis confirmed a native owner existed and answered the follower with
a version-13 snapshot while the gateway reported `connected: false`. The saved failed
message remained in the desktop outbox; no message was submitted during diagnosis.
The current desktop still declares start-turn v2, steering v1 and settings v2, matching
the pinned gateway's outbound request versions.

`scripts/official-codex/native_protocol.py` adapts only verified v13 snapshot/patch
envelopes to the pinned v11 event handler. Owner, conversation identity, revisions,
state validation and permissions continue through the original handler. Unknown
versions and malformed envelopes retain its rejection behavior. The wrapper is loaded
by the existing runtime launcher and included by both packaging scripts.

Failed queue preparations now retain their specific safe connection/authentication
message and require deliberate retry. The automatic flush guard also recognizes older
failed entries, preserving their classification, IDs, drafts and attachments without
dispatching them as soon as the connection recovers. An uncertain post-dispatch failure remains
uncertain and is never automatically replayed.

Mobile Web uses the existing table viewport and expand/copy controls, with bounded
cell widths and horizontal scrolling. Desktop local and remote renderers use matching
width rules. The native renderer already uses a horizontal `SwipeSafeScrollView` and
retains that implementation. The public Web deployment must consume the updated
committed shared-source overlay to receive the table change.

Verification covers v13 snapshots/patches, legacy/unknown versions, malformed envelopes,
idempotent installation, queue restoration and single explicit retries. Browser fixtures
cover local/remote desktop and 390/320-pixel mobile viewports, including table scrolling
and expansion. Real native execution connectivity is verified separately after installation.
