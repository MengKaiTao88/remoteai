import { DeviceMappingRegistry } from '../deviceRegistry';
import { DeviceMappingRuntime, type MappingConnection } from '../deviceRuntime';
import type { MappingDocument } from '../sync';
import type { MappingStorage } from '../settings';
import type { TunnelFactory } from '../types';
import type { MappingRead } from '../socket';

export function mappingFixture(options: { storage: MappingStorage; createTunnel?: TunnelFactory }) {
  const controls = new Map<string, { ready: (value: boolean) => void; connects: number; disconnects: number }>();
  const documents = new Map<string, MappingDocument>();
  const registry = new DeviceMappingRegistry((deviceId, owner) => {
    let state = { ready: false, error: '' };
    const listeners = new Set<() => void>();
    const control = { connects: 0, disconnects: 0, ready: (value: boolean) => {
      state = { ready: value, error: '' }; listeners.forEach(listener => listener());
    } };
    controls.set(deviceId, control);
    const connection: MappingConnection = {
      files: { openResource: async () => deviceId, closeResource: async () => {},
        link: async () => ({ type: 'done' }), stream: async () => replySocket(deviceId) },
      start: () => { control.connects++; control.ready(true); },
      stop: () => { control.disconnects++; control.ready(false); },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      snapshot: () => state,
    };
    return new DeviceMappingRuntime(connection, { scope: deviceId, storage: options.storage,
      createId: () => `mapping-${Date.now()}`, validateTarget: (target, id) => owner.validateTarget(deviceId, target, id),
      createTunnel: options.createTunnel ?? (() => ({ resolve: async (_resource, url) => url, close: async () => {} })),
      exchange: async document => {
        if (document) {
          documents.set(deviceId, document);
          options.storage.setItem(`fixture-cloud:${deviceId}`, JSON.stringify(document));
        }
        return { ...(documents.get(deviceId) ?? JSON.parse(options.storage.getItem(`fixture-cloud:${deviceId}`)
          ?? '{"revision":0,"mappings":[]}')), accepted: true };
      },
    });
  });
  return { registry, controls };
}

function replySocket(deviceId: string) {
  let resolve: ((value: MappingRead) => void) | undefined;
  let reply: MappingRead | undefined;
  const publish = (value: MappingRead) => { reply = value; resolve?.(value); };
  return {
    read: async () => reply ?? new Promise<MappingRead>(done => { resolve = done; }),
    write: async () => {
      const body = `mapped-${deviceId}`;
      const text = `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
      publish({ data: Uint8Array.from(text, char => char.charCodeAt(0)), eof: true });
    },
    close: () => publish({ data: new Uint8Array(), eof: true }),
  };
}
