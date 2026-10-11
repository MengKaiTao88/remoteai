import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
const env = {
  ...process.env,
  // Match CI: full dependency debug symbols can exceed Windows PDB limits.
  // This affects checks only; assertions and normal development builds stay unchanged.
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
};
const checks = [
  ["cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]],
  ["cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"]],
  [process.execPath, [fileURLToPath(new URL("./check-installer-helper.mjs", import.meta.url))]],
  [process.execPath, [fileURLToPath(new URL("./check-installer-fixture.mjs", import.meta.url))]],
];

for (const [command, args] of checks) {
  const result = spawnSync(command, args, { cwd: desktopRoot, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
