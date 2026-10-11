import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// Supply output from the ignored Rust fixture test to verify the exact decoder output in a browser.
const fixturePath = process.env.CODEX_IMAGE_PREVIEW_OUTPUT;
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lE'
  + 'QVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('previews local images and loads original bytes only on demand', async ({ page }, info) => {
  const fixture: { thumbnail: string; original: string } = fixturePath
    ? JSON.parse(await readFile(fixturePath, 'utf8')) : { thumbnail: pixel, original: pixel };
  const requests: string[] = [];
  await page.route('**/__image-fixture/*', async route => {
    const variant = new URL(route.request().url()).pathname.split('/').pop();
    requests.push(variant!);
    await route.fulfill({ json: { url: variant === 'original' ? fixture.original : fixture.thumbnail } });
  });
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.addInitScript(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
      invoke: (command: string, args: { request: { variant: string } }) => {
        if (command !== 'codex_gui_attachment_preview') throw new Error(`Unexpected command: ${command}`);
        return fetch(`/__image-fixture/${args.request.variant}`).then(response => response.json());
      },
    } });
  });
  await page.goto('/e2e/local-image-preview-harness.html');
  const thumbnail = page.getByRole('img', { name: 'large.jpg', exact: true });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(requests).toEqual(['thumbnail']);
  await page.getByRole('textbox', { name: '消息' }).fill('大图预览时仍可编辑消息');
  await page.screenshot({ path: info.outputPath('local-image-thumbnail.png') });
  await page.getByRole('button', { name: '放大查看：large.jpg' }).click();
  expect(requests).toEqual(['thumbnail']);
  await page.getByRole('button', { name: '查看原图', exact: true }).click();
  const original = page.locator('dialog img');
  await expect.poll(() => original.evaluate((image: HTMLImageElement) => image.src.length))
    .toBe(fixture.original.length);
  await expect.poll(() => original.evaluate((image: HTMLImageElement) => image.currentSrc === image.src
    && image.complete && image.naturalWidth > 0)).toBe(true);
  expect(requests).toEqual(['thumbnail', 'original']);
  if (fixturePath) {
    expect(fixture.original.length).toBeGreaterThan(20 * 1024 * 1024 * 4 / 3);
  }
  await page.screenshot({ path: info.outputPath('local-image-original.png') });
  await page.getByRole('button', { name: '关闭图片', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息' })).toHaveValue('大图预览时仍可编辑消息');
  await page.getByRole('button', { name: '移除附件：large.jpg', exact: true }).click();
  await expect(thumbnail).toHaveCount(0);
});
