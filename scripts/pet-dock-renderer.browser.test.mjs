import { testBrowserChannel, testBrowserLaunchOptions } from './test-browser.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { chromium } from '@playwright/test';

const renderer = await readFile(new URL('../apps/desktop/src-tauri/src/dream_skin_native/pet_dock.js', import.meta.url), 'utf8');
const image = `data:image/png;base64,${(await readFile(new URL('../apps/desktop/src-tauri/src/dream_skin_native/pet_dock/platform.png', import.meta.url))).toString('base64')}`;
const fixture = `<!doctype html><style>
  body { margin:0; background:#18202b; }
  [data-avatar-overlay-content-frame] { position:relative; width:500px; height:600px; }
  .group.absolute { position:absolute; left:140px; top:90px; width:80px; height:100px; }
  [data-avatar-mascot] { width:80px; height:100px; background:#799de1; border-radius:45%; }
  [data-quick-chat-presentation] { width:130px; height:25px; background:#888; }
  #tray-host { position:absolute; top:225px; left:105px; }
  [data-avatar-overlay-size] { width:220px; height:100px; background:#293b50; }
</style><div data-avatar-overlay-content-frame>
  <div class="group absolute"><div data-avatar-mascot="true"></div>
    <div data-quick-chat-presentation><button id="native-action">Native action</button></div></div>
  <div id="tray-host"><div data-avatar-overlay-size="notification-tray"><button id="card-action">Card</button></div></div>
</div>`;
let browser, page;
const update = (snapshot) => page.evaluate(({ snapshot, image }) => window.__remoteAiPetDock.update(snapshot, image), { snapshot, image });
const inspect = () => page.evaluate(() => window.__remoteAiPetDock.inspect());
const official = { language: 'zh', kind: 'official', fiveHour: { remaining: 81 }, weekly: { remaining: 62 } };

before(async () => {
  browser = await chromium.launch(testBrowserLaunchOptions({
    channel: testBrowserChannel(process.env.PLAYWRIGHT_CHANNEL),
  }));
});
after(async () => { await browser?.close(); });
beforeEach(async () => {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 600, height: 700 } });
  await page.setContent(fixture);
  await page.clock.install();
  await page.evaluate(renderer);
  await update(official);
});

test('keeps the pet size, scales the base to 1.75, and places live cards below it', async () => {
  const state = await inspect();
  assert.equal(state.mascot.width, 80);
  assert.equal(state.dock.width, 140);
  assert.equal(state.dock.height, 45);
  assert.equal(state.sameMovingParent, true);
  assert.equal(state.toolbarHidden, true);
  assert.ok(state.tray.top > state.dock.bottom);
  assert.equal(await page.locator('[data-side="left"]').textContent(), '81%');
  assert.equal(await page.locator('[data-side="right"]').textContent(), '62%');
});

test('toggles labels live while preserving values, dock geometry and accessible descriptions', async () => {
  assert.equal(await page.locator('.ra-label:visible').count(), 0);
  const description = await page.locator('#remoteai-pet-dock').getAttribute('aria-label');
  const before = await inspect();
  const numericFont = await page.locator('[data-side="left"]').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  await update({ ...official, showLabels: true });
  assert.equal(await page.locator('.ra-label:visible').count(), 2);
  assert.deepEqual(await page.locator('.ra-label').allTextContents(), ['5小时剩余', '本周剩余']);
  const labeledFont = await page.locator('[data-side="left"]').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  assert.ok(numericFont > labeledFont);
  assert.equal((await inspect()).dock.width, before.dock.width);
  await update({ ...official, showLabels: false });
  assert.equal(await page.locator('.ra-label:visible').count(), 0);
  assert.deepEqual(await page.locator('.ra-value').allTextContents(), ['81%', '62%']);
  assert.equal(await page.locator('#remoteai-pet-dock').getAttribute('aria-label'), description);
  assert.equal((await inspect()).dockCount, 1);
  assert.equal((await inspect()).sameMovingParent, true);
});

