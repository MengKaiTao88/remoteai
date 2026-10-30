import { afterEach, expect, it, vi } from 'vitest';
import { createMappingConnection } from '../../../../shared/port-mapping/connection';
import type { ChatConnection, ConnectionEvents } from '../../../../shared/remote-chat/client/connection';
import { chatHandshake } from '../../../../shared/remote-chat/handshake';

afterEach(() => vi.useRealTimers());
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function fixture() {
  let events!: ConnectionEvents;
  const transport = { start: vi.fn(), stop: vi.fn(), retryNow: vi.fn(),
    request: vi.fn(async () => ({ portStreamsV1: true })), setBulkSupport: vi.fn(),
    mappingStreams: { open: vi.fn() } };
  const connection = createMappingConnection(value => {
    events = value;
    return transport as unknown as ChatConnection;
  });
  return { connection, transport, events };
}

it('negotiates capabilities once and resumes when transport v2 reconnects without another ready event', async () => {
  const { connection, transport, events } = fixture();
  connection.start(); events.mode('relay'); events.ready(); await flush();
  expect(transport.request).toHaveBeenCalledExactlyOnceWith('connect', chatHandshake);
  expect(transport.setBulkSupport).toHaveBeenCalledWith({ portStreamsV1: true });
  expect(connection.snapshot().ready).toBe(true);
  events.mode('connecting'); expect(connection.snapshot().ready).toBe(false);
  events.mode('direct'); await flush();
  expect(transport.request).toHaveBeenCalledTimes(2);
  expect(connection.snapshot().ready).toBe(true);
  connection.stop();
});

it('retries failed negotiations without overlap and cancels on sign out', async () => {
  vi.useFakeTimers();
  const { connection, transport, events } = fixture();
  transport.request.mockRejectedValueOnce(new Error('offline'));
  connection.start(); events.ready(); await flush();
  expect(connection.snapshot().ready).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(connection.snapshot().ready).toBe(true);
  connection.stop(); events.ready(); await vi.advanceTimersByTimeAsync(10_000);
  expect(transport.request).toHaveBeenCalledTimes(2);
});
