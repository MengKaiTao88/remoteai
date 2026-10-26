# Local build with pet labels and LAN quota repair

This integration branch combines the pet dock label preference from
`31404a76c42627644575d5b12cd3586838630024` with the already committed LAN accounting repair
from `f70044cec318af1c9fd8df7dcc384abe2e6b3656`.

The two changes are kept together because installing the quota-only package replaced the previously
installed label-toggle build. Both packages reported version 2.0.23, so the version number alone did
not reveal the missing preference. The installed executable hash matched the quota package manifest.

- Keep **Show text labels** off by default, with large values centered in the pet dock.
- Preserve the independent 8 MiB bounded accounting completion validation, while diagnostic sampling
  stays at 64 KiB. Incomplete or failed usage must still require review.
- Do not clear historical unconfirmed usage, rewrite account data, or change API credentials.
- Build and verify the combined source before replacing the installed application.
- Back up the currently installed quota repair executable before installation.
- Validate label switching and the quota regression suite against this combined source.

The label feature remains tracked by https://github.com/piperhex/remoteai/pull/40.
This branch is a local integration build, not an upstream release. Future installers can replace it;
use a release containing both changes or this combined build to retain both behaviors.
