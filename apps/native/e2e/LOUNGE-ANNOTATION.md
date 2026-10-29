# Lounge image annotation verification

The annotation fixture renders the production native composer with two identical images and a text draft.
It uses a separate application ID and build output so the installed app and other fixtures remain intact.
The runner checks cancellation, editing one image, sending the edited image alongside the unchanged second
image, and back navigation at Android font scales 1.0 and 1.3. Inspect all screenshots for complete Chinese
glyphs and usable tools in both themes. Restore the font scale even if a check fails.

```powershell
$env:NODE_PATH = (Resolve-Path apps/native/node_modules).Path
$env:NODE_ENV = 'production'
$env:ANDROID_SERIAL = '<physical device serial from adb devices>'
Push-Location apps/native/android
.\gradlew.bat assembleRelease -I ../e2e/lounge-annotation.init.gradle -PreactNativeArchitectures=arm64-v8a
Pop-Location
node apps/native/e2e/lounge-annotation-test.mjs
```

Screenshots are saved in `.codex-tmp/lounge-annotation-android`. This checks the native composer and WebView;
it does not establish iOS execution or real-server delivery. Browser transport, desktop local/remote,
desktop Web and 320px/390px mobile Web are covered by `lounge-image-annotation.pw.ts`:

```powershell
Push-Location apps/desktop
npx playwright test --config playwright.lounge.config.ts lounge-image-annotation.pw.ts
Pop-Location
```
