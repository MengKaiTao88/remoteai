// Run against a disposable, empty Coze workspace using the desktop's real model proxy.
// The state file is read locally; its credential is never included in the report.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { advancedSmoke } from "./smoke-coze-advanced.mjs";

const [statePath, model, reportPath, imagePath, pdfPath] = process.argv.slice(2);
if (!statePath || !model || !reportPath || !imagePath || !pdfPath) {
  throw new Error("Usage: node scripts/smoke-coze-live.mjs <runtime.json> <model> <report.json> <image> <scanned.pdf>");
}
const { url, token } = JSON.parse(readFileSync(statePath, "utf8"));
assert.equal(new URL(url).hostname, "127.0.0.1");
const report = { startedAt: new Date().toISOString(), model, checks: [], resources: {} };
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
const command = async (method, params) => {
  const response = await fetch(`${url}/api`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json",
  }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(240_000) });
  const result = await response.json();
  assert.equal(response.status, 200, `${method}: ${JSON.stringify(result)}`);
  return result;
};
const create = (kind, name, draft) => command("save_resource", {
  kind, name: `VM验收 ${name}`, description: "Windows 虚拟机真实模型验收", draft,
});
const publish = (resource) => command("publish", { id: resource.id, revision: resource.revision, enabled: true });
async function check(name, test) {
  const started = Date.now();
  try {
    const evidence = await test();
    report.checks.push({ name, passed: true, ms: Date.now() - started, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, passed: false, ms: Date.now() - started, error: error.message });
    throw error;
  } finally { save(); }
}
async function job(method, params) {
  const { id } = await command(method, params);
  const events = [];
  let after = 0;
  let sawRunningDelta = false;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const status = await command("job_status", { id, after });
    events.push(...status.events);
    after = status.events.at(-1)?.sequence ?? after;
    sawRunningDelta ||= status.status === "running" && status.events.some(({ event }) => event.type === "delta");
    if (status.status !== "running" && after >= status.lastSequence) {
      assert.equal(status.status, "completed", status.error);
      return { result: status.result, events, sawRunningDelta };
    }
    await delay(100);
  }
  await command("job_cancel", { id });
  throw new Error(`${method} timed out`);
}
const graph = (nodes) => ({
  nodes: [{ id: "start", name: "开始", type: "start" }, ...nodes,
    { id: "end", name: "结束", type: "end", value: `{{${nodes.at(-1).id}.output}}` }],
  edges: ["start", ...nodes.map(({ id }) => id), "end"].slice(1)
    .map((target, index) => ({ source: ["start", ...nodes.map(({ id }) => id)][index], target })),
});

