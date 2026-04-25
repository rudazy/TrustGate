import { publicClient } from './scoring';
import { parseUnits, decodeEventLog, getAddress } from 'viem';

/**
 * x402-compatible payment verification for Arc testnet.
 *
 * The public x402 facilitator does not support Arc testnet (chain 5042002),
 * so we verify payments directly on-chain by inspecting the USDC Transfer
 * event in the user-supplied tx hash.
 *
 * Header format (base64-encoded JSON):
 *   X-Payment: base64({
 *     "scheme": "exact",
 *     "network": "arc-testnet",
 *     "txHash": "0x...",
 *     "from": "0x...",
 *     "amount": "0.001",
 *     "nonce": "uuid-or-random"
 *   })
 *
 * The same txHash + nonce can never be reused.
 */

const USDC_ADDRESS = (process.env.USDC_ADDRESS ||
  '0x3600000000000000000000000000000000000000') as `0x${string}`;
const RECIPIENT = (process.env.TRUSTGATE_CONTRACT ||
  '0x52E17bC482d00776d73811680CbA9914e83E33CC') as `0x${string}`;

const TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
  ],
} as const;

// In-memory replay protection. For a multi-instance Railway deployment this
// would move to Redis, but a single instance on Railway's free/hobby tier
// is fine for the demo.
const usedTxHashes = new Set<string>();
const usedNonces = new Set<string>();

export interface PaymentRequirement {
  amount: string;
  currency: 'USDC';
  network: 'Arc Testnet';
  chainId: 5042002;
  recipient: string;
  paymentStandard: 'x402';
  description: string;
}

export interface PaymentReceipt {
  ok: true;
  txHash: string;
  from: string;
  amountUsdc: number;
}

export interface PaymentRejection {
  ok: false;
  reason: string;
}

export type VerifyResult = PaymentReceipt | PaymentRejection;

interface PaymentHeader {
  scheme?: string;
  network?: string;
  txHash?: string;
  from?: string;
  amount?: string;
  nonce?: string;
}

function decodeHeader(headerValue: string): PaymentHeader | null {
  try {
    const json = Buffer.from(headerValue, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function paymentRequirement(amountUsdc: string, description: string): PaymentRequirement {
  return {
    amount: amountUsdc,
    currency: 'USDC',
    network: 'Arc Testnet',
    chainId: 5042002,
    recipient: RECIPIENT,
    paymentStandard: 'x402',
    description,
  };
}

export async function verifyPayment(
  headerValue: string | undefined,
  expectedAmountUsdc: string
): Promise<VerifyResult> {
  if (!headerValue) return { ok: false, reason: 'missing X-Payment header' };

  const header = decodeHeader(headerValue);
  if (!header) return { ok: false, reason: 'malformed X-Payment header (expected base64 JSON)' };

  if (!header.txHash || !header.nonce || !header.from) {
    return { ok: false, reason: 'X-Payment header missing required fields: txHash, nonce, from' };
  }
  if (header.network !== 'arc-testnet') {
    return { ok: false, reason: `unsupported network: ${header.network}` };
  }

  if (usedTxHashes.has(header.txHash.toLowerCase())) {
    return { ok: false, reason: 'tx hash already used (replay)' };
  }
  if (usedNonces.has(header.nonce)) {
    return { ok: false, reason: 'nonce already used (replay)' };
  }

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({
      hash: header.txHash as `0x${string}`,
    });
  } catch (err) {
    return { ok: false, reason: `tx not found on Arc: ${(err as Error).message}` };
  }

  if (receipt.status !== 'success') {
    return { ok: false, reason: 'payment tx reverted' };
  }

  const expectedRaw = parseUnits(expectedAmountUsdc, 6);
  let matched = false;
  let actualFrom = '';
  let actualValue = 0n;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== 'Transfer') continue;
      const args = decoded.args as { from: string; to: string; value: bigint };
      if (args.to.toLowerCase() !== RECIPIENT.toLowerCase()) continue;
      if (args.value < expectedRaw) continue;
      matched = true;
      actualFrom = args.from;
      actualValue = args.value;
      break;
    } catch {
      // not a Transfer event, ignore
    }
  }

  if (!matched) {
    return {
      ok: false,
      reason: `no USDC transfer of >= ${expectedAmountUsdc} to ${RECIPIENT} found in tx`,
    };
  }

  // Optional: confirm declared `from` matches the on-chain sender
  try {
    const declaredFrom = getAddress(header.from);
    const onChainFrom = getAddress(actualFrom);
    if (declaredFrom !== onChainFrom) {
      return { ok: false, reason: 'declared from address does not match on-chain transfer' };
    }
  } catch {
    return { ok: false, reason: 'invalid from address' };
  }

  // Mark replay-protection state only after all checks pass
  usedTxHashes.add(header.txHash.toLowerCase());
  usedNonces.add(header.nonce);

  return {
    ok: true,
    txHash: header.txHash,
    from: actualFrom,
    amountUsdc: Number(actualValue) / 1e6,
  };
}