test('uses the label preference in API mode and keeps long amounts inside each numeric panel', async () => {
  const snapshot = { language: 'zh', kind: 'api', remaining: { amount: 1545.42, unit: 'USD' }, totalTokens: 56180000 };
  await update({ ...snapshot, showLabels: true });
  assert.deepEqual(await page.locator('.ra-label:visible').allTextContents(), ['剩余额度', '总消耗']);
  await update({ ...snapshot, showLabels: false });
  assert.equal(await page.locator('.ra-label:visible').count(), 0);
  assert.deepEqual(await page.locator('.ra-value').allTextContents(), ['$1545.42', '56.18M']);
  const measurements = await page.locator('.ra-value').evaluateAll(nodes => nodes.map(node => {
    const value = node.getBoundingClientRect(), panel = node.parentElement.getBoundingClientRect();
    return { left: value.left >= panel.left, right: value.right <= panel.right,
      verticalOffset: value.top + value.height / 2 - panel.top - panel.height / 2 };
  }));
  assert.ok(measurements.every(value => value.left && value.right && Math.abs(value.verticalOffset - 2) < 0.1));
  await update({ ...snapshot, language: 'ja', showLabels: true });
  assert.deepEqual(await page.locator('.ra-label:visible').allTextContents(), ['残高', '総トークン']);
});

test('moves the dock in the exact same frame as a dragged native parent', async () => {
  const delta = await page.evaluate(() => {
    const before = window.__remoteAiPetDock.inspect();
    document.querySelector('.group.absolute').style.transform = 'translate(63px, 41px)';
    const after = window.__remoteAiPetDock.inspect();
    return { petX: after.mascot.x - before.mascot.x, dockX: after.dock.x - before.dock.x,
      petY: after.mascot.y - before.mascot.y, dockY: after.dock.y - before.dock.y };
  });
  assert.deepEqual(delta, { petX: 63, dockX: 63, petY: 41, dockY: 41 });
});

test('transparent card wrappers cannot intercept pet drags while actual cards remain clickable', async () => {
  await page.evaluate(() => {
    const host = document.querySelector('#tray-host');
    host.style.cssText = 'position:absolute;left:120px;top:90px;width:220px;height:100px;';
    const tray = host.firstElementChild;
    tray.style.cssText = 'position:relative;top:112px;';
    window.petPresses = 0;
    window.cardPresses = 0;
    document.querySelector('[data-avatar-mascot]').addEventListener('pointerdown', () => window.petPresses++);
    document.querySelector('#card-action').addEventListener('click', () => window.cardPresses++);
    window.__remoteAiPetDock.update({ language: 'en', kind: 'official' });
  });
  await page.locator('[data-avatar-mascot]').click({ timeout: 1500 });
  await page.locator('#card-action').click({ timeout: 1500 });
  assert.equal(await page.evaluate(() => window.petPresses), 1);
  assert.equal(await page.evaluate(() => window.cardPresses), 1);
});

test('cards follow the pet before the next animation frame and ignore native tray offsets', async () => {
  const delta = await page.evaluate(() => {
    const before = window.__remoteAiPetDock.inspect();
    document.querySelector('.group.absolute').style.transform = 'translate(63px, 160px)';
    document.querySelector('#tray-host').style.transform = 'translate(-80px, -176px)';
    document.querySelector('[data-avatar-overlay-size="notification-tray"]').style.top = '-24px';
    const after = window.__remoteAiPetDock.inspect();
    return { petX: after.mascot.x - before.mascot.x, trayX: after.tray.x - before.tray.x,
      petY: after.mascot.y - before.mascot.y, trayY: after.tray.y - before.tray.y,
      gap: after.tray.top - after.dock.bottom };
  });
  assert.equal(delta.trayX, delta.petX);
  assert.equal(delta.trayY, delta.petY);
  assert.ok(delta.gap >= 4);
});

test('cards flip above the pet near the bottom edge and return below when space is available', async () => {
  await page.evaluate(() => { document.querySelector('.group.absolute').style.top = '550px'; });
  const bottom = await inspect();
  assert.ok(bottom.tray.bottom < bottom.mascot.top);
  assert.ok(bottom.mascot.top - bottom.tray.bottom < 20);
  assert.ok(bottom.tray.top >= 0);
  await page.evaluate(() => { document.querySelector('.group.absolute').style.top = '90px'; });
  const restored = await inspect();
  assert.ok(restored.tray.top > restored.dock.bottom);
});

