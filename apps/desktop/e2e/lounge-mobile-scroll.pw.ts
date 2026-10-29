import { expect, test, type Locator } from '@playwright/test';
import { setupLounge } from './lounge-support';

async function leaveBelow(list: Locator, distance: number) {
  await list.evaluate((node, offset) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - offset;
    node.dispatchEvent(new Event('scroll'));
  }, distance);
  await expect.poll(() => list.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeCloseTo(distance, 0);
}

for (const [width, direct] of [[320, false], [390, false], [320, true], [390, true]] as const) {
  test(`mobile ${direct ? 'private' : 'group'} latest shortcut requires a full page at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const relay = await setupLounge(page, true);
    await page.goto('http://127.0.0.1:1486/web/'); await relay.ready();
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click();
    const receive = direct ? relay.private : relay.push;
    for (let index = 0; index < 40; index++) receive(`第 ${index + 1} 条中文消息，检查滚动和返回最新消息。`);
    const chat = direct ? '与 bob@example.test 私聊' : '群聊';
    await page.getByRole('button', { name: chat, exact: true }).click();
    const list = page.locator('.lounge-conversation');
    const latest = page.getByRole('button', { name: '回到最新消息', exact: true });
    await expect(list.locator('.lounge-message')).toHaveCount(40);
    await expect.poll(() => list.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(1);
    const height = await list.evaluate(node => node.clientHeight);
    for (const distance of [60, Math.floor(height / 2), height - 1]) {
      await leaveBelow(list, distance);
      await expect(latest).toHaveCount(0);
    }
    await page.screenshot({ path: info.outputPath('less-than-one-page.png') });
    await leaveBelow(list, height);
    await expect(latest).toBeVisible();
    await expect(latest).toHaveText('');
    await expect(page.locator('.lounge-retention')).toHaveCount(0);
    expect(await list.evaluate(node => node.clientHeight)).toBe(height);
    await page.screenshot({ path: info.outputPath('one-page-below.png') });
    await leaveBelow(list, height - 1);
    await expect(latest).toHaveCount(0);
    await leaveBelow(list, height + 20);
    const position = await list.evaluate(node => node.scrollTop);
    await page.getByRole('button', { name: '返回聊天列表', exact: true }).click();
    await page.getByRole('button', { name: chat, exact: true }).click();
    await expect(latest).toBeVisible();
    expect(await list.evaluate(node => node.scrollTop)).toBe(position);
    await latest.click();
    await expect.poll(() => list.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(1);
    await expect(latest).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('back-at-latest.png') });
  });
}

test('mobile latest shortcut remeasures incoming content and keyboard-sized viewports', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const relay = await setupLounge(page, true);
  await page.goto('http://127.0.0.1:1486/web/'); await relay.ready();
  await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
  await page.locator('.discovery-lounge').click();
  await page.getByRole('button', { name: '群聊', exact: true }).click();
  for (let index = 0; index < 30; index++) relay.push(`message-${index}`);
  const list = page.locator('.lounge-conversation');
  await expect(list.locator('.lounge-message')).toHaveCount(30);
  const latest = page.getByRole('button', { name: '回到最新消息', exact: true });
  const height = await list.evaluate(node => node.clientHeight);
  await leaveBelow(list, height - 50);
  const position = await list.evaluate(node => node.scrollTop);
  await expect(latest).toHaveCount(0);
  relay.push('新增消息后，下方内容达到一整页');
  await expect(latest).toBeVisible();
  expect(await list.evaluate(node => node.scrollTop)).toBe(position);
  await latest.click();
  await leaveBelow(list, Math.floor(height * 0.75));
  await expect(latest).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 450 });
  await expect(latest).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(latest).toHaveCount(0);
});
