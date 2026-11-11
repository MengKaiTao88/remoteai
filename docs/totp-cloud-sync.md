# 2FA cloud synchronization

The desktop dashboard (including its remote mode and hosted LAN pages) and the standalone Web client
use the same `/sync/totp` cloud vault. The automatic-sync preference is local to each client; enabling
it on one device does not enable uploads from another device. Both clients must use the same cloud
server and account to exchange vault changes.

When automatic synchronization is enabled, clients check on startup, every 30 seconds while visible,
and when the window regains focus, becomes visible, or regains a network connection. Local edits
request synchronization immediately. Hidden pages resume checking when shown again.

Each client serializes downloads and uploads. It merges the cloud vault into the latest local state
before uploading, preserving edits made during requests and timestamped deletion records. Equal
contents do not require another upload, even if entries or object fields arrive in a different order.
An unsuccessful upload leaves the local vault intact and is retried on the next automatic check.
Background requests do not repeat failure toasts; explicit synchronization still reports failures.

Pending requests are scoped to the current login identity. Logout, account changes and unmounting
invalidate stale results. Web uploads also validate the expected account and server at the HTTP
boundary, including retries after access-token renewal.

The LAN adapter must dispatch both `cloud_pull_totp` and `cloud_sync_totp`. The latter uses the existing
asynchronous Rust command and its vault validation. LAN authentication and origin checks still apply.

Regression coverage lives in desktop `useTotpEntries.test.tsx`, Web `useTotpVault.test.tsx` and
`totpSession.test.ts`, and the Web management browser scenario for cross-device 2FA changes.
