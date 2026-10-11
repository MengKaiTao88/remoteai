import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const registry = JSON.parse(readFileSync(join(root, "apps/coze/runtime.json"), "utf8"));
const destination = resolve(process.argv[2] ?? join(root, "apps/coze/dist/models"));
const files = [
  ["model.safetensors", "1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477"],
  ["tokenizer.json", "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"],
  ["config.json", null],
];

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

mkdirSync(destination, { recursive: true });
for (const [name, checksum] of files) {
  const target = join(destination, name);
  if (existsSync(target) && checksum && await digest(target) === checksum) continue;
  const url = `https://huggingface.co/${registry.model.repository}/resolve/${registry.model.revision}/${name}`;
  const temporary = `${target}.partial`;
  console.log(`Downloading Coze knowledge model: ${name}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`Model download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  if (checksum && await digest(temporary) !== checksum) {
    unlinkSync(temporary);
    throw new Error(`Model integrity verification failed: ${name}`);
  }
  if (existsSync(target)) unlinkSync(target);
  renameSync(temporary, target);
}
