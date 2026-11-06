# Official Codex Desktop handoff and integrated Windows chat modes

This opt-in backend connects Remote AI's existing local GUI, authenticated remote desktop chat host,
and phone Web UI to Codex Mobile Bridge on the same computer. Official Codex Desktop remains the
conversation owner. The adapter does not start a second inference runtime, change Codex credentials,
rewrite providers, or change the native conversation's working directory or permissions.

## Test build scope

Supported: discover existing **local desktop** conversations, read their history, stream message and
command progress, send text and images (including the GUI queue), steer the current turn,
stop the verified current turn, rename a conversation,
answer ordinary command/file/permission approvals and user-input questions, and reconnect after transport
failure. The model picker reads the official owner's available models and reasoning efforts. Existing
conversations load their actual native selection. An explicit change is validated and confirmed by the
owner, then synchronized across local, remote and Web viewers; an active inference is not restarted.
The sidebar uses official project membership and puts projectless chats in Recent, independently of cwd.
For Desktop versions that have not migrated membership to app-server, it reads the project assignments
and order from `.codex-global-state.json` without modifying that file.
The existing Remote AI remote connection and Web chat protocol are reused; a Web redeployment is not
required for these operations. Both desktop and phone connect to the same native thread IDs.
The integrated application retains its normal model proxy in either chat mode. The legacy isolated
launcher does not restore or start that proxy; keep the original proxy running when testing that launcher.
A second listener on the same loopback port can shadow the original on Windows.

The legacy isolated test build selects its chat backend at process startup; the integrated application
has a header selector for GUI and official Codex modes. Unsupported official operations return an explicit error:
new chats, fork/edit/delete/archive,
Skills, permission switching, goals, MCP forms, project tools, SSH/WSL conversations,
and GUI account switching. These controls may still be visible in the existing UI. Use official Codex
Desktop for them. Up to 16 recently read conversations are watched; older watches are released as new
ones are opened. Phone background suspension pauses delivery, not the native task.

## Start the legacy isolated test build

The portable test directory contains `RemoteAI-OfficialCodex.exe`, its `resources` directory, Bridge
source, `Start.cmd`, `Start-OfficialCodex.ps1`, and `initialize_gateway.py`.

1. Keep the official Codex app open and create/open a disposable test conversation there.
2. Install Python 3.12 if needed (`uv python install 3.12`). The gateway uses the standard library.
3. Run `Start.cmd`. The test app uses `dev.codex.switch.bridge-test` and independent app settings.
4. Open Codex GUI in the test app. Its list contains official local Codex conversations.
5. Log into the same Remote AI cloud account in this test app and the usual phone Web UI. Login is
   independent from the installed Remote AI app. Refresh the phone's computer list and select
   `<computer name> · Codex Desktop`; the installed app keeps its original computer name. Keep the
   test app, local gateway and official Codex running.

The launcher starts a password-protected gateway on `127.0.0.1:18797`, stores its password using Windows
DPAPI (`private-runtime/gateway-credential.xml`), and passes it directly to child processes. The gateway
config stores only a password hash. Credentials do not enter command-line arguments or frontend RPC.
Do not share `private-runtime`, account data, logs or screenshots containing conversations. On failure,
inspect `startup-error.log` and `private-runtime/gateway.stderr.log` locally.

For a manually managed gateway, set `REMOTEAI_CODEX_BRIDGE_URL` (only `http://127.0.0.1:PORT` is accepted),
`REMOTEAI_CODEX_BRIDGE_USERNAME`, and `REMOTEAI_CODEX_BRIDGE_PASSWORD` in the environment of the test
process. Start a new process; changing environment variables cannot switch an already running app.
Normal launches with no `REMOTEAI_CODEX_BRIDGE_URL` retain Remote AI's original backend.

