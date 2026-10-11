import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

const binary = resolve(process.argv[2]);
const preview = process.argv.includes("--preview");
const temporaryRoot = resolve(".codex-tmp");
mkdirSync(temporaryRoot, { recursive: true });
const data = mkdtempSync(join(temporaryRoot, "coze-smoke-"));
const token = randomBytes(32).toString("hex");
let requests = 0;
const proxy = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, "Bearer fixture-local-proxy");
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/models") return response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  assert.equal(input.model, "test-model");
  requests++;
  response.end(JSON.stringify({ choices: [{ message: { content: "青岚计划的发布编号是 73。[1]" } }] }));
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const child = spawn(binary, ["--serve"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.stdin.write(`${JSON.stringify({ dataDir: data, token,
  proxyUrl: `http://127.0.0.1:${proxy.address().port}/v1`, proxyToken: "fixture-local-proxy" })}\n`);
const lines = createInterface({ input: child.stdout });
const [ready] = await Promise.race([once(lines, "line"), once(child, "exit").then(() => {
  throw new Error("Runtime exited before becoming ready");
})]);
const { url } = JSON.parse(ready);
const command = async (method, params) => {
  const response = await fetch(`${url}/api`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json",
  }, body: JSON.stringify({ method, params }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
};
const create = (kind, name, draft) => command("save_resource", { kind, name, description: "回归测试", draft });

try {
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(`${url}/api`, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(`${url}/api`, { method: "POST", headers: { authorization: `Bearer ${token}`,
    origin: "https://untrusted.example" }, body: "{}" })).status, 401);
  assert.equal((await command("models"))[0].id, "test-model");
  const knowledge = await create("knowledge", "产品手册", {});
  const document = await command("import_document", { knowledgeId: knowledge.id, name: "产品手册.md",
    contentBase64: Buffer.from("青岚计划的发布编号是 73。客户可以在账户设置中重置登录密码。").toString("base64") });
  const hits = await command("search", { knowledgeIds: [knowledge.id], query: "青岚计划的发布编号是多少？", limit: 3 });
  assert.equal(hits[0].documentName, "产品手册.md");
  assert.match(hits[0].text, /73/);
  assert.equal((await command("read_chunks", { id: document.id })).length, 1);
  const agent = await create("agent", "产品助手", { model: "test-model", prompt: "根据资料回答问题。",
    knowledgeIds: [knowledge.id], temperature: 0.7 });
  const chat = await command("chat", { agentId: agent.id, message: "青岚计划的发布编号？" });
  assert.equal(chat.message.citations.length, 1);
  assert.equal((await command("messages", { id: chat.conversationId })).length, 2);
  assert.equal(requests, 1);
  const workflow = await create("workflow", "欢迎工作流", { nodes: [
    { id: "start", name: "开始", type: "start", x: 40, y: 70 },
    { id: "text", name: "问候", type: "template", template: "你好，{{input.name}}", x: 300, y: 70 },
    { id: "end", name: "结束", type: "end", value: "{{text.output}}", x: 570, y: 70 },
  ], edges: [{ source: "start", target: "text" }, { source: "text", target: "end" }] });
  await command("publish", { id: workflow.id, revision: 1, enabled: true });
  const stateFile = join(data, "runtime.json");
  writeFileSync(stateFile, JSON.stringify({ url, token }));
  const helper = spawn(binary, [`--coze-mcp=${stateFile}`], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  helper.stdout.on("data", (chunk) => { output += chunk; });
  helper.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "coze_call",
      arguments: { resource_id: workflow.id, input: { name: "Remote AI" } } } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n");
  const [code] = await once(helper, "exit");
  assert.equal(code, 0);
  const frames = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames.length, 2);
  assert.equal(JSON.parse(frames[1].result.content[0].text).output, "你好，Remote AI");
  assert.equal((await command("runs", { id: workflow.id }))[0].status, "completed");
  console.log("PASS: local auth, assets, knowledge ingestion/retrieval, RAG chat, persistent history, workflow MCP STDIO.");
  if (preview) {
    writeFileSync(join(temporaryRoot, "coze-preview.json"), JSON.stringify({ url: `${url}/#token=${token}`, data }));
    console.log(`Preview ready: ${url}`);
    await new Promise((resolve) => process.on("SIGINT", resolve));
  }
} finally {
  child.stdin.end();
  await once(child, "exit");
  proxy.close();
}
