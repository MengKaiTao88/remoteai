# Local official Codex statistics compatibility

This local customization includes the native usage service discovery repair in the
Remote AI executable. Renderer-only replacements disappear when a renderer is
recreated or an application package is replaced.

The current official Windows Codex build loads numbered Rspack ESM entry scripts.
Discover the existing same-origin `/assets/` module scripts as well as legacy
`app-shared` module preloads. Inspect only initialized webpack module cache exports;
never execute module factories or call the webpack require function. Service owners
must be objects, since callable RPC proxies can synthesize misleading properties.

Discovery is bounded, yields during large scans and shares in-flight work. The
subscription remains scoped to the selected local thread's `tokenUsageInfo` field,
releasing leases on thread changes and renderer disposal. Output speed still comes
from the existing proxy timing binding. Cache hit and context percentages continue
to use the existing shared metrics formulas.

The statistics overlay requires a renderer started and connected through Remote AI.
A separate official Codex process opened by an OS deep link can lack its CDP launch
arguments even while Remote AI remains connected to an older, hidden process. In
that case the whole overlay is absent, whereas service discovery failures leave
the overlay present with unavailable percentages. Reconnect or restart the official
client through Remote AI to restore the managed renderer before checking values.

Validation commands:

```powershell
node --test scripts/codex-native-usage-service.test.mjs scripts/codex-native-usage-subscription.test.mjs scripts/codex-usage-statusline.test.mjs scripts/codex-usage-statusline.browser.test.mjs
npm run check
```

Browser fixtures cover legacy and Rspack services, updated usage, disposal and the
statistics footer in narrow light/dark layouts. Use bundled Playwright Chromium via
`scripts/test-browser.mjs` on Windows. Local screenshots and installation evidence
belong in `.artifacts/native-usage-local`; do not commit private live usage captures.

Keep this repair in the customized local build, preserve empty updater endpoints,
and do not upload the local branch or update a public PR without user authorization.
