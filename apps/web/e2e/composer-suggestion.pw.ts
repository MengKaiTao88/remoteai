import { test, expect, type Page } from '@playwright/test';
const suggestion = '按照这个方案开始实现，先检查现有项目结构和相关测试，然后逐步完成修改';
async function open(page: Page, options: { dark?: boolean; wait?: Promise<void> } = {}) {
  const requests: unknown[] = [];
  await page.route('**/test-suggestion', async route => {
    requests.push(route.request().postDataJSON());
    await options.wait;
    await route.fulfill({ json: { suggestion } });
  });
  await page.goto('e2e/composer-suggestion-harness.html' + (options.dark ? '?dark' : ''));
  return requests;
}
for (const dark of [false, true]) test('fills a wrapped suggestion only after acceptance: ' + dark,
  async ({ page }, info) => {
    const requests = await open(page, { dark });
    const input = page.getByRole('textbox', { name: '聊天消息' });
    const accept = page.getByRole('button', { name: '填入建议', exact: true });
    await expect(accept).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await expect(accept.locator('span')).toHaveCSS('opacity', '0.5');
    const box = (await accept.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(400); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
    await page.screenshot({ path: info.outputPath('suggestion.png') });
    if (info.project.use.hasTouch) await accept.tap();
    else { await input.focus(); await input.press('Tab'); }
    await expect(input).toHaveValue(suggestion); await expect(input).toBeFocused();
    await expect(accept).toHaveCount(0); await expect(page.getByLabel('已发送')).toHaveText('');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByLabel('已发送')).toHaveText(suggestion);
    expect(requests).toHaveLength(1);
  });
test('stays responsive during prediction and rejects the result after input', async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const requests = await open(page, { wait });
  await expect.poll(() => requests.length).toBe(1);
  const input = page.getByRole('textbox', { name: '聊天消息' });
  const beat = Number(await page.getByLabel('刷新次数').textContent());
  try {
    await input.fill('自己的草稿');
    await expect.poll(async () => Number(await page.getByLabel('刷新次数').textContent())).toBeGreaterThan(beat);
  } finally { release(); }
  await input.clear();
  await expect(page.getByRole('button', { name: '填入建议', exact: true })).toHaveCount(0);
  await input.press('Tab'); await expect(input).toHaveValue('');
});
test('dismisses on IME composition and preserves the user draft', async ({ page }) => {
  await open(page);
  const accept = page.getByRole('button', { name: '填入建议', exact: true });
  await expect(accept).toBeVisible();
  const input = page.getByRole('textbox', { name: '聊天消息' });
  await input.dispatchEvent('compositionstart', { data: '拼音' });
  await expect(accept).toHaveCount(0);
  await input.fill('我来决定下一步');
  await expect(input).toHaveValue('我来决定下一步');
  await expect(page.getByLabel('已发送')).toHaveText('');
});
