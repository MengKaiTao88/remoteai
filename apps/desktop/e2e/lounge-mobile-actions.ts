import { expect, type Page } from '@playwright/test';

/** Mobile uses the composer menu; desktop contact actions use the selected row's menu. */
async function loungeAction(page: Page, name: string) {
  if (await page.locator('.lounge-mobile').count()) {
    await page.getByRole('button', { name: '添加内容', exact: true }).click();
  } else if (name === '屏蔽此人' || name === '取消屏蔽') {
    await page.locator('.lounge-person.is-selected').click({ button: 'right' });
    return page.getByRole('menuitem', { name, exact: true });
  }
  return page.getByRole('button', { name, exact: true });
}

export async function openLoungeAction(page: Page, name: string) {
  await (await loungeAction(page, name)).click();
}

export async function expectLoungeAction(page: Page, name: string) {
  const mobile = await page.locator('.lounge-mobile').count();
  await expect(await loungeAction(page, name)).toBeVisible();
  if (mobile) await page.locator('.ant-drawer-close:visible').click();
  else await page.keyboard.press('Escape');
}

export async function expectLoungePresence(page: Page, label: string) {
  if (await page.locator('.lounge-mobile').count()) {
    await expect(page.locator('.lounge-peer-status')).toHaveText(label);
    return;
  }
  const dot = page.locator('.lounge-peer-presence');
  await expect(dot).toHaveAccessibleName(label);
  const color = label === '在线' ? 'rgb(34, 197, 94)' : 'rgb(239, 68, 68)';
  await expect(dot).toHaveCSS('background-color', color);
  await expect(page.locator('.lounge-person.is-selected .lounge-avatar-presence'))
    .toHaveCSS('background-color', color);
  await expect(page.locator('.lounge-peer-status, .lounge-block-button')).toHaveCount(0);
}
