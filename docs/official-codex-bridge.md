# Official Codex Desktop handoff: Windows test build

This opt-in backend connects Remote AI's existing local GUI, authenticated remote desktop chat host,
and phone Web UI to Codex Mobile Bridge on the same computer. Official Codex Desktop remains the
conversation owner. The adapter does not start a second inference runtime, change Codex credentials,
rewrite providers, or change the native conversation's working directory or permissions.

## Test build scope

Supported: discover existing **local desktop** conversations, read their history, stream message and
command progress, send text and images (including the GUI queue), steer the current turn,
stop the verified current turn, rename a conversation,
answer ordinary command/file/permission approvals and user-input questions, and reconnect after transport
failure. Model selection displays `Codex Desktop`: messages inherit the native conversation's settings.
The sidebar uses official project membership and puts projectless chats in Recent, independently of cwd.
For Desktop versions that have not migrated membership to app-server, it reads the project assignments
and order from `.codex-global-state.json` without modifying that file.
The existing Remote AI remote connection and Web chat protocol are reused; a Web redeployment is not
required for these operations. Both desktop and phone connect to the same native thread IDs.
Bridge mode does not restore or start Remote AI's model proxy. Keep the original proxy running if
official Codex uses it; a second listener on the same loopback port can shadow the original on Windows.

This first build switches the entire chat backend at process startup. It does not yet provide a per-thread
source selector. Unsupported operations return an explicit error: new chats, fork/edit/delete/archive,
Skills, model/permission switching, goals, MCP forms, project tools, SSH/WSL conversations,
and GUI account switching. These controls may still be visible in the existing UI. Use official Codex
Desktop for them. Up to 16 recently read conversations are watched; older watches are released as new
ones are opened. Phone background suspension pauses delivery, not the native task.

## Start

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
