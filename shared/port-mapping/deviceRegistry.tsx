import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { DeviceMappingRuntime } from './deviceRuntime';
import { mappingConflicts, type PortMapping } from './settings';
import type { ForwardingEntry } from './service';

export interface DeviceMappingEntry {
  deviceId: string; entry: ForwardingEntry; runtime: DeviceMappingRuntime;
  connected: boolean; connectionError: string; syncStatus: string;
}

export class DeviceMappingRegistry {
  private readonly runtimes = new Map<string, DeviceMappingRuntime>();
  private entries: DeviceMappingEntry[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(private readonly create: (deviceId: string, registry: DeviceMappingRegistry) => DeviceMappingRuntime) {}
  get = (deviceId: string) => {
    let runtime = this.runtimes.get(deviceId);
    if (!runtime) {
      runtime = this.create(deviceId, this); this.runtimes.set(deviceId, runtime);
      runtime.service.subscribe(this.update);
      runtime.connection.subscribe(this.update);
      runtime.sync.subscribe(this.update);
      this.update(false);
    }
    return runtime;
  };
  snapshot = () => this.entries;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update = (notify = true) => {
    this.entries = [...this.runtimes].flatMap(([deviceId, runtime]) => runtime.service.snapshot().map(entry => ({
      deviceId, entry, runtime, connected: runtime.connection.snapshot().ready,
      connectionError: runtime.connection.snapshot().error, syncStatus: runtime.sync.snapshot(),
    }))).sort((left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0));
    if (notify) this.listeners.forEach(listener => listener());
  };
  validateTarget = (deviceId: string, target: Omit<PortMapping, 'id'>, id?: string) => {
    for (const [otherId, runtime] of this.runtimes) {
      if (runtime.service.snapshot().some(entry => (deviceId !== otherId || entry.id !== id)
        && mappingConflicts(entry, target))) throw new Error('client.mappingHub.portConflict');
    }
  };
}

const MappingContext = createContext<DeviceMappingRegistry | undefined>(undefined);

export function DeviceMappingProvider({ registry, deviceIds, children }: {
  // Web and native use different React type versions; both pass renderable children at this boundary.
  registry: DeviceMappingRegistry; deviceIds: string[]; children: unknown;
}) {
  // Construct all services before any can validate a target against the other devices.
  const runtimes = deviceIds.map(deviceId => registry.get(deviceId));
  return <MappingContext.Provider value={registry}>
    {runtimes.map((runtime, index) => <MappingWorker key={deviceIds[index]} runtime={runtime} />)}
    {children as ReactNode}
  </MappingContext.Provider>;
}

function MappingWorker({ runtime }: { runtime: DeviceMappingRuntime }) {
  useEffect(runtime.start, [runtime]);
  return null;
}

export function useDeviceMapping(deviceId: string) {
  const registry = useContext(MappingContext);
  return deviceId ? registry?.get(deviceId) : undefined;
}

const noEntries: DeviceMappingEntry[] = [];
const noSubscribe = () => () => {};
const emptySnapshot = () => noEntries;
export function useDeviceMappings() {
  const registry = useContext(MappingContext);
  return useSyncExternalStore(registry?.subscribe ?? noSubscribe, registry?.snapshot ?? emptySnapshot);
}

export function useMappingRuntime(runtime: DeviceMappingRuntime) {
  const entries = useSyncExternalStore(runtime.service.subscribe, runtime.service.snapshot);
  const connection = useSyncExternalStore(runtime.connection.subscribe, runtime.connection.snapshot);
  const syncStatus = useSyncExternalStore(runtime.sync.subscribe, runtime.sync.snapshot);
  return { entries, connection, syncStatus, service: runtime.service };
}
