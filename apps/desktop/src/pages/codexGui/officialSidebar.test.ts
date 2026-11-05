import { describe, expect, it } from 'vitest';
import { officialGrouping, officialSections } from './officialSidebar';

const thread = (id: string, cwd: string, projectId: string | null = null) => ({
  id, cwd, preview: '', updatedAt: 1,
  officialSidebar: { projectId, projectName: 'Official project', pinned: false },
});

describe('official Codex sidebar membership', () => {
  it('keeps projectless conversations in Recent without changing their working directories', () => {
    const threads = [thread('one', 'C:/one'), thread('two', 'D:/two'), thread('three', 'C:/one', 'project')];
    const sections = officialSections(threads)!;
    expect(sections.map(section => section.id)).toEqual(['official-project-project', 'official-recent']);
    expect(sections[1].threads.map(entry => entry.id)).toEqual(['one', 'two']);
    expect(sections[1].threads.map(entry => entry.cwd)).toEqual(['C:/one', 'D:/two']);
    const grouping = officialGrouping(threads)!;
    expect(grouping.threads).toEqual({ one: 'official-recent', two: 'official-recent', three: 'official-project-project' });
    expect(grouping.groups[0].name).toBe('Official project');
  });

  it('preserves normal Remote AI grouping when native membership is absent', () => {
    expect(officialSections([{ id: 'old', cwd: 'C:/old', preview: '', updatedAt: 1 }])).toBeUndefined();
  });
});
