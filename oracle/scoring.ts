import { createPublicClient, http, formatUnits, getAddress } from 'viem';
import axios from 'axios';

const ARC_RPC_URL = process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const ARCSCAN_API_URL = process.env.ARCSCAN_API_URL || 'https://testnet.arcscan.app';
const USDC_ADDRESS = (process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000') as `0x${string}`;

export const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
    public: { http: [ARC_RPC_URL] },
  },
} as const;

export const publicClient = createPublicClient({
  chain: arcTestnet as any,
  transport: http(ARC_RPC_URL),
});

const ERC20_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export type Tier = 'BLOCKED' | 'LOW' | 'MEDIUM' | 'HIGH' | 'HIGH_ELITE';
export type Recommendation = 'BLOCKED' | 'TIME_LOCKED' | 'INSTANT' | 'INSTANT_PRIORITY';

export interface ScoreBreakdown {
  txPoints: number;
  usdcPoints: number;
  contractPoints: number;
  deploymentPoints: number;
  txCount: number;
  usdcBalance: number;
  contractInteractions: number;
  deployments: number;
}

export interface ScoreResult {
  address: string;
  score: number;
  tier: Tier;
  recommendation: Recommendation;
  breakdown: ScoreBreakdown;
  queriedAt: string;
  network: string;
  chainId: number;
  source: string;
  docs: string;
}

function tierFor(score: number): Tier {
  if (score === 0) return 'BLOCKED';
  if (score < 40) return 'LOW';
  if (score < 75) return 'MEDIUM';
  if (score < 90) return 'HIGH';
  return 'HIGH_ELITE';
}

function recommendationFor(score: number): Recommendation {
  if (score === 0) return 'BLOCKED';
  if (score < 75) return 'TIME_LOCKED';
  if (score < 90) return 'INSTANT';
  return 'INSTANT_PRIORITY';
}

function txPointsFor(txCount: number): number {
  if (txCount === 0) return 0;
  if (txCount <= 10) return 20;
  if (txCount <= 30) return 40;
  if (txCount <= 60) return 60;
  if (txCount <= 100) return 75;
  return 85;
}

function contractPointsFor(interactions: number): number {
  if (interactions >= 100) return 15;
  if (interactions >= 10) return 7;
  if (interactions >= 3) return 5;
  return 0;
}

async function fetchTxCount(address: `0x${string}`): Promise<number> {
  try {
    const count = await publicClient.getTransactionCount({ address });
    return Number(count);
  } catch (err) {
    console.error(`[scoring] tx count fetch failed for ${address}:`, (err as Error).message);
    return 0;
  }
}

async function fetchUsdcBalance(address: `0x${string}`): Promise<number> {
  try {
    const raw = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
    return Number(formatUnits(raw as bigint, 6));
  } catch (err) {
    console.error(`[scoring] usdc balance fetch failed for ${address}:`, (err as Error).message);
    return 0;
  }
}

interface ArcscanTx {
  to?: { hash?: string } | null;
  from?: { hash?: string } | null;
  tx_types?: string[];
  method?: string | null;
  created_contract?: { hash?: string } | null;
}

async function fetchContractActivity(
  address: `0x${string}`
): Promise<{ contractInteractions: number; deployments: number }> {
  try {
    const url = `${ARCSCAN_API_URL}/api/v2/addresses/${address}/transactions?filter=from`;
    const res = await axios.get<{ items?: ArcscanTx[] }>(url, { timeout: 8000 });
    const items = res.data?.items ?? [];

    let contractInteractions = 0;
    let deployments = 0;
    for (const tx of items) {
      if (tx.created_contract?.hash) {
        deployments += 1;
        continue;
      }
      const isContractCall =
        (tx.tx_types && tx.tx_types.includes('contract_call')) ||
        (tx.method && tx.method.length > 0);
      if (isContractCall) contractInteractions += 1;
    }
    return { contractInteractions, deployments };
  } catch (err) {
    console.error(`[scoring] arcscan fetch failed for ${address}:`, (err as Error).message);
    return { contractInteractions: 0, deployments: 0 };
  }
}

export async function scoreAddress(rawAddress: string): Promise<ScoreResult> {
  const address = getAddress(rawAddress) as `0x${string}`;

  const [txCount, usdcBalance, contractActivity] = await Promise.all([
    fetchTxCount(address),
    fetchUsdcBalance(address),
    fetchContractActivity(address),
  ]);

  const { contractInteractions, deployments } = contractActivity;

  const txPoints = txPointsFor(txCount);
  const usdcPoints = usdcBalance > 100 ? 5 : 0;
  const contractPoints = contractPointsFor(contractInteractions);
  const deploymentPoints = deployments >= 1 ? 10 : 0;

  let score = txPoints + usdcPoints + contractPoints + deploymentPoints;

  // Hard cap 97 unless contractInteractions >= 100
  if (contractInteractions < 100 && score > 97) score = 97;
  if (score > 100) score = 100;
  if (txCount === 0) score = 0;

  return {
    address,
    score,
    tier: tierFor(score),
    recommendation: recommendationFor(score),
    breakdown: {
      txPoints,
      usdcPoints,
      contractPoints,
      deploymentPoints,
      txCount,
      usdcBalance: Number(usdcBalance.toFixed(4)),
      contractInteractions,
      deployments,
    },
    queriedAt: new Date().toISOString(),
    network: 'Arc Testnet',
    chainId: 5042002,
    source: 'TrustGate Oracle v1',
    docs: 'https://trustgated.vercel.app/docs/oracle',
  };
}