test('cards stay within the frame at either horizontal edge', async () => {
  for (const left of [0, 420]) {
    await page.evaluate(left => { document.querySelector('.group.absolute').style.left = `${left}px`; }, left);
    const state = await inspect();
    assert.ok(state.tray.left >= 0);
    assert.ok(state.tray.right <= 500);
    assert.ok(state.tray.top > state.dock.bottom);
  }
});

test('bottom placement measures overflowing stacked cards, not only the native wrapper height', async () => {
  await page.evaluate(() => {
    const tray = document.querySelector('[data-avatar-overlay-size="notification-tray"]');
    tray.style.height = '56px';
    tray.insertAdjacentHTML('beforeend', '<div style="position:relative;height:150px">Expanded stack</div>');
    document.querySelector('.group.absolute').style.top = '375px';
    window.__remoteAiPetDock.update({ language: 'en', kind: 'official' });
  });
  const state = await inspect();
  const cardBottom = await page.locator('[data-avatar-overlay-size="notification-tray"] > div')
    .evaluate(node => node.getBoundingClientRect().bottom);
  assert.ok(cardBottom < state.mascot.top);
});

test('adapts to another pet size and does not add duplicate docks', async () => {
  await page.evaluate(() => {
    document.querySelector('[data-avatar-mascot]').style.width = '128px';
    window.__remoteAiPetDock.update({ language: 'en' });
  });
  await page.evaluate(renderer);
  const state = await inspect();
  assert.equal(state.dock.width, 224);
  assert.equal(state.mascot.width, 128);
  assert.equal(state.dockCount, 1);
});

test('switches official/API values and localizes labels without copying provider data', async () => {
  await update({ language: 'zh', kind: 'api', remaining: { amount: 1545.42, unit: 'USD' }, totalTokens: 55910000 });
  assert.equal(await page.locator('[data-side="left"]').textContent(), '$1545.42');
  assert.equal(await page.locator('[data-side="right"]').textContent(), '55.91M');
  await update({ language: 'ja', kind: 'api', remaining: { unlimited: true }, totalTokens: null });
  assert.equal(await page.locator('[data-side="left"]').textContent(), '無制限');
  assert.equal(await page.locator('[data-side="right"]').textContent(), '--');
  await update(official);
  assert.equal(await page.locator('[data-side="left"]').textContent(), '81%');
});

test('restores native attributes and card positions when disabled', async () => {
  await page.evaluate(() => window.__remoteAiPetDock.destroy());
  assert.equal(await page.locator('#remoteai-pet-dock').count(), 0);
  assert.equal(await page.locator('[data-remoteai-dock-toolbar]').count(), 0);
  assert.equal(await page.locator('[inert]').count(), 0);
  assert.equal(await page.locator('#tray-host').evaluate((node) => node.style.getPropertyValue('--remoteai-dock-tray-shift')), '');
  assert.equal(await page.locator('[data-remoteai-dock-anchored]').count(), 0);
  assert.equal(await page.locator('#tray-host').evaluate(node => node.style.getPropertyValue('--remoteai-dock-tray-gap')), '');
  assert.equal(await page.locator('#tray-host').evaluate(node => node.style.getPropertyValue('--remoteai-dock-tray-height')), '');
  await page.locator('#native-action').click();
  await page.locator('#card-action').click();
});

test('restores the native layout if the host stops supplying heartbeats', async () => {
  await page.clock.fastForward(21_000);
  assert.equal(await page.locator('#remoteai-pet-dock').count(), 0);
  assert.equal(await page.locator('[data-remoteai-dock-toolbar]').count(), 0);
});

test('reattaches when the native pet host is recreated', async () => {
  await page.evaluate(() => {
    const host = document.querySelector('.group.absolute');
    const next = host.cloneNode(true);
    next.querySelector('#remoteai-pet-dock')?.remove();
    host.replaceWith(next);
    window.__remoteAiPetDock.update({ language: 'en', kind: 'official' });
  });
  assert.equal((await inspect()).sameMovingParent, true);
  assert.equal(await page.locator('#remoteai-pet-dock').count(), 1);
});
