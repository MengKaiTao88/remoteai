import { test, expect, type Page } from '@playwright/test';
import { managedAttachmentBytes } from './lounge-managed-downloads';
import { pixel, setupLounge } from './lounge-support';
import { AttachmentBroker } from './lounge-attachments-support';
import type { LoungeAttachment } from '../../../shared/lounge/attachments';

async function openPrivate(page: Page, mode: string, direct = true) {
  const mobile = mode.startsWith('mobile');
  if (mobile) await page.setViewportSize({ width: mode === 'mobile-320' ? 320 : 390, height: 844 });
  const web = mode === 'web' || mobile;
  const lounge = await setupLounge(page, web);
  await page.goto(web ? 'http://127.0.0.1:1486/web/' : `/e2e/lounge-harness.html?mode=${mode}`);
  await lounge.ready();
  lounge.frame({ type: 'ready', user: { id: 'alice', account: 'alice@example.test' }, attachments: true,
    direct: true, receipts: true, blocked: [] });
  if (mobile) {
    await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
    await page.locator('.discovery-lounge').click();
  } else await page.getByRole('button', { name: '在线交流', exact: true }).click();
  if (direct) {
    lounge.private('file-thread-ready');
    await page.getByRole('button', { name: '与 bob 私聊', exact: true }).filter({ visible: true }).click();
  } else if (mobile) await page.getByRole('button', { name: '群聊', exact: true }).click();
  return lounge;
}

