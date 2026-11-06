# Official Codex runtime

`scripts/official-codex/Prepare-Runtime.ps1` exports the pinned, unmodified Codex Mobile Bridge source
and copies a trusted local Python 3.12 runtime into `runtime/`. This generated directory is ignored.
The runtime is optional for source checks. Windows packages that enable the Official Codex chat mode
must prepare it before building and preserve the bridge and Python licenses.

Credentials and gateway state belong in the user's application data directory, never in this folder.
