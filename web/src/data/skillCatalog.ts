import { useEffect, useState } from 'react';
import { listSkills, type Skill } from './api';

const TTL_MS = 10_000;
let cache: { skills: Skill[]; at: number } | null = null;
let inflight: Promise<Skill[]> | null = null;

/** Test hook: forget what was loaded. */
export function resetSkillCatalog(): void {
  cache = null;
  inflight = null;
}

/** One shared GET /skills for the composer menu and the chat bubbles. */
export function loadSkills(): Promise<Skill[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.skills);
  if (!inflight) {
    inflight = listSkills()
      .then((res) => {
        cache = { skills: res.skills, at: Date.now() };
        return res.skills;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** `null` until loaded; `[]` when loading failed. Only fetches while `enabled`. */
export function useSkillCatalog(enabled: boolean): Skill[] | null {
  const [skills, setSkills] = useState<Skill[] | null>(() => cache?.skills ?? null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadSkills().then(
      (list) => { if (!cancelled) setSkills(list); },
      () => { if (!cancelled) setSkills((cur) => cur ?? []); },
    );
    return () => { cancelled = true; };
  }, [enabled]);
  return skills;
}
