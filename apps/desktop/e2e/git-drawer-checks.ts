import { expect, type Page } from '@playwright/test';

export async function checkInternalGitDrawer(page: Page) {
  const drawer = page.getByRole('dialog', { name: 'Git', exact: true });
  const host = drawer.locator('xpath=ancestor::*[@data-workspace-drawers][1]');
  const bounds = (await host.boundingBox())!;
  const panel = (await drawer.boundingBox())!;
  expect(panel.y).toBe(bounds.y);
  expect(panel.height).toBe(bounds.height);
  expect(panel.width).toBeCloseTo(Math.min(800, page.viewportSize()!.width * .8), 0);
  await expect(page.locator('.chat-git-drawer .ant-drawer-mask')).toHaveCount(0);
  const grip = drawer.getByRole('separator', { name: '调整 Git 抽屉宽度' });
  const handle = (await grip.boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + 100);
  await page.mouse.up();
  expect((await drawer.boundingBox())!.width).toBeCloseTo(panel.width - 100, 0);
  await grip.press('ArrowLeft');
  expect((await drawer.boundingBox())!.width).toBeCloseTo(panel.width - 76, 0);
  await grip.dblclick();
  expect((await drawer.boundingBox())!.width).toBeCloseTo(panel.width, 0);
  const message = drawer.getByRole('textbox', { name: '提交说明' });
  await message.fill('保留草稿');
  await drawer.getByRole('button', { name: '最小化 Git', exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: '恢复 Git', exact: true }).click();
  await expect(message).toHaveValue('保留草稿');
  await message.fill('');
}
