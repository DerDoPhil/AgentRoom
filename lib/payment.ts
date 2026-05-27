import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { redis, KEYS, TTL } from './redis'
import type { PendingPayment } from './types'

const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const TREASURY_WALLET = process.env.TREASURY_WALLET!

export function getConnection(): Connection {
  return new Connection(RPC_URL, 'confirmed')
}

// ─── Pending payment lifecycle ────────────────────────────────────────────────

export async function createPendingPayment(
  nonce: string,
  roomId: string,
  wallet: string,
  lamports: number
): Promise<PendingPayment> {
  const pending: PendingPayment = {
    nonce,
    roomId,
    wallet,
    lamports,
    expiresAt: Date.now() + TTL.pendingPayment * 1000,
  }
  await redis.hset(KEYS.pendingPayment(nonce), {
    nonce,
    roomId,
    wallet,
    lamports: String(lamports),
    expiresAt: String(pending.expiresAt),
  })
  await redis.expire(KEYS.pendingPayment(nonce), TTL.pendingPayment)
  return pending
}

export async function getPendingPayment(nonce: string): Promise<PendingPayment | null> {
  const data = await redis.hgetall(KEYS.pendingPayment(nonce))
  if (!data || Object.keys(data).length === 0) return null
  return {
    nonce: data.nonce as string,
    roomId: data.roomId as string,
    wallet: data.wallet as string,
    lamports: Number(data.lamports),
    expiresAt: Number(data.expiresAt),
  }
}

export async function consumePendingPayment(nonce: string): Promise<void> {
  await redis.del(KEYS.pendingPayment(nonce))
}

// ─── On-chain verification ────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean
  reason?: string
}

/**
 * Verifies that a transaction:
 * 1. Exists and is confirmed
 * 2. Transfers at least `expectedLamports` to TREASURY_WALLET
 * 3. Originated from `expectedWallet`
 * 4. Has not been used before (dedup)
 */
export async function verifyPaymentTx(
  txSig: string,
  expectedWallet: string,
  expectedLamports: number
): Promise<VerifyResult> {
  // Dedup check first (fast, no RPC needed)
  const usedKey = KEYS.usedPayment(txSig)
  const alreadyUsed = await redis.get(usedKey)
  if (alreadyUsed) return { ok: false, reason: 'TX_ALREADY_USED' }

  const conn = getConnection()

  let tx
  try {
    tx = await conn.getParsedTransaction(txSig, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
  } catch {
    return { ok: false, reason: 'RPC_ERROR' }
  }

  if (!tx) return { ok: false, reason: 'TX_NOT_FOUND' }
  if (tx.meta?.err) return { ok: false, reason: 'TX_FAILED' }

  // Check sender
  const accounts = tx.transaction.message.accountKeys
  const senderPubkey = accounts[0]?.pubkey?.toBase58?.() ?? accounts[0]?.toString?.()
  if (senderPubkey !== expectedWallet) {
    return { ok: false, reason: 'WRONG_SENDER' }
  }

  // Check SOL transfer to treasury
  const treasuryIdx = accounts.findIndex(
    (a) => (a.pubkey?.toBase58?.() ?? a.toString?.()) === TREASURY_WALLET
  )
  if (treasuryIdx === -1) return { ok: false, reason: 'TREASURY_NOT_IN_TX' }

  const preBal = tx.meta!.preBalances[treasuryIdx]
  const postBal = tx.meta!.postBalances[treasuryIdx]
  const received = postBal - preBal

  if (received < expectedLamports) {
    return {
      ok: false,
      reason: `INSUFFICIENT_PAYMENT: got ${received} lamports, need ${expectedLamports}`,
    }
  }

  // Mark as used
  await redis.set(usedKey, '1', { ex: TTL.usedPayment })

  return { ok: true }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function lamportsToSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6)
}
