import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw new Error("Usage: node scripts/package-coze.mjs <binary> <new-output-directory>");
const destination = resolve(output);
if (existsSync(destination)) throw new Error("The package output directory must not already exist");
const source = join(root, "apps/coze");
const registry = JSON.parse(readFileSync(join(source, "runtime.json"), "utf8"));
const cargo = readFileSync(join(source, "Cargo.toml"), "utf8");
const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (version !== registry.version || registry.releaseTag !== `coze-v${version}` || registry.protocol !== 1) {
  throw new Error("Coze Cargo version, release registry and supported protocol must agree");
}
for (const path of [binary, join(source, "dist/ui/index.html"), join(source, "dist/models/model.safetensors")]) {
  if (!existsSync(path)) throw new Error(`Missing package input: ${path}`);
}
mkdirSync(destination, { recursive: true });
cpSync(resolve(binary), join(destination, binary.endsWith(".exe") ? "remoteai-coze.exe" : "remoteai-coze"));
for (const directory of ["ui", "models"]) cpSync(join(source, "dist", directory), join(destination, directory), { recursive: true });
for (const name of ["LICENSE-APACHE", "NOTICE.md"]) cpSync(join(source, name), join(destination, name));
writeFileSync(join(destination, "package.json"), JSON.stringify({ version: registry.version, protocol: registry.protocol }));
mkdirSync(dirname(join(destination, "models/LICENSE")), { recursive: true });
cpSync(join(source, "licenses/e5-MIT.txt"), join(destination, "models/LICENSE"));
console.log(`Coze ${registry.version} staged at ${destination}`);
