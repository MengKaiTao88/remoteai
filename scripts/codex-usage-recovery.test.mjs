import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { composerUsageOverlay } from "./fixtures/usage-statusline-source.mjs";
import { testBrowserLaunchOptions } from "./test-browser.mjs";

const root = new URL("../apps/desktop/src-tauri/src/dream_skin_native/", import.meta.url);
const [sync, queryClient, status] = await Promise.all([
  "renderer_sync.rs", "composer_query_client.js", "composer_status.js",
].map(path => readFile(new URL(path, root), "utf8")));
const substitutions = {
  query_client: queryClient,
  overlay: composerUsageOverlay,
  status,
};
const template = sync.match(/r#"(\(\(\) => \{\{[\s\S]*?\}\}\)\(\))"#/)[1];
const restore = (proxyRunning = true) => template.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (token, key) => {
  if (token === "{{") return "{";
  if (token === "}}") return "}";
  if (key === "proxy_running") return String(proxyRunning);
  assert.ok(Object.hasOwn(substitutions, key));
  return substitutions[key];
});
let browser;
before(async () => { browser = await chromium.launch(testBrowserLaunchOptions({ headless: true })); });
after(async () => { await browser?.close(); });

async function loadComposer(page, options = {}) {
  await page.setContent(`<section data-composer-surface-variant="default">
    <div contenteditable="true" aria-label="Message"></div>
    <div><div><div><button data-composer-navigation-target="reasoning">Model</button></div></div></div></section>`);
  await page.evaluate(({ authMethod = "no-auth", provider, host = "local", active = true, effectiveProvider }) => {
    window.subscriptions = new Set();
    const query = { queryKey: ["models", "list", host, authMethod, 100, provider], isActive: () => active };
    window.modelQuery = query;
    window.configQuery = effectiveProvider && {
      queryKey: ["config", "effective", "local"], isActive: () => true,
      state: { data: { config: { model_provider: effectiveProvider } } },
    };
    const cache = {
      getAll: () => window.configQuery ? [query, window.configQuery] : [query],
      subscribe: listener => {
        window.subscriptions.add(listener);
        return () => window.subscriptions.delete(listener);
      },
    };
    const client = { getQueryCache: () => cache, invalidateQueries() {}, setQueryData() {} };
    window.__codexRoot = { _internalRoot: { current: { memoizedProps: { client } } } };
    window.__CODEX_SWITCH_FAST_MODE_AVAILABLE__ = true;
    window.summary = { enabled: true, totalTokens: 4790000, estimatedCostUsd: 12, primaryRemainingPercent: 90 };
    window.usageRequests = 0;
    window.codexSwitchRequestUsageSummary = () => {
      window.usageRequests += 1;
      if (window.summary) window.__CODEX_SWITCH_SPEED_SELECTOR__?.updateUsage(window.summary);
    };
  }, options);
}

test("restores a missing composer on reattachment and reload without a model refresh", async () => {
  const page = await browser.newPage();
  try {
    for (let reload = 0; reload < 2; reload += 1) {
      await page.goto("about:blank");
      await loadComposer(page);
      await page.locator("[contenteditable]").fill("Keep this draft");
      assert.equal(await page.evaluate(restore()), true);
      await expect(page.locator("[data-today-tokens]")).toHaveText("4.79M");
      await expect(page.locator("[data-trailing-balance]")).toHaveText("90%");
      await page.evaluate(restore());
      await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(1);
      assert.equal(await page.evaluate(() => window.subscriptions.size), 1);
      await expect(page.locator("[contenteditable]")).toHaveText("Keep this draft");
      await expect(page.locator("[data-speed-controls]")).toBeVisible();
    }
  } finally {
    await page.close();
  }
});