try {
  const existing = await command("list_resources");
  if (process.argv.includes("--retry-fixtures")) {
    assert(existing.every(({ name }) => name.startsWith("VM验收 ")), "Workspace contains non-fixture resources");
  } else {
    assert.equal(existing.length, 0, "Use an empty disposable Coze workspace");
  }
  await check("real model catalog", async () => {
    const models = await command("models");
    assert(models.some(({ id }) => id === model));
    return { count: models.length, selected: model };
  });
  const knowledge = await create("knowledge", "青岚资料", {});
  report.resources.knowledge = knowledge.id;
  await check("local embeddings and Chinese retrieval", async () => {
    const { result: document, events } = await job("import_document_start", {
      knowledgeId: knowledge.id, name: "青岚验收.md",
      contentBase64: Buffer.from("青岚项目的专用验收编号是 QL-739251，负责人是林晨。此编号仅用于测试。").toString("base64"),
    });
    const hits = await command("search", { knowledgeIds: [knowledge.id], query: "青岚项目的验收编号", limit: 3 });
    assert.match(hits[0].text, /QL-739251/);
    return { document: document.id, hits: hits.length, progressEvents: events.length };
  });
  const agent = await create("agent", "知识库助手", {
    model, prompt: "根据提供的知识库回答，给出来源编号。不要编造。", knowledgeIds: [knowledge.id],
  });
  report.resources.agent = agent.id;
  await check("live streaming before completion", async () => {
    const streaming = await create("agent", "流式输出", { model, prompt: "按用户要求回答。" });
    const { result, sawRunningDelta, events } = await job("chat_start", { agentId: streaming.id,
      message: "请写一篇约六百字的中文说明，介绍怎样整理一本书的阅读笔记，不要调用工具。" });
    assert(sawRunningDelta, "No text was observed while the model job was still running");
    assert(result.message.content.length > 100);
    return { sawRunningDelta, deltaEvents: events.filter(({ event }) => event.type === "delta").length };
  });
  await check("real streaming RAG with citations", async () => {
    const { result, events, sawRunningDelta } = await job("chat_start", {
      agentId: agent.id, message: "青岚项目的专用验收编号和负责人是什么？请简短回答。",
    });
    assert.match(result.message.content, /QL-739251/);
    assert(result.message.citations.length > 0);
    assert(events.some(({ event }) => event.type === "delta"));
    report.resources.conversation = result.conversationId;
    return { answer: result.message.content, citations: result.message.citations.length, sawRunningDelta };
  });
  await check("cancel live model request", async () => {
    const { id } = await command("chat_start", { agentId: agent.id,
      message: "请详细列出一千种不同的知识库测试方法，每种至少三句话。" });
    await delay(500);
    const started = Date.now();
    await command("job_cancel", { id });
    for (let count = 0; count < 50; count++) {
      const state = await command("job_status", { id, after: 0 });
      if (state.status !== "running") {
        assert.equal(state.status, "cancelled");
        return { cancelMs: Date.now() - started };
      }
      await delay(100);
    }
    throw new Error("Cancellation did not settle");
  });
  const table = await create("table", "工具数据", { columns: ["code", "value"] });
  await command("import_table_rows", { tableId: table.id, name: "tool.csv",
    contentBase64: Buffer.from("code,value\nVM_SECRET,ZEBRA-48219\n").toString("base64") });
  await publish(table);
  await check("real natural-language SQL generation and query", async () => {
    const generated = await command("generate_table_sql", { tables: [table.id], model,
      question: "查询 code 等于 VM_SECRET 的行的 value 字段" });
    const result = await command("table_sql", { tables: [table.id], sql: generated.sql });
    assert.equal(result.rows[0][0], "ZEBRA-48219");
    return { sql: generated.sql, rows: result.rows };
  });
  const toolAgent = await create("agent", "工具助手", { model, toolIds: [table.id],
    prompt: "必须先调用已提供的数据表工具，查询 VM_SECRET 的 value。只根据工具结果作答。", maxSteps: 3 });
  await check("real autonomous tool call and replayed history", async () => {
    const first = await job("chat_start", { agentId: toolAgent.id, message: "查询 VM_SECRET 的 value" });
    report.resources.toolAgent = toolAgent.id;
    report.toolEvidence = first.events.filter(({ event }) => ["tool_start", "tool_end"].includes(event.type));
    assert(report.toolEvidence.some(({ event }) => event.type === "tool_end"), "Model did not call the table tool");
    assert.match(first.result.message.content, /ZEBRA-48219/);
    const next = await job("chat_start", { agentId: toolAgent.id,
      conversationId: first.result.conversationId, message: "重复刚才的查询结果，不需要再次查询。" });
    assert.match(next.result.message.content, /ZEBRA-48219/);
    return { answer: first.result.message.content, repeated: next.result.message.content,
      eventTypes: [...new Set(first.events.map(({ event }) => event.type))] };
  });
  await check("workflow with real LLM and isolated Python", async () => {
    const workflow = await create("workflow", "模型计算", graph([
      { id: "llm", name: "模型", type: "llm", model, prompt: "Reply exactly COZE_WORKFLOW_OK", system: "Be concise." },
      { id: "python", name: "Python", type: "code", language: "python", entrypoint: true,
        input: { text: "{{llm.output}}" }, code: "async def main(args):\n    return {'text': args.params['text'], 'sum': sum([2, 3, 5])}" },
    ]));
    const { result } = await job("run_start", { resourceId: workflow.id, input: {} });
    assert.match(result.output.text, /COZE_WORKFLOW_OK/);
    assert.equal(result.output.sum, 10);
    return result.output;
  });
  for (const [name, path, expected] of [["image OCR", imagePath, "VX-84620"], ["scanned PDF OCR", pdfPath, "VX-84620"]]) {
    await check(name, async () => {
      const { result: document, events } = await job("import_media_document_start", {
        knowledgeId: knowledge.id, name: name === "image OCR" ? "vision.png" : "scanned.pdf", model,
        contentBase64: readFileSync(path).toString("base64"),
      });
      const chunks = await command("read_chunks", { id: document.id });
      assert.match(chunks.map(({ text }) => text).join("\n"), new RegExp(expected));
      return { document: document.id, chunks: chunks.length, progressEvents: events.length };
    });
  }
  await check("packaged advanced workflows, sharing, templates, SQL and backup", async () => {
    await advancedSmoke({ command, url, token, create });
    return "passed";
  });
  const gui = await create("workflow", "Codex GUI 调用", graph([
    { id: "reply", name: "验收回执", type: "template", template: "COZE_GUI_VM_739251" },
  ]));
  await publish(gui);
  report.resources.guiWorkflow = gui.id;
  await check("nested Chatflow checkpoint for restart", async () => {
    const child = await create("workflow", "子流程确认", graph([
      { id: "ask", name: "输入", type: "input", prompt: "请填写验收码", choices: [],
        fields: [{ name: "answer", kind: "string", description: "验收码", required: true }] },
    ]));
    const parent = await create("workflow", "嵌套流程", graph([
      { id: "child", name: "子流程", type: "subworkflow", workflow_id: child.id, input: {} },
    ]));
    const paused = await command("run", { resourceId: parent.id, input: {} });
    assert.equal(paused.status, "paused");
    report.resources.paused = { runId: paused.id, interactionId: paused.interaction.id, workflowId: parent.id };
    return report.resources.paused;
  });
  report.resourceCount = (await command("list_resources")).length;
  report.completedAt = new Date().toISOString();
  save();
} catch (error) {
  report.error = error.message;
  save();
  process.exitCode = 1;
}
