import fs from 'fs';
import path from 'path';
import {
  TokenScoreResult,
  computeTokenScore,
  refreshIntervalMs,
  fetchTokenAgeMs,
} from './token-scoring';

const STATS_DIR = process.env.STATS_DIR || '/data';
const CACHE_FILE = path.join(STATS_DIR, 'token-cache.json');
const FALLBACK_FILE = path.join(process.cwd(), 'token-cache.json');

interface CacheEntry {
  address: string;
  result: TokenScoreResult | null; // null while pending
  status: 'pending' | 'ready';
  prevScore: number | null;
  firstSeenAt: string;
  nextRefreshAtMs: number;
  inFlight?: boolean;
}

interface CacheState {
  entries: Record<string, CacheEntry>; // keyed by lowercased address
}

function activeFile(): string {
  try {
    if (!fs.existsSync(STATS_DIR)) fs.mkdirSync(STATS_DIR, { recursive: true });
    fs.accessSync(STATS_DIR, fs.constants.W_OK);
    return CACHE_FILE;
  } catch {
    return FALLBACK_FILE;
  }
}

function load(): CacheState {
  const file = activeFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as CacheState;
      // clear any stale inFlight flags from previous process
      for (const e of Object.values(parsed.entries || {})) e.inFlight = false;
      return parsed;
    }
  } catch (err) {
    console.error('[token-cache] load failed:', (err as Error).message);
  }
  return { entries: {} };
}

let state: CacheState = load();

function persist() {
  const file = activeFile();
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[token-cache] persist failed:', (err as Error).message);
  }
}

export interface PendingResponse {
  address: string;
  status: 'pending';
  first_seen: string;
  estimated_ready: string;
}

export type CacheLookupResult =
  | { kind: 'ready'; data: TokenScoreResult }
  | { kind: 'pending'; data: PendingResponse };

async function runRefresh(addressLower: string) {
  const entry = state.entries[addressLower];
  if (!entry || entry.inFlight) return;
  entry.inFlight = true;
  persist();

  try {
    const ageMs = await fetchTokenAgeMs(entry.address);
    const interval = refreshIntervalMs(ageMs);
    const nextAt = new Date(Date.now() + interval);
    const computed = await computeTokenScore(entry.address, entry.prevScore, nextAt);

    entry.prevScore = computed.result.score;
    entry.result = computed.result;
    entry.status = 'ready';
    entry.nextRefreshAtMs = nextAt.getTime();
  } catch (err) {
    console.error(`[token-cache] refresh failed for ${entry.address}:`, (err as Error).message);
    // don't promote to ready, leave as pending — will retry next tick
  } finally {
    entry.inFlight = false;
    persist();
  }
}

export function lookup(address: string): CacheLookupResult {
  const key = address.toLowerCase();
  let entry = state.entries[key];

  if (!entry) {
    // First time seen — register pending and kick off compute in background
    const now = new Date();
    entry = {
      address,
      result: null,
      status: 'pending',
      prevScore: null,
      firstSeenAt: now.toISOString(),
      // 1hr default until we know token age
      nextRefreshAtMs: now.getTime() + 60 * 60 * 1000,
    };
    state.entries[key] = entry;
    persist();
    // fire and forget
    runRefresh(key).catch(() => {});
    return {
      kind: 'pending',
      data: {
        address,
        status: 'pending',
        first_seen: entry.firstSeenAt,
        estimated_ready: new Date(now.getTime() + 30_000).toISOString(),
      },
    };
  }

  if (entry.status === 'pending' || !entry.result) {
    return {
      kind: 'pending',
      data: {
        address,
        status: 'pending',
        first_seen: entry.firstSeenAt,
        estimated_ready: new Date(Date.now() + 15_000).toISOString(),
      },
    };
  }

  return { kind: 'ready', data: entry.result };
}

// Background sweep: every minute, check for entries whose nextRefreshAtMs has
// elapsed and re-run them. Single in-process worker — fine for one Railway
// instance. For multi-instance, this should move to a shared lock.
let sweepStarted = false;
export function startBackgroundRefresher() {
  if (sweepStarted) return;
  sweepStarted = true;
  const tick = async () => {
    const now = Date.now();
    const due = Object.entries(state.entries)
      .filter(([, e]) => !e.inFlight && now >= e.nextRefreshAtMs)
      .map(([k]) => k);

    for (const key of due) {
      // serialize refreshes — don't hammer the chain
      try {
        await runRefresh(key);
      } catch (err) {
        console.error('[token-cache] sweep refresh error:', (err as Error).message);
      }
    }
  };

  // first tick after 30s, then every 60s
  setTimeout(() => {
    tick();
    setInterval(tick, 60_000);
  }, 30_000);

  console.log('[token-cache] background refresher started');
}

// Test/admin helper: how many tokens currently cached
export function cacheSize(): number {
  return Object.keys(state.entries).length;
}
