# Customized source backup

This branch preserves the local official Codex bridge, chat appearance, synchronized
model selection, native usage discovery and subsequent Windows startup repair.
It is backed up in the user's repositories; it is not an upstream pull request.

Clone this branch with submodules:

```sh
git clone --branch codex/official-codex-bridge --recurse-submodules https://github.com/MengKaiTao88/remoteai.git
```

The customized `shared`, `apps/web` and `packages/i18n` revisions are published in
the corresponding `MengKaiTao88` repositories on `codex/local-customization`.
The parent pins exact commits, so recursive cloning selects the verified revisions.
Other submodules retain their original upstream locations and pinned commits.

Automatic application updates remain disabled in the customized package. User
accounts, authentication files, application databases, local screenshots, recovery
backups, build output and runtime logs are not part of this source backup.

## Windows executable behavior

The desktop entry point uses the Windows GUI subsystem for both release and local
development packages. Installing a development-profile package must not allocate
a console for the dashboard or Chrome Native Messaging helper. The helper still
uses Chrome's inherited standard input/output pipes; it does not start another
dashboard. Verify the actual executable's PE subsystem, not only its launch flags.

## Project visibility recovery

Official Codex stores projects in its app-server database and maintains a separate
desktop project cache and thread memberships. An empty cache can hide intact
projects. Diagnose the database, `project/list`, desktop cache and any retained
account-scoped state before attempting recovery. Back up runtime state first, then
use the application's existing state and membership services to restore the
original project identities and associations. Never include those private backups
in a Git commit or infer that an empty sidebar means project folders were deleted.
