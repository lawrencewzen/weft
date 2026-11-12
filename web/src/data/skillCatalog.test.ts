import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listSkills } from './api';
import { loadSkills, preloadSkillCatalog, resetSkillCatalog } from './skillCatalog';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, listSkills: vi.fn() };
});

const row = { id: 'code-review', name: '代码审查', description: '', version: '1', source: 'x', enabled: true, deletable: false };

describe('preloadSkillCatalog', () => {
  beforeEach(() => {
    resetSkillCatalog();
    vi.mocked(listSkills).mockReset();
  });

  it('fetches once at startup and later readers reuse the cache', async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills: [row] });
    preloadSkillCatalog();
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(await loadSkills()).toEqual([row]);
    expect(await loadSkills()).toEqual([row]);
    expect(listSkills).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed load', async () => {
    vi.mocked(listSkills).mockRejectedValue(new Error('offline'));
    expect(() => preloadSkillCatalog()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    vi.mocked(listSkills).mockResolvedValue({ skills: [row] });
    expect(await loadSkills()).toEqual([row]);
  });
});
