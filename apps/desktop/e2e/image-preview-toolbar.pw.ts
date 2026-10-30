import { expect, test, type Page } from '@playwright/test';

async function openPreview(page: Page, mode: string, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.goto(`/e2e/image-viewer-drag-harness.html?mode=${mode}`);
  await page.getByRole('button', { name: '放大查看：拖动测试', exact: true }).click();
  await expect(page.locator('.cs-image-stage img')).toBeVisible();
}

for (const mode of ['local', 'remote', 'web']) {
  test(`${mode}: combines view controls after resize without resetting the editor`, async ({ page }, info) => {
    await openPreview(page, mode);
    const controls = page.locator('.cs-image-ai-tools .cs-image-toolbar');
    await expect(controls).toBeVisible();
    await expect(page.locator('.cs-image-viewer > .cs-image-toolbar')).toHaveCount(0);
    await expect(page.locator('.cs-image-ai-separator')).toHaveCSS('width', '1px');
    const resize = page.getByRole('button', { name: '调整大小', exact: true });
    const resizeBox = await resize.boundingBox();
    const controlsBox = await controls.boundingBox();
    expect(controlsBox!.x).toBeGreaterThan(resizeBox!.x + resizeBox!.width);
    expect(Math.abs(controlsBox!.y - resizeBox!.y)).toBeLessThan(2);
    await page.getByRole('button', { name: '缩小图片', exact: true }).click({ clickCount: 2 });
    await expect(page.getByRole('button', { name: '还原图片', exact: true })).toHaveText('50%');
    await page.screenshot({ path: info.outputPath(`${mode}-combined.png`) });
    await resize.click();
    await page.getByLabel('宽度（像素）').fill('1200');
    await page.getByRole('button', { name: '放大图片', exact: true }).click();
    await page.getByRole('button', { name: '旋转图片', exact: true }).click();
    await expect(page.getByLabel('宽度（像素）')).toHaveValue('1200');
    await expect(page.locator('.cs-image-stage img')).toHaveAttribute('style', /rotate\(90deg\)/);
    await page.screenshot({ path: info.outputPath(`${mode}-resize-rotate.png`) });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '还原图片', exact: true }).click();
    await expect(page.locator('.cs-image-stage img')).toHaveAttribute('style', /rotate\(0deg\) scale\(1\)/);
  });

  test(`${mode}: all combined controls remain reachable in a narrow window`, async ({ page }, info) => {
    const width = mode === 'web' ? 870 : 780;
    await openPreview(page, mode, width);
    const toolbar = page.locator('.cs-image-ai-tools');
    const box = await toolbar.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.getByRole('button', { name: '旋转图片', exact: true }).click();
    await expect(page.locator('.cs-image-stage img')).toHaveAttribute('style', /rotate\(90deg\)/);
    await page.screenshot({ path: info.outputPath(`${mode}-narrow.png`) });
  });
}

test('mobile Codex chat retains its existing preview layout', async ({ page }, info) => {
  await openPreview(page, 'web', 390);
  await expect(page.locator('.cs-image-viewer > .cs-image-toolbar')).toBeVisible();
  await expect(page.locator('.cs-image-ai-tools .cs-image-toolbar')).toHaveCount(0);
  await expect(page.locator('.cs-image-ai-separator')).toHaveCount(0);
  await page.getByRole('button', { name: '缩小图片', exact: true }).click({ clickCount: 2 });
  await expect(page.getByRole('button', { name: '还原图片', exact: true })).toHaveText('50%');
  await page.screenshot({ path: info.outputPath('mobile-chat-unchanged.png') });
});

test('Codex GUI keeps standalone controls when editing is unavailable', async ({ page }) => {
  await openPreview(page, 'local&no-editor');
  await expect(page.locator('.cs-image-ai-tools')).toHaveCount(0);
  await expect(page.locator('.cs-image-viewer > .cs-image-toolbar')).toBeVisible();
  await page.getByRole('button', { name: '放大图片', exact: true }).click();
  await expect(page.getByRole('button', { name: '还原图片', exact: true })).toHaveText('150%');
});
