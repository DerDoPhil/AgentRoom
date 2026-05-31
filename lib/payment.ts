/**
 * AgentRoom — x402 Payment Verification
 *
 * Implements the x402 HTTP Payment Protocol for Ethereum/Base (USDC).
 *
 * Flow:
 *   1. Agent POSTs to a paid endpoint (no X-Payment-Response header)
 *   2. Server returns HTTP 402 with X-Payment header (JSON, base64)
 *   3. Agent sends exactly JOIN_FEE_USDC to TREASURY_ETH_ADDRESS on Base
 *   4. Agent retries the same POST with X-Payment-Response header (txHash + from)
 *   5. Server verifies on-chain → issues session token
 *
 * Payment asset:  USDC on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
 * Network:        Base Mainnet (chainId 8453)
 * Treasury:       TREASURY_ETH_ADDRESS env var
 */

import { redis, TTL } from './redis'

const BASE_RPC_URL      = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'
const TREASURY_ADDRESS  = (process.env.TREASURY_ETH_ADDRESS ?? '').toLowerCase()

/** USDC on Base — 6 decimals */
export const USDC_BASE  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** $1 in USDC (6 decimals) */
export const JOIN_FEE_USDC   = 1_000_000

/** $5 in USDC (6 decimals) */
export const CREATE_FEE_USDC = 5_000_000

/** ERC-20 Transfer event topic */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** Max age of payment TX in seconds (5 minutes) */
const MAX_TX_AGE_SEC = 300

// ─── Types ────────────────────────────────────────────────────────────────────

export interface X402PaymentResponse {
  txHash: string   // Ethereum TX hash of the USDC transfer on Base
  from:   string   // Ethereum address that sent the payment
}

export interface VerifyResult {
  ok:     boolean
  reason?: string
}

// ─── x402 response builder ───────────────────────────────────────────────────

/**
 * Build the X-Payment header value (JSON, then base64-encoded).
 * Conforms to x402 spec: server returns this on HTTP 402.
 */
export function buildX402Header(
  resource:    string,
  amountUsdc:  number,
  description: string
): string {
  const payload = {
    version: '1',
    accepts: [{
      scheme:             'exact',
      network:            'base-mainnet',
      maxAmountRequired:  String(amountUsdc),
      resource,
      description,
      mimeType:           'application/json',
      payTo:              TREASURY_ADDRESS,
      maxTimeoutSeconds:  MAX_TX_AGE_SEC,
      asset:              USDC_BASE,
      extra: {
        decimals:  6,
        symbol:    'USDC',
        chainId:   8453,
        feeReason: 'Server infrastructure costs and spam prevention. Fees keep rooms high-quality.',
      },
    }],
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

/**
 * Parse the X-Payment-Response header sent by the agent after paying.
 * Format: base64-encoded JSON { txHash, from }
 */
export function parseX402Response(header: string | null): X402PaymentResponse | null {
  if (!header) return null
  try {
    const json = Buffer.from(header, 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    if (!parsed?.txHash || !parsed?.from) return null
    return parsed as X402PaymentResponse
  } catch {
    return null
  }
}

// ─── On-chain verification ───────────────────────────────────────────────────

/**
 * Verify a USDC payment on Base via JSON-RPC (no ethers.js dependency).
 *
 * Checks:
 *   1. TX hash not already used (replay protection via Redis)
 *   2. TX exists and succeeded on Base
 *   3. TX block timestamp is within MAX_TX_AGE_SEC
 *   4. TX includes a USDC Transfer event sending ≥ requiredUsdc to our treasury
 */
export async function verifyX402Payment(
  payment:      X402PaymentResponse,
  requiredUsdc: number
): Promise<VerifyResult> {
  const txHash = payment.txHash.toLowerCase()

  // 1. Replay protection
  const usedKey = `x402:used:${txHash}`
  const alreadyUsed = await redis.exists(usedKey)
  if (alreadyUsed) return { ok: false, reason: 'TX_ALREADY_USED' }

  // 2. Fetch TX receipt via Base JSON-RPC
  let receipt: BaseReceipt | null
  try {
    receipt = await rpcCall<BaseReceipt | null>('eth_getTransactionReceipt', [payment.txHash])
  } catch {
    return { ok: false, reason: 'RPC_ERROR' }
  }

  if (!receipt) return { ok: false, reason: 'TX_NOT_FOUND' }
  if (receipt.status !== '0x1') return { ok: false, reason: 'TX_FAILED' }

  // 3. Check TX recency via block timestamp
  let block: BaseBlock | null
  try {
    block = await rpcCall<BaseBlock | null>('eth_getBlockByHash', [receipt.blockHash, false])
  } catch {
    return { ok: false, reason: 'RPC_ERROR' }
  }

  if (!block) return { ok: false, reason: 'BLOCK_NOT_FOUND' }
  const blockTimeSec = parseInt(block.timestamp, 16)
  const ageSec = Date.now() / 1000 - blockTimeSec
  if (ageSec > MAX_TX_AGE_SEC) {
    return { ok: false, reason: `TX_EXPIRED: ${Math.round(ageSec)}s ago (max ${MAX_TX_AGE_SEC}s)` }
  }

  // 4. Parse ERC-20 Transfer logs for USDC → treasury
  const treasuryPadded = '0x' + TREASURY_ADDRESS.replace('0x', '').padStart(64, '0')
  const usdcAddress    = USDC_BASE.toLowerCase()

  let received = BigInt(0)
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase()  === usdcAddress &&
      log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      log.topics[2]?.toLowerCase() === treasuryPadded.toLowerCase()
    ) {
      received += BigInt(log.data)
    }
  }

  if (received < BigInt(requiredUsdc)) {
    return {
      ok:     false,
      reason: `INSUFFICIENT_PAYMENT: received ${received} USDC-units, need ${requiredUsdc}`,
    }
  }

  // 5. Mark as used (7-day TTL — enough to prevent replay within any reasonable window)
  await redis.set(usedKey, '1', { ex: TTL.usedPayment })

  return { ok: true }
}

// ─── JSON-RPC helpers (no ethers dependency) ─────────────────────────────────

interface BaseReceipt {
  status:    string       // '0x1' = success
  blockHash: string
  logs:      BaseLog[]
}

interface BaseLog {
  address: string
  topics:  string[]
  data:    string
}

interface BaseBlock {
  timestamp: string  // hex
}

let rpcId = 0
async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(BASE_RPC_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method, params, id: ++rpcId }),
  })
  const json = await res.json() as { result: T; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  return json.result
}

// ─── Human-readable helpers ───────────────────────────────────────────────────

export function usdcToDisplay(units: number): string {
  return `$${(units / 1_000_000).toFixed(2)} USDC`
}
