import { expect, it, vi } from 'vitest';
import { withMappingBackground } from './background';
import type { MappingConnection } from '../../../../shared/port-mapping/deviceRuntime';

const background = vi.hoisted(() => ({ retain: vi.fn(), remove: vi.fn() }));
vi.mock('../chat/backgroundConnection', () => ({ retainPortMappingConnection: background.retain }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: background.remove }) } }));

it('does not lose a newer lease if an earlier cancelled start rejects late', async () => {
  let reject!: (error: Error) => void;
  const release = vi.fn(async () => {});
  background.retain.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }))
    .mockResolvedValueOnce(release);
  const connection = withMappingBackground({ start: vi.fn(), stop: vi.fn() } as unknown as MappingConnection);
  connection.start(); connection.stop(); connection.start();
  reject(new Error('cancelled'));
  for (let index = 0; index < 5; index++) await Promise.resolve();
  connection.stop();
  for (let index = 0; index < 5; index++) await Promise.resolve();
  expect(release).toHaveBeenCalledOnce();
  expect(background.remove).toHaveBeenCalledTimes(2);
});
