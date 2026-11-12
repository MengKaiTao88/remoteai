import { test, expect } from '@playwright/test';
import { modelSettingsBackend } from './model-settings-backend';

for (const width of [1280, 390]) {
  test(`official permissions follow the same conversation at ${width}px`, async ({ browser }) => {
    const backend = modelSettingsBackend();
    backend.releaseUsage();
    backend.access('a', 'danger-full-access');
    backend.access('b', 'workspace-write');
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const remote = await browser.newContext({ viewport: { width, height: 900 } });
    await backend.attach(desktop); await backend.attach(remote);
    const pc = await desktop.newPage(); const web = await remote.newPage();
    pc.setDefaultNavigationTimeout(15000); web.setDefaultNavigationTimeout(15000);
    pc.setDefaultTimeout(8000); web.setDefaultTimeout(8000);
    try {
      await Promise.all([pc.goto('/official-permissions-harness.html', { waitUntil: 'domcontentloaded' }),
        web.goto('/official-permissions-harness.html?remote=1', { waitUntil: 'domcontentloaded' })]);
      await pc.getByRole('button', { name: '对话 a', exact: true }).click();
      await web.getByRole('button', { name: '对话 a', exact: true }).click();
      for (const page of [pc, web]) await expect(page.getByRole('button', { name: /^访问权限：完全访问/ })).toBeEnabled();
      backend.access('a', 'workspace-write');
      for (const page of [pc, web]) await expect(page.getByRole('button', { name: '访问权限：帮我批准', exact: true })).toBeEnabled();
      backend.access('a', 'danger-full-access');
      for (const page of [pc, web]) await expect(page.getByRole('button', { name: /^访问权限：完全访问/ })).toBeEnabled();
      await web.screenshot({ path: `../../.artifacts/totp-sync/official-access-browser-${width}.png`, animations: 'disabled' });
      await web.getByRole('button', { name: '对话 b', exact: true }).click();
      const picker = web.getByRole('button', { name: '访问权限：帮我批准', exact: true });
      await expect(picker).toBeEnabled(); await picker.click();
      await web.getByRole('menuitemradio').filter({ hasText: '完全访问' }).click();
      await expect(web.getByRole('button', { name: /^访问权限：完全访问/ })).toBeEnabled();
      expect(backend.saved.get('b')?.access).toBe('danger-full-access');
      for (const access of [{ label: '帮我批准', value: 'workspace-write' }, { label: '完全访问', value: 'danger-full-access' }]) {
        await web.getByRole('button', { name: /^访问权限：/ }).click();
        await web.getByRole('menuitemradio').filter({ hasText: access.label }).click();
        await expect(web.getByRole('button', { name: new RegExp(`^访问权限：${access.label}`) })).toBeEnabled();
        expect(backend.saved.get('b')?.access).toBe(access.value);
        if (access.value === 'workspace-write') {
          const timing = web.getByRole('img', { name: '将在下一轮对话生效。', exact: true });
          await expect(timing).toBeVisible(); await timing.hover();
          await expect(web.getByRole('tooltip')).toContainText('将在下一轮对话生效。');
          await web.screenshot({ path: `../../.artifacts/totp-sync/official-access-pending-${width}.png`, animations: 'disabled' });
        }
      }
      expect(backend.sends).toHaveLength(0);
      await expect(pc.getByRole('button', { name: /^访问权限：完全访问/ })).toBeEnabled();
    } finally { backend.releaseUsage(); await Promise.all([desktop.close(), remote.close()]); }
  });
}
