import { expect, test, type Locator, type Page } from '@playwright/test';
import { setupLounge } from './lounge-support';

const webURL = process.env.LOUNGE_TEST_WEB_URL ?? 'http://127.0.0.1:1486/web/';
const carol = { id: 'carol', account: 'carol@example.test' };
const bobLabel = '与 bob 私聊';
const carolLabel = '与 carol 私聊';
test.setTimeout(120_000);

async function enter(page: Page, mobile: boolean) {
  if (!mobile) return page.getByRole('button', { name: '在线交流', exact: true }).click();
  await page.locator('.mobile-tabbar').getByText('发现', { exact: true }).click();
  await page.locator('.discovery-lounge').click();
}

async function longPress(row: Locator) {
  await expect(row.page().getByRole('menu')).toBeHidden();
  await row.hover();
  const bounds = (await row.boundingBox())!;
  const pointer = { pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0,
    clientX: bounds.x + 20, clientY: bounds.y + bounds.height / 2 };
  await row.dispatchEvent('pointerdown', pointer);
  await expect(row.page().getByRole('menu')).toBeVisible();
  await row.dispatchEvent('pointerup', pointer);
}

async function contacts(page: Page, legacy = false) {
  return page.evaluate(upgrade => new Promise<{ pinned?: boolean; lastMessageAt?: number }[]>((resolve, reject) => {
    const open = indexedDB.open('remoteai-lounge-history-v1');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction('contacts', upgrade ? 'readwrite' : 'readonly');
      const store = tx.objectStore('contacts'); const request = store.getAll();
      request.onsuccess = () => {
        if (upgrade) for (const value of request.result) { delete value.lastMessageAt; store.put(value); }
      };
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }), legacy);
}

for (const mode of ['local', 'remote', 'web', 'mobile-320', 'mobile-390']) {
  test(`${mode}: latest message ordering, both pin gestures, legacy storage and offline restart`, async ({ page }) => {
    const mobile = mode.startsWith('mobile');
    if (mobile) await page.setViewportSize({ width: Number(mode.split('-')[1]), height: 844 });
    const relay = await setupLounge(page, mobile || mode === 'web');
    await page.goto(mobile || mode === 'web' ? webURL : `/e2e/lounge-harness.html?mode=${mode}`);
    await relay.ready(); await enter(page, mobile);
    const rows = page.locator(mobile ? '.lounge-chat-row-main' : '.lounge-people-list .lounge-person');
    const privateRows = rows.and(page.getByRole('button', { name: /^与 .+ 私聊$/ }));
    const bob = rows.and(page.getByRole('button', { name: bobLabel }));
    const carolRow = rows.and(page.getByRole('button', { name: carolLabel }));
    const expectOrder = async (labels: string[]) => {
      await expect.poll(() => privateRows.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))))
        .toEqual(labels);
    };
    relay.private('bob-first'); await expect(bob).toBeVisible();
    relay.private('carol-next', carol); await expectOrder([carolLabel, bobLabel]);
    await bob.click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('new-outgoing');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    if (mobile) await page.getByRole('button', { name: '返回聊天列表' }).click();
    await expectOrder([bobLabel, carolLabel]);
    await carolRow.click({ button: 'right' });
    const menuActions = await page.getByRole('menuitem').allTextContents();
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
    await expectOrder([carolLabel, bobLabel]);
    relay.private('bob-newest'); await expectOrder([carolLabel, bobLabel]);
    await longPress(bob); expect(await page.getByRole('menuitem').allTextContents()).toEqual(menuActions);
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click();
    await expectOrder([bobLabel, carolLabel]);
    await expect(page.getByRole('img', { name: '已置顶' })).toHaveCount(2);
    await expect.poll(async () => (await contacts(page)).filter(value => value.pinned).length).toBe(2);
    await contacts(page, true); await page.reload(); await enter(page, mobile);
    await expectOrder([bobLabel, carolLabel]);
    await expect(page.getByRole('img', { name: '已置顶' })).toHaveCount(2);
    await expect.poll(async () => (await contacts(page)).every(value => (value.lastMessageAt ?? 0) > 0)).toBe(true);
    await bob.click({ button: 'right' }); await page.getByRole('menuitem', { name: '取消置顶' }).click();
    await expectOrder([carolLabel, bobLabel]);
    await expect.poll(async () => (await contacts(page)).filter(value => value.pinned).length).toBe(1);
    relay.offline(); await page.evaluate(() => sessionStorage.setItem('lounge-test-offline', '1'));
    await page.reload(); await enter(page, mobile); await expectOrder([carolLabel, bobLabel]);
    await expect(page.getByRole('img', { name: '已置顶' })).toHaveCount(1);
    await page.screenshot({ path: `../../.codex-tmp/lounge-ordering-${mode}.png`, animations: 'disabled' });
    await longPress(carolRow); await page.getByRole('menuitem', { name: '取消置顶' }).click();
    await expectOrder([bobLabel, carolLabel]);
  });
}
