import assert from "node:assert/strict";

export async function advancedSmoke({ command, url, token, create }) {
  const publish = (resource) => command("publish", { id: resource.id, revision: resource.revision, enabled: true });
  const request = (credential, method, params) => fetch(`${url}/api`, { method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }) });
  const script = (language, code) => ({ nodes: [
    { id: "start", name: "开始", type: "start" },
    { id: "code", name: "计算", type: "code", language, entrypoint: true, code, input: "{{input}}" },
    { id: "end", name: "结束", type: "end", value: "{{code.output}}" },
  ], edges: [{ source: "start", target: "code" }, { source: "code", target: "end" }] });
  const python = await create("workflow", "Python 计算", script("python",
    "async def main(args: Args) -> Output:\n    return {'sum': sum(args.params['values'])}"));
  const typescript = await create("workflow", "TypeScript 计算", script("typescript",
    "async function main(args: {params: {values: number[]}}) { return {sum: args.params.values.reduce((a,b)=>a+b,0)}; }"));
  for (const resource of [python, typescript]) {
    assert.deepEqual((await command("run", { resourceId: resource.id, input: { values: [2, 3, 5] } })).output, { sum: 10 });
    await publish(resource);
  }
  const app = await create("app", "计算应用", { entryId: python.id, resourceIds: [python.id, typescript.id] });
  await publish(app);
  await command("save_resource", { ...python, id: python.id, kind: "workflow", name: "新版计算",
    description: "更新草稿", revision: 1, draft: script("python", "async def main(args):\n    return {'sum': 99}"),
    publishedRevision: undefined, mcpEnabled: undefined, updatedAt: undefined });
  await command("publish", { id: python.id, revision: 2, enabled: true });
  const pinned = await command("run_app", { appId: app.id, input: { values: [2, 3, 5] }, published: true });
  assert.deepEqual(pinned.output, { sum: 10 });

  const grant = await command("issue_access", { appId: app.id, name: "只读测试", role: "viewer", expiresDays: 1 });
  assert.equal((await request(grant.token, "access_info")).status, 200);
  const visible = await (await request(grant.token, "list_resources")).json();
  assert.equal(visible.length, 3);
  assert.equal(visible.find((item) => item.id === python.id).revision, 1);
  assert.equal((await request(grant.token, "run_app", { appId: app.id, published: true })).status, 401);
  assert.equal((await fetch(`${url}/backup`, { headers: { authorization: `Bearer ${grant.token}` } })).status, 401);
  await command("revoke_access", { id: grant.id });
  assert.equal((await request(grant.token, "list_resources")).status, 401);

  const interaction = await create("workflow", "交互确认", { nodes: [
    { id: "start", name: "开始", type: "start" },
    { id: "ask", name: "确认", type: "input", prompt: "请输入称呼", choices: [],
      fields: [{ name: "answer", kind: "string", description: "称呼", required: true }] },
    { id: "end", name: "结束", type: "end", value: "{{ask.output.answer}}" },
  ], edges: [{ source: "start", target: "ask" }, { source: "ask", target: "end" }] });
  await publish(interaction);
  const mcp = async (name, args) => {
    const response = await fetch(`${url}/mcp`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const frame = await response.json();
    assert.equal(frame.result?.isError, undefined, JSON.stringify(frame));
    return JSON.parse(frame.result.content[0].text);
  };
  const paused = await mcp("coze_call", { resource_id: interaction.id, input: {} });
  assert.equal(paused.status, "paused");
  const resumed = await mcp("coze_resume", { run_id: paused.id, interaction_id: paused.interaction.id,
    input: { answer: "Remote AI" } });
  assert.equal(resumed.output, "Remote AI");

  const table = await create("table", "订单", { columns: ["amount"] });
  await command("import_table_rows", { tableId: table.id, name: "orders.csv",
    contentBase64: Buffer.from("amount\n10\n20\n").toString("base64") });
  const queried = await command("table_sql", { tables: [table.id], sql: 'SELECT SUM("amount") AS total FROM t1' });
  assert.equal(queried.rows[0][0], 30);
  assert.equal((await request(token, "table_sql", { tables: [table.id], sql: "SELECT * FROM resources" })).status, 400);
  const template = await command("export_template", { id: app.id });
  const saved = await command("save_template", template);
  const installed = await command("install_template", { id: saved.id });
  assert.notEqual(installed.entryId, app.id);
  assert.equal(installed.resourceIds.length, 3);

  const before = await command("list_resources");
  const backup = await fetch(`${url}/backup`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(backup.status, 200);
  const bytes = await backup.arrayBuffer();
  await create("prompt", "备份之后", { text: "不会保留在恢复后的库中" });
  const restored = await fetch(`${url}/backup`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: bytes });
  assert.equal(restored.status, 200, await restored.text());
  assert.equal((await command("list_resources")).length, before.length);
  console.log("PASS: packaged Python/TypeScript, immutable apps, access isolation, Chatflow MCP resume, SQL, templates, backup.");
}
