import { ALLOWED_REPOS, INITIAL_MUTED } from "./config.ts";

let globalMuted = INITIAL_MUTED;
const repoMutes = new Map<string, number | null>();
const eventCounts = { received: 0, delivered: 0, filtered: 0, muted: 0 };

export function isGlobalMuted(): boolean {
  return globalMuted;
}

export function setGlobalMute(value: boolean): void {
  globalMuted = value;
}

export function isRepoMuted(repo: string): boolean {
  const expiry = repoMutes.get(repo);
  if (expiry === undefined) return false;
  if (expiry === null) return true;
  if (Date.now() < expiry) return true;
  repoMutes.delete(repo);
  return false;
}

export function muteRepo(repo: string, hours?: number): void {
  repoMutes.set(repo, hours ? Date.now() + hours * 3600_000 : null);
}

export function unmuteRepo(repo: string): boolean {
  return repoMutes.delete(repo);
}

export function muteAll(hours?: number): void {
  for (const repo of ALLOWED_REPOS) {
    muteRepo(repo, hours);
  }
  if (ALLOWED_REPOS.length === 0) globalMuted = true;
}

export function unmuteAll(): void {
  repoMutes.clear();
  globalMuted = false;
}

export function listMutedRepos(): Record<string, string> {
  const result: Record<string, string> = {};
  const now = Date.now();
  for (const [repo, expiry] of repoMutes) {
    if (expiry === null) {
      result[repo] = "indefinite";
    } else if (expiry > now) {
      const remaining = Math.ceil((expiry - now) / 3600_000 * 10) / 10;
      result[repo] = `${remaining}h remaining`;
    } else {
      repoMutes.delete(repo);
    }
  }
  return result;
}

export function getEventCounts() {
  return eventCounts;
}

export function incrementCount(key: keyof typeof eventCounts): void {
  eventCounts[key]++;
}
