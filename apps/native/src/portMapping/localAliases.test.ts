import { expect, it, vi } from 'vitest';
import { LocalMappingAliases } from '../../../../shared/port-mapping/localAliases';

it('retains the displayed alias if local storage fails and reports a translated error key', () => {
  const storage = { getItem: () => '{"one":"Previous"}', setItem: vi.fn(() => { throw new Error('storage'); }) };
  const aliases = new LocalMappingAliases(storage, 'account:computer');
  const changed = vi.fn(); aliases.subscribe(changed);
  expect(() => aliases.set('one', 'New')).toThrow('client.mappingEditor.aliasSaveFailed');
  expect(aliases.get('one')).toBe('Previous'); expect(changed).not.toHaveBeenCalled();
});

it('ignores damaged metadata and handles literal mapping IDs without modifying object prototypes', () => {
  const storage = { getItem: () => '{broken', setItem: vi.fn<(key: string, value: string) => void>() };
  const aliases = new LocalMappingAliases(storage, 'account:computer');
  expect(aliases.get('one')).toBe('');
  aliases.set('__proto__', 'Local label');
  expect(aliases.get('__proto__')).toBe('Local label');
  expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({ ['__proto__']: 'Local label' });
  expect(() => aliases.set('one', 'x'.repeat(81))).toThrow('client.mappingEditor.aliasTooLong');
});
