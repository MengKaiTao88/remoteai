import { describe, expect, it } from 'vitest';
import { entrySize, pathParts, samePath, visibleEntries } from '../../../../../shared/project-explorer/model';

describe('project explorer navigation paths', () => {
  it('preserves distinct computer, POSIX, drive and UNC roots', () => {
    expect(samePath('', '/')).toBe(false);
    expect(samePath('D:\\Projects\\', 'd:/projects')).toBe(true);
    expect(samePath('/Projects', '/projects')).toBe(false);
    expect(pathParts('D:\\Projects\\repo')).toEqual([
      { name: 'D:/', path: 'D:/' }, { name: 'Projects', path: 'D:/Projects' },
      { name: 'repo', path: 'D:/Projects/repo' },
    ]);
    expect(pathParts('\\\\server\\share\\repo')).toEqual([
      { name: '//server/share/', path: '//server/share/' }, { name: 'repo', path: '//server/share/repo' },
    ]);
    expect(pathParts('/home/project')).toEqual([
      { name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'project', path: '/home/project' },
    ]);
  });
});

it('filters names and hidden entries, sorts naturally and always keeps folders before files', () => {
  const entries = [
    { name: 'file2', path: '/file2', directory: false, size: 20 },
    { name: 'file10', path: '/file10', directory: false, size: 10 },
    { name: '.hidden', path: '/.hidden', directory: true },
    { name: 'folder', path: '/folder', directory: true },
  ];
  const options = { entries, query: '', hidden: false, sort: 'name' as const, descending: false };
  expect(visibleEntries(options).map(entry => entry.name)).toEqual(['folder', 'file2', 'file10']);
  expect(visibleEntries({ ...options, descending: true }).map(entry => entry.name))
    .toEqual(['folder', 'file10', 'file2']);
  expect(visibleEntries({ ...options, query: ' FILE ' }).map(entry => entry.name)).toEqual(['file2', 'file10']);
  expect(visibleEntries({ ...options, hidden: true })).toHaveLength(4);
  expect(visibleEntries({ ...options, sort: 'size' }).map(entry => entry.name)).toEqual(['folder', 'file10', 'file2']);
  expect(entrySize({ ...entries[0], size: 0 }, 'en')).toBe('0 KB');
});
