import { expect, test, type Page } from '@playwright/test';

test('keeps chat usable after service takeover and recovers from incomplete accounts', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The avatar menu belongs to the mobile layout');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let response: unknown = { accounts: [], providers: [], selection: null };
  await page.route('**/accounts-fixture.json', route => route.fulfill({ json: response }));
  await page.goto('/web/e2e/chat-accounts-harness.html');
  await page.getByRole('button', { name: '打开聊天列表' }).click();
  await expect(page.getByRole('button', { name: '保留的聊天' })).toBeVisible();
  await page.getByRole('button', { name: '打开头像菜单' }).click();
  await page.getByRole('button', { name: '切换账户' }).click();
  await expect(page.getByText('电脑上的聊天暂不可用，请在电脑上重新打开 Remote AI。')).toBeVisible();
  await expect(page.getByText('暂无可选账户，请先在电脑上添加账户。')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('unavailable-accounts.png'), animations: 'disabled' });
  response = { running: true };
  await page.reload();
  await page.getByRole('button', { name: '打开聊天列表' }).click();
  await page.getByRole('button', { name: '打开头像菜单' }).click();
  await page.getByRole('button', { name: '切换账户' }).click();
  await expect(page.getByRole('alert')).toHaveText('暂时无法读取电脑的账户，请重试。');
  const bounds = await page.getByRole('alert').boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(400);
  response = { running: true, selection: { kind: 'account', id: 'restored' }, choices: [
    { kind: 'account', id: 'restored', name: '恢复的账户', detail: '可继续聊天', available: true },
  ] };
  await page.getByRole('button', { name: '重试读取账户' }).click();
  await expect(page.getByRole('button', { name: '恢复的账户', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function mockAccounts(page: Page) {
  let selection = { kind: 'account', id: 'first' };
  const choices = [
    { kind: 'account', id: 'first', name: 'first@example.test', detail: 'pro', plan: 'pro',
      primaryRemainingPercent: 66, secondaryRemainingPercent: null, available: true },
    { kind: 'account', id: 'second', name: 'second@example.test', detail: 'free', plan: 'free',
      primaryRemainingPercent: 0, secondaryRemainingPercent: 100, available: true },
    { kind: 'provider', id: 'provider', name: 'Codex Switch-local', detail: 'gpt-6-astra', available: true },
    { kind: 'aggregate', id: 'aggregate', name: 'Aggregate', detail: 'gpt-6', available: true },
  ];
  await page.route('**/accounts-fixture.json', route => route.fulfill({
    json: { running: true, selection, choices },
  }));
  await page.route('**/account-selection.json', route => {
    selection = route.request().postDataJSON();
    return route.fulfill({ json: selection });
  });
  return () => selection;
}

async function expectAccountAppearance(page: Page) {
  const popup = page.locator('.ant-popover:visible').first();
  const trigger = page.getByRole('button', { name: /^切换 GUI 账户：/ });
  const accounts = page.getByRole('region', { name: '账户列表' });
  await expect(accounts.getByRole('button', { pressed: true })).toContainText('first@example.test');
  await expect(accounts.getByLabel('主用量剩余 0%', { exact: true })).toBeVisible();
  await expect(accounts.getByLabel('次用量剩余 —', { exact: true })).toBeVisible();
  for (const row of await accounts.getByRole('button').all()) {
    await expect(row).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(row.getByRole('img', { name: /官方账号|第三方 Provider/ }))
      .not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  expect((await popup.boundingBox())!.width).toBeLessThanOrEqual(280);
  await expect.poll(async () => Math.abs((await popup.boundingBox())!.x - (await trigger.boundingBox())!.x))
    .toBeLessThan(1);
}

for (const mode of ['web', 'remote']) test(`${mode} desktop opens the shared account and device popup`,
  async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop', 'The account popup belongs to the desktop layout');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const selection = await mockAccounts(page);
    await page.goto(`/web/e2e/chat-accounts-harness.html${mode === 'remote' ? '?remote' : ''}`);
    await page.getByRole('button', { name: '打开聊天列表' }).click();
    const trigger = page.getByRole('button', { name: /^切换 GUI 账户：/ });
    await expect(trigger.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '66');
    await trigger.click();
    await expect(page.locator('.provider-market-button')).toHaveCount(0);
    const accounts = page.getByRole('region', { name: '账户列表' });
    await expectAccountAppearance(page);
    await page.screenshot({ path: info.outputPath(`${mode}-account-popup.png`), animations: 'disabled' });
    const search = page.getByRole('textbox', { name: '搜索账号或 Provider' });
    await search.fill('gpt-6-astra');
    await expect(accounts.getByRole('button')).toHaveCount(1);
    await accounts.getByRole('button', { name: /Codex Switch-local/ }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toContainText('Codex Switch-local');
    await expect(trigger).toBeFocused();
    expect(selection()).toEqual({ kind: 'provider', id: 'provider' });
    await trigger.click();
    await expect(accounts.getByRole('button')).toHaveCount(4);
    await page.getByRole('button', { name: '切换设备', exact: true }).click();
    const computers = page.getByRole('region', { name: '设备列表' });
    await expect(computers.getByRole('button', { name: '本机', exact: true })).toHaveCount(mode === 'web' ? 0 : 1);
    await expect(computers.getByRole('button', { name: /离线电脑/ })).toBeDisabled();
    await expect(page.getByLabel('设备刷新次数')).toHaveText('1');
    await computers.getByRole('button', { name: /家用电脑/ }).click({ trial: true });
    await page.screenshot({ path: info.outputPath(`${mode}-device-popup.png`), animations: 'disabled' });
    await computers.getByRole('button', { name: /家用电脑/ }).click();
    await expect(page.getByLabel('当前设备')).toHaveText('home');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await search.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    if (mode === 'web') {
      await page.setViewportSize({ width: 860, height: 844 });
      await expect(page.getByRole('button', { name: '打开头像菜单' })).toBeVisible();
      await expect(trigger).toHaveCount(0);
      await page.setViewportSize({ width: 861, height: 844 });
      await expect(trigger).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
