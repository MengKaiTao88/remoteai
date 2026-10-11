import { expect, test, type Locator, type Page } from "@playwright/test";
import { defaultGraph, type Graph, type Resource } from "../src/types";

async function fixture(page: Page, graph = defaultGraph) {
  let resource: Resource = { id: "canvas-test", name: "画布验收", description: "", kind: "workflow",
    draft: JSON.parse(JSON.stringify(graph)), revision: 1, publishedRevision: null, mcpEnabled: false, updatedAt: "" };
  await page.route("**/api", async (route) => {
    const { method, params } = route.request().postDataJSON();
    let result: unknown;
    switch (method) {
      case "access_info": result = { role: "owner" }; break;
      case "list_resources": result = [resource]; break;
      case "models": result = [{ id: "local-model", name: "本地模型" }]; break;
      case "save_resource":
        resource = { ...resource, ...params, revision: resource.revision + 1 }; result = resource; break;
      default: throw new Error(`Unexpected API call: ${method}`);
    }
    await route.fulfill({ json: result });
  });
  const open = async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "工作流", exact: true }).click();
    await page.getByRole("button", { name: /画布验收/ }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(graph.nodes.length);
  };
  await open();
  return { open, saved: () => resource.draft as unknown as Graph };
}

async function drag(page: Page, source: Locator, target: Locator) {
  const from = await source.boundingBox(); const to = await target.boundingBox();
  if (!from || !to) throw new Error("Missing drag target");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
}

test("drag ports, delete edges, undo, save and reopen without the inspector", async ({ page }) => {
  const state = await fixture(page, { ...defaultGraph, edges: [] });
  await drag(page, page.getByLabel("开始 输出端口"), page.getByLabel("文本处理 输入端口"));
  await drag(page, page.getByLabel("文本处理 输出端口"), page.getByLabel("结束 输入端口"));
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.locator(".node-inspector")).toHaveCount(0);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(state.saved().edges).toEqual(defaultGraph.edges);
  await state.open();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  const middle = await page.locator(".react-flow__edge-interaction").first().evaluate((element) => {
    const path = element as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(middle.x, middle.y);
  await page.getByRole("button", { name: "删除所选" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await page.getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
});

test("separate true and false ports persist; cycles cannot be created", async ({ page }) => {
  const graph: Graph = { ...defaultGraph, edges: [], nodes: defaultGraph.nodes.map((node) =>
    node.id === "answer"
      ? { ...node, type: "condition", name: "条件", left: "x", right: "y", operator: "equal" } : node) };
  const state = await fixture(page, graph);
  await drag(page, page.getByLabel("开始 输出端口"), page.getByLabel("条件 输入端口"));
  await drag(page, page.getByLabel("条件 条件成立端口"), page.getByLabel("结束 输入端口"));
  await drag(page, page.getByLabel("条件 条件不成立端口"), page.getByLabel("结束 输入端口"));
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await drag(page, page.getByLabel("条件 条件成立端口"), page.getByLabel("条件 输入端口"));
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(state.saved().edges.filter((edge) => edge.source === "answer").map((edge) => edge.port).sort())
    .toEqual([false, true]);
});

test("node drag is one undo step; palette, inspector, zoom and full-height layout", async ({ page }) => {
  const state = await fixture(page);
  const node = page.locator('.react-flow__node[data-id="answer"] header');
  const bounds = await node.boundingBox();
  if (!bounds) throw new Error("Node missing");
  await page.mouse.move(bounds.x + 40, bounds.y + 20); await page.mouse.down();
  await page.mouse.move(bounds.x + 100, bounds.y + 170, { steps: 20 }); await page.mouse.up();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(state.saved().nodes.find((item) => item.id === "answer")?.y).toBeGreaterThan(70);
  await page.getByRole("button", { name: "撤销 (Ctrl+Z)", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(state.saved().nodes).toEqual(defaultGraph.nodes);
  await page.getByRole("button", { name: "添加节点", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索节点" }).fill("知识");
  await page.getByRole("button", { name: "知识检索", exact: true }).click();
  await expect(page.locator(".node-inspector")).toContainText("知识库");
  await page.getByRole("button", { name: "关闭节点配置" }).click();
  await expect(page.locator(".node-inspector")).toHaveCount(0);
  await page.getByRole("button", { name: "放大", exact: true }).click();
  await page.getByRole("button", { name: "适应画布", exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 680 });
  const layout = await page.evaluate(() => ({ height: document.documentElement.scrollHeight,
    viewport: innerHeight, canvas: document.querySelector(".workflow-canvas")?.getBoundingClientRect().height }));
  expect(layout.height).toBeLessThanOrEqual(layout.viewport);
  expect(layout.canvas).toBeGreaterThan(450);
});

test("reconnect an edge by dragging its endpoint and undo the change", async ({ page }) => {
  const state = await fixture(page);
  const edge = page.locator(".react-flow__edge").first();
  await drag(page, edge.locator(".react-flow__edgeupdater-target"), page.getByLabel("结束 输入端口"));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(state.saved().edges).toContainEqual({ source: "start", target: "end" });
  expect(state.saved().edges).not.toContainEqual({ source: "start", target: "answer" });
  await page.getByLabel("工作流画布", { exact: true }).focus();
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(state.saved().edges).toEqual(defaultGraph.edges);
});

test("keyboard moves persist and input deletion does not delete a node", async ({ page }) => {
  const state = await fixture(page);
  const node = page.locator('.react-flow__node[data-id="answer"]');
  await node.click(); await node.focus(); await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect(state.saved().nodes.find((item) => item.id === "answer")?.x).toBe(305);
  const name = page.locator(".node-inspector").getByRole("textbox").first();
  await name.fill("新名称"); await name.press("Backspace");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
});