test('live settings update limits and image hints without reconnecting', async ({ page, context }) => {
  const broker = new AttachmentBroker(); await broker.install(context);
  const sender = await openPrivate(page, 'local');
  const fileButton = page.getByRole('button', { name: '发送文件', exact: true });
  await expect(fileButton).toHaveAttribute('title', '每个文件最大 300 MB');
  broker.updatePolicy({ loungeFileMaxMb: 1, loungeDirectImageMaxMb: 4 });
  await expect(fileButton).toHaveAttribute('title', '每个文件最大 1 MB');
  await expect(page.getByRole('button', { name: '添加图片', exact: true }))
    .toHaveAttribute('title', '支持粘贴、拖入图片；超过 4 MB 会自动压缩。');
  const upload = { name: 'policy-check.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024 + 1) };
  await page.locator('.lounge-file-control input').setInputFiles(upload);
  await expect(page.locator('.lounge-file-error')).toBeVisible();
  expect(sender.sent).toHaveLength(0);
  broker.updatePolicy({ loungeFileMaxMb: 2 });
  await expect(fileButton).toHaveAttribute('title', '每个文件最大 2 MB');
  await page.locator('.lounge-file-control input').setInputFiles(upload);
  await expect.poll(() => sender.sent.length).toBe(1);
});

for (const mode of ['local', 'remote', 'web', 'mobile']) {
  for (const direct of [false, true]) {
    test(`${mode}: ${direct ? 'private' : 'group'} image limit, encrypted receipt and offline cache`,
      async ({ page, context, browser }) => {
        const broker = new AttachmentBroker({ loungeGroupImageMaxMb: 1, loungeDirectImageMaxMb: 2 });
        await broker.install(context);
        const sender = await openPrivate(page, mode, direct);
        // A valid PNG with padding makes the original exceed 1 MB without depending on random image compression.
        const body = Buffer.concat([Buffer.from(pixel.split(',')[1], 'base64'), Buffer.alloc(1_500_000)]);
        await page.locator('.lounge-composer input[accept]').setInputFiles({ name: 'photo.png',
          mimeType: 'image/png', buffer: body });
        await expect(page.locator('.lounge-attachments img')).toHaveCount(1);
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await expect.poll(() => sender.sent.length).toBe(1);
        const outgoing = sender.sent[0] as typeof sender.sent[0] & { attachments: LoungeAttachment[] };
        const file = outgoing.attachments[0];
        expect(file.kind).toBe('image'); expect(outgoing.images).toEqual([]);
        if (direct) expect(file.size).toBe(body.length);
        else expect(file.size).toBeLessThanOrEqual(1024 * 1024);
        const receivingContext = await browser.newContext();
        try {
          await broker.install(receivingContext);
          const receiving = await receivingContext.newPage();
          const target = await openPrivate(receiving, mode, direct);
          target.frame({ type: 'message', id: crypto.randomUUID(), sender: { id: 'bob', account: 'bob@example.test' },
            ...(direct ? { recipient: { id: 'alice', account: 'alice@example.test' }, receipts: true } : {}),
            text: '', images: [], sentAt: new Date().toISOString(),
            attachments: [{ ...file, grant: JSON.stringify({ id: file.id, device: file.device }) }] });
          const image = receiving.locator('.lounge-message:not(.is-own) .lounge-image img').first();
          await expect(image).toBeVisible();
          const uri = await image.getAttribute('src');
          expect(Buffer.from(uri!.split(',')[1], 'base64').length).toBe(file.size);
          expect(broker.relayFrames).toBeGreaterThan(0);
          await page.close();
          await receiving.reload(); await target.ready();
          if (mode === 'mobile') {
            await receiving.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
            await receiving.locator('.discovery-lounge').click();
            await receiving.getByRole('button', { name: direct ? '与 bob 私聊' : '群聊',
              exact: true }).filter({ visible: true }).click();
          } else {
            await receiving.getByRole('button', { name: '在线交流', exact: true }).click();
            if (direct) await receiving.getByRole('button', { name: '与 bob 私聊', exact: true })
              .filter({ visible: true }).click();
          }
          await expect(image).toHaveAttribute('src', uri!);
        } finally { await receivingContext.close(); }
      });
  }
}

for (const mode of ['local', 'remote', 'web', 'mobile', 'mobile-320']) {
  test(`${mode}: file picker, encrypted relay transfer and managed bytes`, async ({ page, context }) => {
    const broker = new AttachmentBroker(); await broker.install(context);
    const sender = await openPrivate(page, mode);
    if (mode.startsWith('mobile')) await page.getByRole('button', { name: '添加内容', exact: true }).click();
    const body = Buffer.alloc(700_001, 149);
    await page.locator('.lounge-file-control input').setInputFiles({ name: 'transfer-report.zip',
      mimeType: 'application/zip', buffer: body });
    await expect.poll(() => sender.sent.length).toBe(1);
    const outgoing = sender.sent[0] as typeof sender.sent[0] & { attachments: LoungeAttachment[] };
    expect(outgoing.images).toEqual([]); expect(outgoing.attachments[0].size).toBe(body.length);
    const receiving = await context.newPage();
    receiving.on('pageerror', error => console.log('receiver', error.message));
    const target = await openPrivate(receiving, mode);
    const file = outgoing.attachments[0];
    target.frame({ type: 'message', id: crypto.randomUUID(), sender: { id: 'bob', account: 'bob@example.test' },
      recipient: { id: 'alice', account: 'alice@example.test' }, text: '', images: [],
      attachments: [{ ...file, grant: JSON.stringify({ id: file.id, device: file.device }) }],
      sentAt: new Date().toISOString(), receipts: true });
    const card = receiving.locator('.lounge-message:not(.is-own) .lounge-file-card').filter({ hasText: file.name });
    await expect(card).toBeVisible();
    await receiving.screenshot({ path: `../../.codex-tmp/lounge-files/${mode}-file.png` });
    if (mode.startsWith('mobile')) await card.getByRole('button').click();
    const actions = mode.startsWith('mobile') ? receiving.locator('.lounge-file-sheet') : card;
    await actions.getByRole('button', { name: '下载', exact: true }).click();
    await expect.poll(async () => (await managedAttachmentBytes(receiving, file.id))?.length,
      { timeout: 30_000 }).toBe(body.length);
    expect(Buffer.from((await managedAttachmentBytes(receiving, file.id))!)).toEqual(body);
    expect(broker.relayFrames).toBeGreaterThan(0); expect(broker.signalFrames).toBeGreaterThan(0);
    expect(await receiving.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await receiving.close();
  });
}