test("logged-in proxy usage survives reattachment and reload without duplicate speed controls", async () => {
  const page = await browser.newPage();
  try {
    for (let reload = 0; reload < 2; reload += 1) {
      await page.goto("about:blank");
      await loadComposer(page, { authMethod: "chatgpt", provider: "codex-switch-local" });
      for (let attachment = 0; attachment < 2; attachment += 1) {
        assert.equal(await page.evaluate(restore()), true);
        await expect(page.locator("[data-today-tokens]")).toHaveText("4.79M");
        await expect(page.locator("[data-trailing-balance]")).toHaveText("90%");
        await expect(page.locator("[data-speed-controls]")).toBeHidden();
        await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(1);
        assert.equal(await page.evaluate(() => window.subscriptions.size), 1);
      }
    }
  } finally { await page.close(); }
});

test("checks the effective provider when the updated Codex lists ChatGPT models", async () => {
  const page = await browser.newPage();
  try {
    await loadComposer(page, { authMethod: "chatgpt", effectiveProvider: "codex-switch-local" });
    assert.equal(await page.evaluate(restore()), true);
    await expect(page.locator("[data-codex-switch-usage-statusline]")).toBeVisible();
    await expect(page.locator("[data-speed-controls]")).toBeHidden();
    await page.evaluate(() => {
      window.configQuery.state.data.config.model_provider = "openai";
      for (const notify of window.subscriptions) notify({ query: window.configQuery });
    });
    await expect(page.locator("[data-codex-switch-usage-statusline]")).toHaveCount(0);
  } finally { await page.close(); }
});

test("typing stays responsive during an unanswered refresh and stale data recovers", async () => {
  const page = await browser.newPage();
  try {
    await page.clock.install();
    await loadComposer(page, { authMethod: "chatgpt", provider: "codex-switch-local" });
    await page.evaluate(restore());
    await page.clock.runFor(1);
    await expect(page.locator("[data-today-tokens]")).toHaveText("4.79M");
    await page.evaluate(() => { window.summary = null; });
    await page.clock.fastForward(35000);
    await expect(page.locator("[data-today-cost]")).toHaveText("待更新");
    await expect(page.locator("[data-trailing-balance]")).toBeHidden();
    await page.locator("[contenteditable]").fill("Typing while synchronization is pending");
    await page.evaluate(() => {
      window.summary = { enabled: true, totalTokens: 5000000, estimatedCostUsd: 13, primaryRemainingPercent: 89 };
      window.__CODEX_SWITCH_SPEED_SELECTOR__.completeUsageRequest();
      window.__CODEX_SWITCH_SPEED_SELECTOR__.requestUsage();
    });
    await expect(page.locator("[data-today-tokens]")).toHaveText("5M");
    await expect(page.locator("[data-trailing-balance]")).toHaveText("89%");
    await expect(page.locator("[contenteditable]")).toHaveText("Typing while synchronization is pending");
  } finally {
    await page.close();
  }
});

test("reattachment and reload never install proxy statistics outside proxy mode", async () => {
  const page = await browser.newPage();
  try {
    const scenarios = [
      { proxyRunning: false, authMethod: "chatgpt", provider: "codex-switch-local" },
      { proxyRunning: false, authMethod: "no-auth" },
      { authMethod: "chatgpt" },
      { authMethod: "chatgpt", provider: "other-provider" },
      { authMethod: "chatgpt", provider: "codex-switch-local", host: "remote" },
      { authMethod: "chatgpt", provider: "codex-switch-local", active: false },
    ];
    for (const { proxyRunning = true, ...options } of scenarios) {
      await page.goto("about:blank");
      await page.clock.install();
      await loadComposer(page, options);
      for (let attachment = 0; attachment < 2; attachment += 1) {
        assert.equal(await page.evaluate(restore(proxyRunning)), true);
        await page.clock.runFor(10000);
        await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(0);
        assert.equal(await page.evaluate(() => window.usageRequests), 0);
        assert.equal(await page.evaluate(() => window.subscriptions.size), 1);
      }
    }
  } finally { await page.close(); }
});

