// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Modal, theme } from 'antd';
import { expect, it, vi } from 'vitest';
import { ApplicationTypography } from '../../../../../shared/appearance/ApplicationTypography';
import { CodexAppearance } from '../../../../../shared/appearance/CodexAppearance';

function Tokens({ name }: { name: string }) {
  const { token } = theme.useToken();
  return <output data-testid={name}>{JSON.stringify({ primary: token.colorPrimary,
    radius: token.borderRadius, font: token.fontSize })}</output>;
}

it('keeps host tokens and the document unchanged while neutral chat and its dialog are retained', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = (hidden: boolean) => act(async () => root.render(
    <ConfigProvider theme={{ token: { colorPrimary: '#0b9b7c', borderRadius: 6 } }}>
      <ApplicationTypography><Tokens name="host" /><section hidden={hidden}>
        <CodexAppearance><Tokens name="chat" /><Modal open={!hidden} footer={null}>
          <Tokens name="dialog" />
        </Modal></CodexAppearance>
      </section></ApplicationTypography>
    </ConfigProvider>));
  const read = (name: string) => JSON.parse(document.querySelector(`[data-testid="${name}"]`)!.textContent!);
  try {
    await render(false);
    expect(read('host')).toMatchObject({ primary: '#0b9b7c', radius: 6 });
    expect(read('chat')).toMatchObject({ primary: '#242424', radius: 10 });
    expect(read('dialog').primary).toBe('#242424');
    expect(document.querySelector('[data-testid="dialog"]')?.closest('[data-codex-appearance]')).not.toBeNull();
    expect(document.documentElement.hasAttribute('data-codex-appearance')).toBe(false);
    await render(true);
    expect(read('host').primary).toBe('#0b9b7c');
    expect(document.documentElement.hasAttribute('data-codex-appearance')).toBe(false);
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
