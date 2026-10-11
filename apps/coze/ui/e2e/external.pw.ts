import { expect, test } from "@playwright/test";
import type { Resource } from "../src/types";

test("publishes external keys with local/network settings and MCP/API examples", async ({ page }) => {
  const resource: Resource = { id: "external-test", name: "库存查询", kind: "prompt", description: "",
    draft: { text: "查询" }, revision: 1, publishedRevision: 1, mcpEnabled: true, updatedAt: "" };
  let settings = { enabled: false, mode: "local", port: 15461 };
  let revoked = false;
  let issued = false;
  await page.route("**/api", async (route) => {
    const { method, params } = route.request().postDataJSON();
    let result: unknown;
    switch (method) {
      case "access_info": result = { role: "owner" }; break;
      case "list_resources": result = [resource]; break;
      case "releases": result = []; break;
      case "tool_service_status": result = { settings, urls: [] }; break;
      case "configure_tool_service":
        settings = params;
        result = { settings, urls: settings.enabled ? ["http://127.0.0.1:15461", "http://192.168.1.5:15461"] : [] };
        break;
      case "list_access": result = issued ? [{ id: "key", name: "测试客户端", role: "tool",
        expiresAt: "2099-01-01", revokedAt: revoked ? "2026-10-11" : null }] : []; break;
      case "issue_access":
        expect(params).toEqual({ appId: resource.id, name: "测试客户端", role: "tool", expiresDays: 30 });
        issued = true; result = { id: "key", token: "test-key-only" }; break;
      case "revoke_access": revoked = true; result = {}; break;
      default: throw new Error(`Unexpected API call: ${method}`);
    }
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "提示词", exact: true }).click();
  await page.getByRole("button", { name: /库存查询/ }).click();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByText("#库存查询", { exact: true })).toBeVisible();
  await page.locator('.ant-select[aria-label="连接范围"]').click();
  await page.getByText("允许其他电脑", { exact: true }).last().click();
  await page.getByRole("button", { name: "开启外部调用" }).click();
  expect(settings.mode).toBe("network");
  await page.getByLabel("密钥用途").fill("测试客户端");
  await page.getByRole("button", { name: "创建密钥" }).click();
  await expect(page.getByText("密钥仅显示这一次，请复制保存。")).toBeVisible();
  await expect(page.locator('textarea[readonly]:visible')).toHaveValue(/Bearer test-key-only/);
  await page.getByRole("tab", { name: "HTTP API", exact: true }).click();
  await expect(page.locator('textarea[readonly]:visible')).toHaveValue(/POST http:\/\/127\.0\.0\.1:15461\/api\/run/);
  await page.getByRole("button", { name: /^停\s*用$/ }).click();
  await expect(page.getByText("密钥仅显示这一次，请复制保存。")).toHaveCount(0);
  await expect(page.locator('textarea[readonly]:visible')).toHaveValue(/YOUR_TOOL_KEY/);
  await page.getByRole("button", { name: "关闭外部调用" }).click();
  await page.getByRole("button", { name: /^确\s*定$/ }).click();
  await expect(page.getByRole("button", { name: "开启外部调用" })).toBeVisible();
  expect(settings.enabled).toBe(false);
});
