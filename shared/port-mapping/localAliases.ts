import type { MappingStorage } from './settings';

export const MAX_MAPPING_ALIAS_LENGTH = 80;

/** Local metadata has its own storage key and never enters mapping synchronization. */
export class LocalMappingAliases {
  private readonly key: string;
  private readonly listeners = new Set<() => void>();
  private values: Record<string, string> = {};

  constructor(private readonly storage: MappingStorage, scope: string) {
    this.key = 'codex-port-mapping-aliases:' + scope;
    try {
      const saved: unknown = JSON.parse(storage.getItem(this.key) ?? '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        this.values = Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'string'));
      }
    } catch { /* A missing or damaged local label must not prevent access to the mapping. */ }
  }

  get = (id: string) => Object.hasOwn(this.values, id) ? this.values[id] : '';
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set = (id: string, value: string) => {
    const alias = value.trim();
    if (alias.length > MAX_MAPPING_ALIAS_LENGTH) throw new Error('client.mappingEditor.aliasTooLong');
    if (this.get(id) === alias) return;
    const next = { ...this.values, [id]: alias };
    if (!alias) delete next[id];
    try { this.storage.setItem(this.key, JSON.stringify(next)); }
    catch { throw new Error('client.mappingEditor.aliasSaveFailed'); }
    this.values = next;
    this.listeners.forEach(listener => listener());
  };
}
