# Remote AI 2.3 integration in the customized desktop bridge

The integration baseline is PC `v2.3.1` (`1479d3f2bc4939e3a42356920614b832cf44a576`),
Web `v2.3.0` (`80ffedd6c295d08aecb51212a68c6bcc8d92aecb`), Native `v2.3.0`
(`3af0b6abb5986f6a5979bb4d17588d696d09633f`), and the shared source pinned by the PC release
(`99f6a2700bd898a7bbcff5ae2ddd8ed6d3d9c013`). Later browser redesign commits are outside this baseline.

## Preserved behavior

- Official Codex Desktop remains an independent conversation backend with authoritative model and
  permission settings, saved-history paging, native usage, retained attachments, and native project membership.
- Remote acknowledgements retire accepted drafts without resending them. Failed drafts remain available
  for explicit review; reconnecting does not dispatch them automatically.
- Reset-time account priorities remain independent of manually saved priorities and of the GUI account
  routing settings. Claude accounts do not enter Codex-only automatic-priority controls.
- Subscription expiration and OAuth access-token expiration remain distinct values and code paths.
- Two-factor vault synchronization, chat-only styling, the application navigation, disabled automatic
  application updates, and the balanced cache retention policy remain in place.

## Integrated behavior

The release adds Claude Code and Gemini CLI conversations, account management, images, model selection,
file changes, and engine-specific histories; resumable compressed conversation transfers; PDF navigation;
SSH profile references and persistent agent terminals; Git repository and large-list improvements;
message editing, image galleries, drafts, and history lifecycle improvements; and serialized account-token
refresh with cloud propagation. Shared sources are exported to Web using the repository export tool.

## Engine boundaries

Standalone Codex uses its paginated turn/item RPCs and host-owned restart recovery journal. Official
Codex Desktop retains its own lifecycle and bounded saved-history protocol. It must not be given the
standalone engine's recovery capability, which could produce an invalid recovery request or duplicate work.
Official process disclosures resolve their exact range from gateway-authorized history and reuse the
same payload summarization and range validation as standalone conversations.

Claude/Gemini account selection explicitly identifies the engine when reading or updating the proxy
route. The standalone route stays separate from the official proxy target. Remote account snapshots
carry only optional `cliSelected` booleans, so older clients remain compatible without receiving
credentials. A single local CLI context owns both the workspace and its account picker; changing
engines does not remount the conversation or reset its draft. Local runtime discovery is inactive
while the user is viewing another computer.

Conversation synchronization operates on explicitly selected Codex Home folders. It does not implicitly
move the currently running official conversation or upload authentication/configuration state. Its
remote capability negotiation must succeed before a resumable transfer starts.

## Verification and deployment

Ignored local evidence, pre-integration patches, file snapshots, and the original Git indexes are stored
under `.artifacts/upstream-2.3.1/`. A successful frontend build alone does not establish integration
completion: Rust, bridge, frontend, transport, and browser interaction checks must also pass.
Public Web publication and physical-device installation are separate from a local source integration.
The public website must not be described as updated merely because the local Web package was built.

The independent translation package is `0.1.18-custom.2`, published from its exact verified source
revision in the user's personal repository. Keep the earlier immutable `custom.1` archive unused; its
release tag does not identify the matching customized source revision.

Completed integration checks include the following evidence under the directory above:

- Native: 1,459 tests in 258 files; type checking and generated asset/platform resource checks;
  Android and iOS JavaScript exports. These do not replace physical-device installation and font checks.
- Independent Web: production build, generated dependency verification, translation ownership,
  28 unit tests and the two workspace runner checks.
- Desktop browser fixtures: 48 CLI/conversation-transfer cases, followed by 37 final CLI/Git/PDF
  cases, seven mobile Web cases and nine restart-recovery cases. The final Git fixtures contain
  12,000 changed files and cover local, remote and Web views at default and enlarged font settings.
- Official bridge: 26 Python checks. Account-routing compatibility adds three Rust checks and
  36 frontend checks for shared engine context, independent selection and draft preservation.
- Initial complete Rust run: 2,918 primary library tests passed, with 33 intentionally ignored;
  installer and Windows integration checks passed. The final version adds the engine-routing case,
  bringing the passing library count to 2,919. The normal parent pre-commit hook reruns the complete
  project checks against the final working tree before creating each parent commit.
- The initial desktop frontend suite exposed five assertion/timeout failures; the affected five
  suites passed all 56 checks after fixes. The separate ACP process runner passed four checks.
  No failed cases were removed from the suite.

The final Windows input regression exposed a fixture race: `QS_SENDMESSAGE` can describe unrelated
senders before the intended focus-loss message has been queued. The fixture now waits for the worker
to acknowledge its own cross-thread `SendNotifyMessageW` operation. Tao must still dispatch that exact
message reentrantly, the same assertions check character/IME events, and the parent process retains
its deadlock timeout. The change does not alter application input handling or skip a scenario.

The browser screenshots use running application components with deterministic transport fixtures;
they demonstrate layout and interactions without sending messages to real accounts. Selected images
are retained in `.artifacts/upstream-2.3.1/screenshots/`. Public Web deployment and physical Native
verification remain outside the completed local verification.