Bridge mode never restores, starts or stops a model proxy, and skips stale-proxy configuration cleanup.
The existing desktop and its account manager retain ownership of the model endpoint. Its proxy start
control is hidden in the bridge dashboard so two installations cannot shadow the same loopback port.
Image history uses opaque, chat-scoped references; previews are fetched through the authenticated gateway
only after verifying that the image belongs to that conversation.
The remote handshake disables CLI-managed file previews and streams in bridge mode, so existing Web
clients use the bounded image-preview RPC instead of waiting for an unavailable download queue.
Numeric opening turns are withheld until the owner publishes native message IDs, avoiding duplicate
messages in connected viewers.
Official asynchronous questions are presented as selectable answer cards using the existing user-input
protocol. Their lifetime belongs to the conversation: completing the turn that asked the question does
not dismiss the card. Submitting an answer uses the original native question IDs; the authoritative
gateway resolves it for every connected viewer.

## Acceptance

Use a disposable conversation, and keep both devices on it:

- Send a short message from official Codex. Check that phone progress and its final reply update.
- Send the next message from the phone. Check it appears in that same official conversation.
- Open model settings from the phone, choose a model and supported reasoning effort, and verify the
  official owner's selection. Send a harmless test turn and reload the phone page; both views must
  retain the same model. Restore the disposable conversation's original selection after verification.
- While a task is active, use a steering message and stop it. Check both views converge.
- Trigger a benign approval in a separately configured test chat. Approve or decline once; the other
  view must clear it. The adapter inherits the native policy and never enables approvals by itself.
- Ask an asynchronous question with two harmless options. Wait for the originating turn to complete,
  choose the second option on mobile Web and submit once. Verify the structured answer in official
  Codex, the assistant's follow-up, and that the card stays cleared after reloading the page.
- Turn off phone networking, complete a desktop turn, reconnect, and check complete history without
  duplicates. Close/reopen the phone page and confirm the task continues on the computer.
- Stop/restart the gateway, then reopen the conversation. Check recovery without replaying a message.

If a send fails after a network interruption, inspect the original official conversation before sending
again. Unknown writes are not automatically replayed. Native stop has a small race between checking the
turn ID and the gateway's own stop call; its internal owner also checks the active native turn. Simultaneous
desktop/phone edits and native rollbacks are outside this first build's guarantees.

## Implementation

The integrated Windows application offers **Remote AI GUI** and **Official Codex** in the chat header.
It retains one application profile, cloud identity and proxy service. Selecting a mode verifies the
connection, saves the choice and reloads the chat view in the same process. Existing GUI and official
tasks keep running, and the model proxy stays connected. A generation guard rejects writes from stale views.
Each mode has separate last-chat preferences and a separate durable outbox. Phones keep the same device
connection; refresh/reconnect after the desktop changes modes. The desktop owner controls this switch;
remote viewers follow its selected conversation source.

Explicitly opening an official conversation attaches its native owner before reading model settings.
Passive history reads do not activate it. If activation finishes after the gateway acknowledgement
deadline, the adapter reconciles with read-only polling instead of replaying the activation or a message.
Indexed history timestamps in seconds and live timestamps in milliseconds are normalized to Unix seconds.

Prepare the optional bundled gateway before building an integrated Windows package:
`scripts/official-codex/Prepare-Runtime.ps1 -BridgePath <pinned-bridge-checkout> -Python <python-3.12.exe>`.
It exports immutable bridge sources and a trusted local Python runtime into ignored application resources.
The app starts the loopback gateway on demand. Credentials are protected by Windows DPAPI in application
data and never cross renderer or remote transports. Source checks also work without these optional resources.
Windows helper paths use the existing execution-path normalizer so canonical verbatim drive paths do not
cause Windows PowerShell to misclassify the bundled local script. The application retains the gateway
child directly and records fixed startup stage identifiers without writing helper output or credentials.

Build from an initialized checkout with Node/npm and the Windows Rust/MSVC toolchain:
`scripts/official-codex/Build-Test.ps1`, then
`scripts/official-codex/Package-Test.ps1 -BridgePath <pinned-bridge-checkout>`.
`Build-Test.ps1 -InstalledResources <installed-Remote-AI-resources>` can reuse a trusted local installation's
native runtime resources; it always rebuilds the desktop host service. No signing key is needed for the
local test executable. It does not install or publish a release.