test("stopping the proxy removes pending statistics and restart restores one responsive overlay", async () => {
  const page = await browser.newPage();
  try {
    await page.clock.install();
    await loadComposer(page, { authMethod: "chatgpt", provider: "codex-switch-local" });
    await page.evaluate(restore());
    await page.clock.runFor(1);
    await expect(page.locator("[data-today-tokens]")).toHaveText("4.79M");
    await page.evaluate(() => {
      window.previousOverlay = window.__CODEX_SWITCH_SPEED_SELECTOR__;
      window.summary = null;
      window.previousOverlay.requestUsage();
    });
    await page.evaluate(restore(false));
    const requests = await page.evaluate(() => window.usageRequests);
    await page.evaluate(() => window.previousOverlay.updateUsage({
      enabled: true, totalTokens: 5000000, estimatedCostUsd: 13, primaryRemainingPercent: 89,
    }));
    await page.clock.runFor(30000);
    await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.usageRequests), requests);
    await page.locator("[contenteditable]").fill("Draft survives proxy changes");
    await page.evaluate(() => {
      window.summary = { enabled: true, totalTokens: 5000000, estimatedCostUsd: 13 };
    });
    await page.evaluate(restore());
    await page.clock.runFor(1);
    await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(1);
    await expect(page.locator("[data-today-tokens]")).toHaveText("5M");
    await expect(page.locator("[contenteditable]")).toHaveText("Draft survives proxy changes");
  } finally { await page.close(); }
});

test("logged-in provider changes update usage visibility immediately", async () => {
  const page = await browser.newPage();
  try {
    await page.clock.install();
    await loadComposer(page, { authMethod: "chatgpt", provider: "codex-switch-local" });
    await page.evaluate(restore());
    await expect(page.locator("[data-today-usage]")).toBeVisible();
    await page.evaluate(() => {
      window.modelQuery.queryKey[5] = "other-provider";
      for (const listener of window.subscriptions) listener({ query: window.modelQuery });
    });
    await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(0);
    const requests = await page.evaluate(() => window.usageRequests);
    await page.clock.runFor(10000);
    assert.equal(await page.evaluate(() => window.usageRequests), requests);
    await page.evaluate(() => {
      window.modelQuery.queryKey[5] = "codex-switch-local";
      for (const listener of window.subscriptions) listener({ query: window.modelQuery });
    });
    await expect(page.locator("[data-today-tokens]")).toHaveText("4.79M");
    await expect(page.locator("[data-speed-controls]")).toBeHidden();
    await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(1);
  } finally { await page.close(); }
});

test("login changes retain local proxy usage while updating speed controls", async () => {
  const page = await browser.newPage();
  try {
    await loadComposer(page, { provider: "codex-switch-local" });
    await page.evaluate(restore());
    for (const authMethod of ["chatgpt", "no-auth"]) {
      await page.evaluate(authMethod => {
        window.modelQuery.queryKey[3] = authMethod;
        for (const listener of window.subscriptions) listener({ query: window.modelQuery });
      }, authMethod);
      await expect(page.locator("[data-today-tokens]")).toHaveText("4.79M");
      await expect(page.locator("[data-speed-controls]")).toBeVisible({ visible: authMethod === "no-auth" });
      await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(1);
    }
  } finally { await page.close(); }
});

test("switching to ChatGPT login removes usage without waiting for another model refresh", async () => {
  const page = await browser.newPage();
  try {
    await page.clock.install();
    await loadComposer(page);
    await page.evaluate(restore());
    await page.clock.runFor(1);
    await expect(page.locator("[data-today-usage]")).toBeVisible();
    await page.evaluate(() => {
      window.modelQuery.queryKey[3] = "chatgpt";
      for (const listener of window.subscriptions) listener({ query: window.modelQuery });
    });
    const requests = await page.evaluate(() => window.usageRequests);
    await page.clock.runFor(10000);
    await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.usageRequests), requests);
    await page.evaluate(() => {
      window.modelQuery.queryKey[3] = "no-auth";
      for (const listener of window.subscriptions) listener({ query: window.modelQuery });
    });
    await page.clock.runFor(1);
    await expect(page.locator("[data-today-usage]")).toBeVisible();
    await expect(page.locator("[data-codex-switch-speed-selector]")).toHaveCount(1);
  } finally { await page.close(); }
});
