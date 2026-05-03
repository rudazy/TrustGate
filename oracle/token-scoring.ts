import axios from 'axios';
import { getAddress } from 'viem';
import { publicClient, scoreAddress, ScoreResult, Tier } from './scoring';

const ARCSCAN_API_URL = process.env.ARCSCAN_API_URL || 'https://testnet.arcscan.app';

// Top N holders to score against the wallet oracle. Capping at 100 keeps
// us under Arcscan's rate limit even at 1hr refresh for a hot token.
const HOLDER_ANALYSIS_CAP = 100;

// Bot detection: if 80%+ of buyers purchased within the same 3hr window,
// flag and reduce their weight to 10%.
const BOT_WINDOW_MS = 3 * 60 * 60 * 1000;
const BOT_THRESHOLD = 0.8;
const BOT_PENALTY = 0.1;

// Per-tier weight for purchased holders (BLOCKED ignored)
const BUYER_WEIGHTS: Record<Tier, number> = {
  BLOCKED: 0,
  LOW: 1,
  MEDIUM: 4,
  HIGH: 7,
  HIGH_ELITE: 10,
};

// Optional DEX whitelist — if set, only these count as "purchase sources".
// If unset, fall back to the heuristic (any contract sender = DEX).
const DEX_WHITELIST: Set<string> = new Set(
  (process.env.KNOWN_DEX_ADDRESSES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

interface ArcscanHolder {
  address: { hash: string };
  value: string; // balance as string (token wei)
}

interface ArcscanTransfer {
  from: { hash: string };
  to: { hash: string };
  total: { value: string; decimals?: string };
  timestamp: string;
  block_number: number;
  transaction_hash: string;
}

interface ArcscanTokenInfo {
  address: string;
  total_supply: string;
  decimals: string;
  type: string;
  holders?: string;
  symbol?: string;
}

export type TokenTier = 'BLOCKED' | 'LOW' | 'MEDIUM' | 'HIGH' | 'HIGH_ELITE';
export type Trend = 'rising' | 'stable' | 'falling';

export interface TokenScoreResult {
  address: string;
  score: number;
  tier: TokenTier;
  trend: Trend;
  last_updated: string;
  next_refresh: string;
}

// ----- helpers -----

async function fetchTokenInfo(address: string): Promise<ArcscanTokenInfo | null> {
  try {
    const url = `${ARCSCAN_API_URL}/api/v2/tokens/${address}`;
    const res = await axios.get<ArcscanTokenInfo>(url, { timeout: 8000 });
    return res.data;
  } catch (err) {
    console.error(`[token-scoring] token info failed: ${(err as Error).message}`);
    return null;
  }
}

async function fetchHolders(address: string): Promise<ArcscanHolder[]> {
  try {
    const url = `${ARCSCAN_API_URL}/api/v2/tokens/${address}/holders`;
    const res = await axios.get<{ items?: ArcscanHolder[] }>(url, { timeout: 10_000 });
    return res.data.items || [];
  } catch (err) {
    console.error(`[token-scoring] holders fetch failed: ${(err as Error).message}`);
    return [];
  }
}

async function fetchAllTransfers(address: string, maxPages = 5): Promise<ArcscanTransfer[]> {
  const out: ArcscanTransfer[] = [];
  let nextParams = '';
  for (let page = 0; page < maxPages; page++) {
    try {
      const url: string = `${ARCSCAN_API_URL}/api/v2/tokens/${address}/transfers${nextParams ? `?${nextParams}` : ''}`;
      const res = await axios.get<{ items?: ArcscanTransfer[]; next_page_params?: Record<string, unknown> }>(
        url,
        { timeout: 10_000 }
      );
      const items = res.data.items || [];
      out.push(...items);
      const np = res.data.next_page_params;
      if (!np || items.length === 0) break;
      const tuples: [string, string][] = Object.entries(np).map(([k, v]) => [k, String(v)]);
      nextParams = new URLSearchParams(tuples).toString();
    } catch (err) {
      console.error(`[token-scoring] transfers fetch failed: ${(err as Error).message}`);
      break;
    }
  }
  return out;
}

async function isContract(address: string): Promise<boolean> {
  try {
    const code = await publicClient.getCode({ address: address as `0x${string}` });
    return !!code && code !== '0x';
  } catch {
    return false;
  }
}

async function fetchDeployer(tokenAddress: string): Promise<string | null> {
  try {
    const url = `${ARCSCAN_API_URL}/api/v2/addresses/${tokenAddress}`;
    const res = await axios.get<{ creator_address_hash?: string; creation_tx_hash?: string }>(url, {
      timeout: 8000,
    });
    return res.data.creator_address_hash || null;
  } catch (err) {
    console.error(`[token-scoring] deployer fetch failed: ${(err as Error).message}`);
    return null;
  }
}

interface AddressCounters {
  transactionsCount: number;
  tokenTransfersCount: number;
}

async function fetchAddressCounters(address: string): Promise<AddressCounters> {
  try {
    const url = `${ARCSCAN_API_URL}/api/v2/addresses/${address}/counters`;
    const res = await axios.get<{
      transactions_count?: string | number;
      token_transfers_count?: string | number;
    }>(url, { timeout: 8000 });
    return {
      transactionsCount: Number(res.data.transactions_count || 0),
      tokenTransfersCount: Number(res.data.token_transfers_count || 0),
    };
  } catch (err) {
    console.error(`[token-scoring] counters fetch failed: ${(err as Error).message}`);
    return { transactionsCount: 0, tokenTransfersCount: 0 };
  }
}

// ----- core scoring -----

interface BuyerInfo {
  address: string;
  firstReceivedAt: number; // ms epoch
  firstSource: string;
  isPurchased: boolean;
}

async function classifyHolders(
  holders: ArcscanHolder[],
  transfers: ArcscanTransfer[],
  deployer: string | null,
  tokenAddress: string
): Promise<BuyerInfo[]> {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const deployerLower = deployer?.toLowerCase();
  const tokenLower = tokenAddress.toLowerCase();

  // Build first-received map: holder → earliest inbound transfer
  // Transfers are typically newest-first from Arcscan, so iterate and keep
  // the oldest seen per recipient.
  const firstIn: Map<string, ArcscanTransfer> = new Map();
  for (const tx of transfers) {
    const to = tx.to?.hash?.toLowerCase();
    if (!to) continue;
    const tsMs = new Date(tx.timestamp).getTime();
    if (Number.isNaN(tsMs)) continue;
    const existing = firstIn.get(to);
    if (!existing || tsMs < new Date(existing.timestamp).getTime()) {
      firstIn.set(to, tx);
    }
  }

  // For each top-N holder, classify
  const results: BuyerInfo[] = [];
  const topHolders = holders.slice(0, HOLDER_ANALYSIS_CAP);

  // Pre-collect unique senders we need to check is-contract for, dedupe to
  // minimize RPC calls.
  const sendersToProbe = new Set<string>();
  for (const h of topHolders) {
    const addr = h.address?.hash?.toLowerCase();
    if (!addr) continue;
    const tx = firstIn.get(addr);
    if (!tx) continue;
    const from = tx.from?.hash?.toLowerCase();
    if (!from) continue;
    if (from === ZERO) continue;
    if (from === deployerLower) continue;
    if (from === tokenLower) continue;
    if (DEX_WHITELIST.has(from)) continue;
    sendersToProbe.add(from);
  }

  const senderIsContract: Map<string, boolean> = new Map();
  // Run probes with bounded concurrency
  const probeList = Array.from(sendersToProbe);
  const CONCURRENCY = 8;
  for (let i = 0; i < probeList.length; i += CONCURRENCY) {
    const slice = probeList.slice(i, i + CONCURRENCY);
    const codes = await Promise.all(slice.map((a) => isContract(a)));
    slice.forEach((a, idx) => senderIsContract.set(a, codes[idx]));
  }

  for (const h of topHolders) {
    const addr = h.address?.hash?.toLowerCase();
    if (!addr) continue;
    const tx = firstIn.get(addr);
    if (!tx) {
      // No inbound transfer found in our window — skip (likely older than fetch range)
      continue;
    }
    const from = tx.from?.hash?.toLowerCase() || '';
    const tsMs = new Date(tx.timestamp).getTime();

    let isPurchased = false;
    if (from === ZERO || from === deployerLower) {
      // mint or deployer transfer — airdrop, not purchased
      isPurchased = false;
    } else if (DEX_WHITELIST.size > 0 && DEX_WHITELIST.has(from)) {
      isPurchased = true;
    } else if (DEX_WHITELIST.size === 0 && senderIsContract.get(from)) {
      // heuristic: contract sender = DEX
      isPurchased = true;
    } else {
      // EOA-to-EOA transfer — treat as purchase if from someone who isn't deployer/mint.
      // This catches OTC and casual transfers; safer to count than to ignore.
      isPurchased = true;
    }

    results.push({
      address: addr,
      firstReceivedAt: tsMs,
      firstSource: from,
      isPurchased,
    });
  }

  return results;
}

function detectCoordinatedBuying(buyers: BuyerInfo[]): boolean {
  const purchased = buyers.filter((b) => b.isPurchased);
  if (purchased.length < 5) return false; // too few to flag

  // Find the densest 3hr window using a sliding-window over sorted timestamps
  const times = purchased.map((b) => b.firstReceivedAt).sort((a, b) => a - b);
  let maxInWindow = 0;
  let left = 0;
  for (let right = 0; right < times.length; right++) {
    while (times[right] - times[left] > BOT_WINDOW_MS) left++;
    const inWin = right - left + 1;
    if (inWin > maxInWindow) maxInWindow = inWin;
  }

  return maxInWindow / purchased.length >= BOT_THRESHOLD;
}

interface ContractSignificance {
  multiplier: number; // 1.0 = neutral, up to 10x for systemically important contracts
  reason: string;
}

/**
 * Significance multiplier per spec:
 *   holder_count > 50    → 2x
 *   transactions > 500   → 3x
 *   transactions > 10000 → 10x
 *   max wins (these are tiers, not stackable). Hard cap 10x.
 *
 * USDC at 0x3600...0000 has thousands of holders and millions of txs, so it
 * hits the 10x tier unconditionally — independent of deployer (which is null
 * for system precompiles, handled separately in computeTokenScore).
 */
function contractSignificance(opts: {
  holderCount: number;
  transactionsCount: number;
}): ContractSignificance {
  const reasons: string[] = [];
  let mult = 1.0;

  if (opts.transactionsCount > 10_000) {
    mult = Math.max(mult, 10);
    reasons.push('tx>10000');
  }
  if (opts.transactionsCount > 500) {
    mult = Math.max(mult, 3);
    reasons.push('tx>500');
  }
  if (opts.holderCount > 50) {
    mult = Math.max(mult, 2);
    reasons.push('holders>50');
  }

  if (mult > 10) mult = 10;
  return { multiplier: mult, reason: reasons.join(',') || 'baseline' };
}

function tierFor(score: number): TokenTier {
  if (score === 0) return 'BLOCKED';
  if (score < 40) return 'LOW';
  if (score < 75) return 'MEDIUM';
  if (score < 90) return 'HIGH';
  return 'HIGH_ELITE';
}

export interface ComputedTokenScore {
  result: TokenScoreResult;
  // internal — not returned to API caller, used for trend on next refresh
  _internal: {
    rawBuyerScore: number;
    rawDeployerScore: number;
    botFlagged: boolean;
    holderCount: number;
    transferCount: number;
    transactionsCount: number;
    significanceMultiplier: number;
  };
}

export async function computeTokenScore(
  rawAddress: string,
  prevScore: number | null,
  nextRefreshAt: Date
): Promise<ComputedTokenScore> {
  const address = getAddress(rawAddress);

  const [info, holders, transfers, deployer, counters] = await Promise.all([
    fetchTokenInfo(address),
    fetchHolders(address),
    fetchAllTransfers(address),
    fetchDeployer(address),
    fetchAddressCounters(address),
  ]);

  // Authoritative holder count from token endpoint, fallback to fetched array
  const reportedHolderCount = Number(info?.holders || 0);
  const effectiveHolderCount = Math.max(reportedHolderCount, holders.length);

  const buyers = await classifyHolders(holders, transfers, deployer, address);
  const purchased = buyers.filter((b) => b.isPurchased);
  const botFlagged = detectCoordinatedBuying(buyers);

  // Score each purchased buyer against the wallet oracle, in parallel batches
  const buyerScores: Array<{ tier: Tier }> = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < purchased.length; i += CONCURRENCY) {
    const slice = purchased.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (b): Promise<ScoreResult | null> => {
        try {
          return await scoreAddress(b.address);
        } catch {
          return null;
        }
      })
    );
    for (const r of results) if (r) buyerScores.push({ tier: r.tier });
  }

  // Sum buyer weights (with bot penalty if flagged)
  let buyerPoints = 0;
  for (const b of buyerScores) {
    const w = BUYER_WEIGHTS[b.tier] || 0;
    buyerPoints += botFlagged ? w * BOT_PENALTY : w;
  }

  // Significance multiplier — driven by token's own onchain footprint
  const sig = contractSignificance({
    holderCount: effectiveHolderCount,
    transactionsCount: counters.transactionsCount,
  });

  // Deployer contribution. For system precompiles like native USDC at
  // 0x3600...0000, there is no deployer — but the contract's own footprint
  // is what makes it trustworthy. In that case, treat the contract itself as
  // a "deployer-equivalent" with a max-trust baseline, scaled by significance.
  let deployerPoints = 0;
  let usedDeployerFallback = false;
  if (deployer) {
    try {
      const ds = await scoreAddress(deployer);
      // Deployer contributes proportional to wallet score × significance.
      // 100-score deployer with 10x mult would maxout — clamped via final cap.
      deployerPoints = (ds.score / 100) * 30 * sig.multiplier;
    } catch (err) {
      console.error(`[token-scoring] deployer score failed: ${(err as Error).message}`);
    }
  } else if (sig.multiplier >= 3) {
    // No deployer (system contract / precompile / unindexed creation) but the
    // contract itself is significant. Use its significance as a trust signal.
    // Baseline = 30 pts × multiplier, capped naturally by the 0..100 final clamp.
    usedDeployerFallback = true;
    deployerPoints = 30 * sig.multiplier;
  }

  // Combine — clamp to 0..100
  let score = Math.round(buyerPoints + deployerPoints);
  if (score > 100) score = 100;
  if (score < 0) score = 0;
  // If no purchased holders at all and no deployer trust, hard zero
  if (purchased.length === 0 && deployerPoints === 0) score = 0;

  console.log(
    `[token-scoring] ${address} score=${score} buyers=${buyerPoints.toFixed(1)} ` +
      `deployer=${deployerPoints.toFixed(1)} sig=${sig.multiplier}x (${sig.reason})` +
      (usedDeployerFallback ? ' [precompile-fallback]' : '') +
      (botFlagged ? ' [bot-flagged]' : '')
  );

  // Trend
  let trend: Trend = 'stable';
  if (prevScore !== null) {
    const delta = score - prevScore;
    if (delta > 3) trend = 'rising';
    else if (delta < -3) trend = 'falling';
  }

  const now = new Date();
  return {
    result: {
      address,
      score,
      tier: tierFor(score),
      trend,
      last_updated: now.toISOString(),
      next_refresh: nextRefreshAt.toISOString(),
    },
    _internal: {
      rawBuyerScore: buyerPoints,
      rawDeployerScore: deployerPoints,
      botFlagged,
      holderCount: effectiveHolderCount,
      transferCount: transfers.length,
      transactionsCount: counters.transactionsCount,
      significanceMultiplier: sig.multiplier,
    },
  };
}

// Refresh schedule based on token age
export function refreshIntervalMs(tokenAgeMs: number): number {
  const day = 24 * 60 * 60 * 1000;
  if (tokenAgeMs < 7 * day) return 60 * 60 * 1000; // 1 hour
  if (tokenAgeMs < 30 * day) return 6 * 60 * 60 * 1000; // 6 hours
  if (tokenAgeMs < 90 * day) return 24 * 60 * 60 * 1000; // 24 hours
  return 72 * 60 * 60 * 1000; // 72 hours
}

export async function fetchTokenAgeMs(address: string): Promise<number> {
  try {
    const url = `${ARCSCAN_API_URL}/api/v2/addresses/${address}`;
    const res = await axios.get<{ creation_tx_hash?: string }>(url, { timeout: 8000 });
    if (!res.data.creation_tx_hash) return 0;
    const tx = await publicClient.getTransaction({
      hash: res.data.creation_tx_hash as `0x${string}`,
    });
    const block = await publicClient.getBlock({ blockNumber: tx.blockNumber });
    const ts = Number(block.timestamp) * 1000;
    return Date.now() - ts;
  } catch {
    return 0; // unknown — treat as fresh, 1hr refresh
  }
}
