import { AppState } from 'react-native';
import type { MappingConnection } from '../../../../shared/port-mapping/deviceRuntime';
import { retainPortMappingConnection } from '../chat/backgroundConnection';

/** Hold the Android background lease during reconnects as well as while a listener is running. */
export function withMappingBackground(connection: MappingConnection): MappingConnection {
  let release: Promise<() => Promise<void>> | undefined;
  let subscription: ReturnType<typeof AppState.addEventListener> | undefined;
  return { ...connection,
    start: () => {
      connection.start();
      subscription ??= AppState.addEventListener('change', state => {
        if (state === 'active') connection.start();
      });
      if (!release) {
        const pending = retainPortMappingConnection().catch(() => {
          // Listener startup reports missing background support and retries while enabled.
          if (release === pending) release = undefined;
          return async () => {};
        });
        release = pending;
      }
    },
    stop: () => {
      connection.stop();
      subscription?.remove(); subscription = undefined;
      void release?.then(cleanup => cleanup()).catch(() => console.warn('Mapping background cleanup failed'));
      release = undefined;
    },
  };
}
