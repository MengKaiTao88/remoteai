# Personal Remote AI mobile Web

The user's personal Web edition lives in `apps/web`, tracked independently in
`MengKaiTao88/remoteai-web` on `codex/local-customization`. Its own documentation is
[`apps/web/docs/personal-mobile-web.md`](../apps/web/docs/personal-mobile-web.md).

The requested scope is a dedicated DSH-style React Web/PWA chat workspace while retaining Remote AI
authentication, transports and ChatController. Only the conversation sidebar, messages, header,
composer and chat-related details/cards change. Management pages and application navigation keep
their original UI. Normal Web builds, native and desktop packages retain their existing presentation.

The source reference is DSH Go revision `d46847ff2e0953d2035e0e6078be1e06dd7cbc40`, particularly its
adaptive layout, header, composer, row derivation and chat list. The new TypeScript presentation adapts
those layout and interaction rules without copying Flutter source, artwork, branding, Android runtime
or phone automation. It contains a typed view-model adapter, adaptive shell, row renderer, composer
integration and existing-provider bridge. No second sender, login or history protocol is introduced.

Phone drawers, tablet bottom details sheets, expanded rails/sidebars and right details preserve the
reading column and keep chat/composer nodes mounted. Completed processes fold; interrupted and failed
work remains visible. Adjacent tools group, row keys stay stable, and existing actionable approvals,
editable messages, files/images, tool details and waiting-message controls remain connected. Reading
anchors use the existing DOM implementation rather than Flutter's sliver implementation.

Run `npm --prefix apps/web run check:personal` to build the personal edition. Its default backend is
the author's public API at `https://codex.onepiper.cloud`, and its independent static entry is
`https://mengkaitao88.github.io/remoteai-web/`. The upstream author's hosted Web is not modified.
Existing cloud account synchronization, credential upload behavior and computer-side execution are
unchanged. This task does not implement a local-only account store or migrate browser-local data.

Verification commands (run sequentially because each runner prepares the generated workspace):

- `npm --prefix apps/web run check:personal`: dependency provenance, i18n ownership, types and build.
- `npm --prefix apps/web test`: workspace and unit tests, including row adaptation and shell privacy.
- `npm --prefix apps/web run test:personal:e2e`: light/dark phones, 320px enlarged font, tablet,
  WebKit and wide/narrow desktop journeys; process/approval cards and history anchors.
- `npm --prefix apps/web run test:personal:pwa`: production manifest, scoped service worker,
  and offline login shell with an Origin-varying static server.
- `npm --prefix apps/web run test:personal:webkit`: bundled WebKit light/dark login and startup retry.

Screenshots from the running local fixture are retained under the ignored
`.artifacts/personal-mobile-web/` directory. Full evidence and logs are in `apps/web/test-results/`.
No real cloud credentials are used by the fixture tests. The build removes external Google Fonts
requests and displays localized startup/retry feedback for an initial script failure; later resource
errors do not obscure an already rendered application.

Local results on 2026-11-16: personal type/build/i18n/provenance checks, two workspace tests, 40 Vitest
tests, 14 personal browser journeys and production PWA/WebKit smoke checks passed. The ordinary Web
relay journey passed on desktop and on mobile after a cold-start navigation retry. Offline in-progress
turns retain the original cached presentation until reconnecting. Prepending history also retains the
blank tail of a short page, preventing browser scroll clamping from moving the reader's anchor.

Physical iPhone/Android installation, a real cloud login and cellular-network use require device
acceptance; browser viewport and local fixture checks do not establish those results. An offline
application shell does not provide offline AI execution. The service worker caches public build
assets only, does not cache API responses, and does not force an active conversation to reload.

The pre-existing project-retention implementation and three desktop browser configurations remain
separate, incomplete/unconfirmed tasks. They are preserved rather than included in this Web change.
