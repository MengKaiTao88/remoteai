# Android update download checks

With the Android SDK, JDK 17 and the project's Gradle dependencies available, connect an Android
device or start an emulator, then run from the repository root:

```powershell
$env:ANDROID_SERIAL = 'emulator-5580'
node apps/native/e2e/update-download-test.mjs
```

This compiles the production Kotlin downloader and scheduler, then calls them directly on Android.
It checks continuous responses, resumed and non-contiguous ranges, invalid or truncated responses,
cancellation, connection cleanup, and cooperation with peer downloads. It does not install an APK,
launch the app, or access an account.

The checks also exercise repeated login-time empty task saves, interrupted and failed checkpoint writes,
hash-page replacement, timed and 4 MiB checkpoint batches, final flush and corrupt-block recovery.
They package the app's AndroidX atomic file implementation, avoiding vendor framework atomic commit code.
Three 32 MiB write benchmarks compare the production updater checkpoint writer with the production
download-manager storage class. These are storage measurements, not end-to-end download speeds.

Add `--local` for a complete 32 MiB HTTP transfer through ADB port forwarding with SHA-256 validation.
It isolates the receiver's HTTP/read/checkpoint/hash overhead from GitHub and ISP performance. The fixture uses
a loopback HTTP server and a temporary port forward, both removed when the check ends. This is not a
measurement of a phone's Wi-Fi connection or internet bandwidth. `--local` and `--live` are exclusive.

Add `--live` to download the complete latest official APK through the same production class and
verify its SHA-256 against the GitHub release metadata. This consumes the APK's full download size.
The payload is written through the production checkpoint writer, then read back and hashed; temporary
files are removed after the check, and no APK is installed. The live check
also verifies that a fresh sequential download uses one HTTP request per 8 MiB before redirects.
Responses stay bounded because live checks found whole-file responses much slower than 8 MiB ranges.
APK signer verification remains the responsibility of the app. The combined transfer measurement
includes HTTP reading, block hashes, durable checkpoints and final full-file SHA-256 verification.

## Local comparison on 2026-10-13

Android API 35 x86_64 emulator, with the HTTP fixture forwarded through ADB:

- Complete 32 MiB transfer, checkpoint writes and final file verification: 1.693 s, 18.9 MiB/s.
- Repeated after the concurrent build finished: 0.883 s, 36.2 MiB/s, with the same full-file checks.
- Updater checkpoint writer, three 32 MiB runs: 104.0, 107.3 and 88.1 MiB/s.
- Download-manager storage, the same three runs: 119.4, 130.5 and 97.7 MiB/s.

The receiver exceeded the 10 MB/s comparison target locally. These numbers do not establish that
a physical phone or the public release download reaches that rate. The GitHub sample did not reach
10 MB/s: its first 8 MiB response took 406 s, whereas later responses sometimes took 2–6 s. The run
was stopped after 48 MiB; it was not a completed or fully verified official APK download.
