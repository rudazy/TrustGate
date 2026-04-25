import fs from 'fs';
import path from 'path';
import type { Tier } from './scoring';

const STATS_DIR = process.env.STATS_DIR || '/data';
const STATS_FILE = path.join(STATS_DIR, 'oracle-stats.json');
const FALLBACK_FILE = path.join(process.cwd(), 'oracle-stats.json');

interface StatsState {
  totalQueries: number;
  totalUsdcEarnedMicros: number; // store in micros to avoid float drift
  uniqueAddresses: string[];
  scoreSum: number;
  scoreCount: number;
  tierDistribution: Record<Tier, number>;
  recentQueries: Array<{
    addressMasked: string;
    score: number;
    tier: Tier;
    paid: boolean;
    at: string;
  }>;
}

const FRESH: StatsState = {
  totalQueries: 0,
  totalUsdcEarnedMicros: 0,
  uniqueAddresses: [],
  scoreSum: 0,
  scoreCount: 0,
  tierDistribution: { BLOCKED: 0, LOW: 0, MEDIUM: 0, HIGH: 0, HIGH_ELITE: 0 },
  recentQueries: [],
};

function activeFile(): string {
  try {
    if (!fs.existsSync(STATS_DIR)) {
      fs.mkdirSync(STATS_DIR, { recursive: true });
    }
    // probe write access
    fs.accessSync(STATS_DIR, fs.constants.W_OK);
    return STATS_FILE;
  } catch {
    return FALLBACK_FILE;
  }
}

let state: StatsState = load();

function load(): StatsState {
  const file = activeFile();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StatsState>;
      return { ...FRESH, ...parsed, tierDistribution: { ...FRESH.tierDistribution, ...(parsed.tierDistribution || {}) } };
    }
  } catch (err) {
    console.error('[stats] load failed:', (err as Error).message);
  }
  return { ...FRESH, uniqueAddresses: [], recentQueries: [], tierDistribution: { ...FRESH.tierDistribution } };
}

function persist() {
  const file = activeFile();
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[stats] persist failed:', (err as Error).message);
  }
}

function maskAddress(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function recordQuery(opts: {
  address: string;
  score: number;
  tier: Tier;
  paid: boolean;
  amountUsdc: number;
}) {
  state.totalQueries += 1;
  if (opts.paid) {
    state.totalUsdcEarnedMicros += Math.round(opts.amountUsdc * 1_000_000);
  }
  const lower = opts.address.toLowerCase();
  if (!state.uniqueAddresses.includes(lower)) {
    state.uniqueAddresses.push(lower);
  }
  state.scoreSum += opts.score;
  state.scoreCount += 1;
  state.tierDistribution[opts.tier] = (state.tierDistribution[opts.tier] || 0) + 1;

  state.recentQueries.unshift({
    addressMasked: maskAddress(opts.address),
    score: opts.score,
    tier: opts.tier,
    paid: opts.paid,
    at: new Date().toISOString(),
  });
  if (state.recentQueries.length > 50) state.recentQueries.length = 50;

  persist();
}

export function publicStats() {
  const avg = state.scoreCount === 0 ? 0 : Math.round(state.scoreSum / state.scoreCount);
  return {
    totalQueries: state.totalQueries,
    totalUsdcEarned: (state.totalUsdcEarnedMicros / 1_000_000).toFixed(6),
    uniqueAddressesScored: state.uniqueAddresses.length,
    averageScore: avg,
    tierDistribution: state.tierDistribution,
    recentQueries: state.recentQueries.slice(0, 10),
  };
}
