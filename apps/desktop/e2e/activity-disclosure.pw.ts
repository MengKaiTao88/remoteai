import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('expands the process, grouped operations and output in place without hiding replies', async ({ page }, info) => {
  const local = info.project.name === 'desktop-local';
  const mode = local ? 'local' : info.project.name === 'desktop-remote' ? 'remote' : 'web';
  const origin = mode === 'web' ? 'http://127.0.0.1:1490/web/e2e/' : '';
  const directory = resolve('../../.artifacts/activity-disclosure');
  mkdirSync(directory, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  const capture = (state: string) => page.screenshot({
    path: resolve(directory, `${info.project.name}-${state}.png`), animations: 'disabled' });
  const process = local ? page.locator('details > summary').first() : page.locator('.chat-work-summary button').first();
  const group = local ? page.locator('[data-activity-group] > details > summary').first()
    : page.locator('.chat-entry-activities .chat-inline-activity > button').first();
  const list = local ? page.locator('[data-activity-group] > details > div').first() : page.locator('.chat-activity-list').first();
  const output = page.locator('.cs-command-output, .chat-virtual-command:not(.is-command)').first();
  let defaultSize = 0;
  for (const enlarged of [false, true]) {
    if (enlarged) await page.setViewportSize({ width: mode === 'web' ? 320 : 920, height: 900 });
    await page.goto(`${origin}activity-disclosure-harness.html?mode=${mode}${enlarged ? '&dark&font=20' : ''}`);
    await expect(process).toContainText('用时');
    const size = await process.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    if (enlarged) expect(size).toBeGreaterThan(defaultSize);
    else defaultSize = size;
    await expect(page.getByText('检查完成。命令、文件修改和工具输出都可以逐级展开，正文保持清晰。')).toBeVisible();
    await expect(page.getByText('我会先读取项目文件，再检查修改和测试结果。')).toHaveCount(0);
    await capture(enlarged ? 'dark-font20-collapsed' : 'light-collapsed');
    await process.click();
    await expect(group).toContainText('修改文件（1） · 运行命令（15）');
    await expect(page.getByText('我会先读取项目文件，再检查修改和测试结果。')).toBeVisible();
    await group.click();
    await expect(list).toBeVisible();
    expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    await capture(enlarged ? 'dark-font20-operations' : 'light-operations');
    const first = local ? list.locator('summary').first() : list.locator('.chat-activity').first();
    await first.click();
    await expect(output).toContainText('PASS: test-0');
    await capture(enlarged ? 'dark-font20-output' : 'light-output');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await first.click();
    await expect(output).toHaveCount(0);
    await group.click();
    await expect(list).toHaveCount(0);
    await process.click();
    await expect(group).toHaveCount(0);
  }
  await page.goto(`${origin}activity-disclosure-harness.html?mode=${mode}&running`);
  await expect(group).toBeVisible();
  await group.click();
  await expect(list).toBeVisible();
  const first = local ? list.locator('summary').first() : list.locator('.chat-activity').first();
  await first.click();
  await capture('running-inspected');
  await page.evaluate(() => window.dispatchEvent(new Event('activity-disclosure-complete')));
  await expect(output).toContainText('PASS: test-0');
  await expect(page.getByText('检查完成。命令、文件修改和工具输出都可以逐级展开，正文保持清晰。')).toBeVisible();
  await capture('completed-inspected');
  expect(errors).toEqual([]);
});