`crates/codex-desktop-bridge` owns loopback authentication, bounded HTTP parsing, state projection,
watch/retry and approval routing. It accepts a closed operation set, disables proxies and redirects, and
never forwards raw gateway errors/credentials. Only reads may retry after session renewal.
`codex_gui/official_bridge.rs` adapts typed Tauri requests and publishes through the existing filtered
GUI/Web event bus. Native item and turn IDs are preserved; appended reply/command text is emitted as
incremental events, and other changed items update in place. History pagination and deferred tool details reuse existing
Remote AI contracts.

Run `cargo test --manifest-path crates/codex-desktop-bridge/Cargo.toml`, strict crate Clippy, desktop
TypeScript/Vite build, Rust check, source-boundary and i18n checks. A read-only native probe is available as
`cargo run --manifest-path crates/codex-desktop-bridge/Cargo.toml --example probe` with the gateway
environment configured. Fixture tests are not phone hardware acceptance.

## Third-party runtime

The test package includes unmodified [Codex Mobile Bridge](https://github.com/try2love/codex-mobile-bridge)
source pinned to `0721aa7dafa6177751ba7e568e0ad0efee05655b`, under its MIT license. Preserve its `LICENSE`
and attribution. No Bridge source is copied into the adapter. Its internal Codex IPC compatibility is
version-dependent. Packaging and publishing a release do not imply upstream endorsement.

## Local Codex-style edition

This workspace is maintained locally. Application updater endpoints remain empty and changes are not
pushed to the Remote AI repositories. The original cloud account and device identity are preserved.

The desktop local/remote GUI chat workspaces and the locally built Web chat share scoped neutral light
and dark appearance tokens. Account management, token summaries, settings, the application shell and
other host pages retain Remote AI's original theme, font and controls. Chat portals inherit their own
workspace theme without writing appearance tokens to the document root. Opening Codex preserves the
host's main navigation alongside the chat's conversation sidebar; only explicitly entering focus mode
hides the desktop application navigation. Process summaries, consecutive
tool groups and individual outputs expand in place. Outputs are mounted only while expanded, long
operation lists scroll internally, and manually inspected details survive streamed updates and completion.
Official-mode group management reads the owner's recent and archived metadata pages, including older
grouped chats, instead of calling the GUI-only metadata index. This also serves remote/Web group dialogs.
The gateway returns cumulative session prefixes; the adapter slices each requested offset and ends the
cursor at the last page. Regression coverage checks disjoint pages and an exhausted cursor so complete
metadata reads cannot repeatedly return the first conversations.

Busy conversations expose the existing queue/steer preference beside the composer. Queued messages
remain in the host-owned persisted queue. A successful remote `steer` now creates the same confirmed
message receipt used by desktop sends, so clearing the remote draft does not leave an empty history
while the native owner has not emitted its user item. Receipts survive lagging history reads and are
replaced by authoritative items without duplicating repeated identical supplements. Failed requests do
not create confirmed receipts.

The existing public Remote AI Web site can use the host-side receipt fix without changing its address.
Its downloaded UI is controlled by that site's operator; local appearance changes cannot replace the
public site's static files. The customized Web build is available separately for a user-controlled host.
This integration does not patch the official Codex desktop client's own UI or message queue.

For a fresh local Web dependency installation, prepare the customized language archive before building.
Run `npm run pack:release` in `packages/i18n`, then run the following in `apps/web`:

```powershell
npm install --offline --no-audit --no-fund --no-save --package-lock=false --ignore-scripts ../../packages/i18n/dist/remoteai-i18n-0.1.5.tgz
```

This installs the local edition's additional language keys without changing the published dependency or
lockfile. Repeat it after `npm ci`; do not publish this customized archive as an upstream release.

Validation includes desktop/Web production builds, localization and source-boundary checks, focused
message and disclosure regression tests, bundled Chromium at desktop/mobile widths and enlarged fonts,
and an original-account public Web test. In that test a supplement appeared during the running turn in
890 ms, survived a page reload and received its final reply with one visible user message.
