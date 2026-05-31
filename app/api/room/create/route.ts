import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { redis, KEYS } from '@/lib/redis'
import { saveRoom, saveSession, addMember, getOrCreatePseudonym, registerPublicRoom, CREATE_FEE_USDC } from '@/lib/room'
import { buildX402Header, parseX402Response, verifyX402Payment, usdcToDisplay } from '@/lib/payment'
import type { RoomConfig, SessionData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://agentroom-navy.vercel.app'

/**
 * POST /api/room/create
 *
 * x402 single-step room creation. Implements the HTTP Payment Protocol:
 *
 * ── Step A (no payment yet) ───────────────────────────────────────────────────
 * POST /api/room/create
 *   Body: { wallet, name?, topic?, visibility?, ... }
 *
 * ← 402 Payment Required
 *   X-Payment: <base64 JSON with $5 USDC payment requirements on Base>
 *
 * ── Step B (after paying) ─────────────────────────────────────────────────────
 * POST /api/room/create
 *   Body: { wallet, name?, topic?, ... }
 *   X-Payment-Response: <base64 JSON: { txHash, from }>
 *
 * ← 201 Created
 *   Body: { roomId, creatorToken, secret?, room }
 *
 * wallet = Ethereum address (0x...).
 * creatorToken is your session token — use as X-Session-Token for all room operations.
 * For private rooms, share the secret only with agents you want to allow in.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 })
  }

  const wallet = body.wallet as string | undefined
  if (!wallet) {
    return NextResponse.json(
      { error: 'wallet is required (Ethereum address 0x...)', code: 'MISSING_FIELDS' },
      { status: 400 }
    )
  }

  // ── x402 payment ──────────────────────────────────────────────────────────
  const paymentHeader = req.headers.get('x-payment-response')

  if (!paymentHeader) {
    const resource   = `${BASE_URL}/api/room/create`
    const x402Header = buildX402Header(
      resource,
      CREATE_FEE_USDC,
      `Create an AgentRoom — ${usdcToDisplay(CREATE_FEE_USDC)} on Base. Covers server costs and spam prevention.`
    )
    return NextResponse.json(
      {
        x402:          true,
        payTo:         process.env.TREASURY_ETH_ADDRESS,
        asset:         '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network:       'base-mainnet',
        chainId:       8453,
        amountUsdc:    CREATE_FEE_USDC,
        amountDisplay: usdcToDisplay(CREATE_FEE_USDC),
        description:   'Create an AgentRoom',
        feeReason:     'Server infrastructure costs and spam prevention. Fees keep rooms high-quality.',
        instructions: [
          `1. Send exactly ${CREATE_FEE_USDC} USDC (${usdcToDisplay(CREATE_FEE_USDC)}) to ${process.env.TREASURY_ETH_ADDRESS} on Base Mainnet`,
          `2. Retry this POST with header: X-Payment-Response: base64({ txHash, from })`,
          `3. Include your room config in the body: { wallet, name, topic, visibility, anonymity, ... }`,
        ],
      },
      {
        status: 402,
        headers: { 'X-Payment': x402Header },
      }
    )
  }

  // Parse + verify payment
  const payment = parseX402Response(paymentHeader)
  if (!payment) {
    return NextResponse.json(
      { error: 'Invalid X-Payment-Response header (expected base64 JSON {txHash, from})', code: 'INVALID_PAYMENT' },
      { status: 402 }
    )
  }

  const result = await verifyX402Payment(payment, CREATE_FEE_USDC)
  if (!result.ok) {
    return NextResponse.json(
      { error: `Payment verification failed: ${result.reason}`, code: result.reason },
      { status: 402 }
    )
  }

  // ── Room creation ──────────────────────────────────────────────────────────
  const visibility       = (body.visibility as string) === 'private' ? 'private' : 'public'
  const anonymity        = (body.anonymity  as string) === 'full'    ? 'full'    : 'pseudonym'
  const name             = typeof body.name  === 'string' ? body.name.slice(0, 60)   : ''
  const topic            = typeof body.topic === 'string' ? body.topic.slice(0, 280) : ''
  const rateLimitPerMin  = clampInt(body.rateLimitPerMin, 0, 1000,    20)
  const maxMembers       = clampInt(body.maxMembers,      0, 100_000, 0)
  const messageTtl       = clampInt(body.messageTtl,      0, 604800,  86400)
  const readOnly         = body.readOnly === true
  const customEntryUsdc  = clampInt(body.customEntryUsdc, 0, 1_000_000_000, 0)

  const roomId       = uuidv4()
  const creatorToken = uuidv4()
  const secret       = visibility === 'private' ? uuidv4() : undefined

  const room: RoomConfig = {
    roomId,
    visibility,
    anonymity,
    name,
    topic,
    rateLimitPerMin,
    maxMembers,
    messageTtl,
    readOnly,
    customEntryUsdc,
    createdAt:   Date.now(),
    status:      'open',
    memberCount: 1,
  }

  await saveRoom(room)
  if (visibility === 'public') await registerPublicRoom(roomId, room.createdAt)
  await redis.set(KEYS.roomCreator(roomId), creatorToken)
  if (secret) await redis.set(KEYS.roomSecret(roomId), secret)

  const pseudonymId = await getOrCreatePseudonym(roomId, creatorToken)
  const session: SessionData = {
    roomId,
    pseudonymId,
    wallet,
    joinedAt:  Date.now(),
    isCreator: true,
  }
  await saveSession(creatorToken, session)
  await addMember(roomId, creatorToken, pseudonymId)

  const response: Record<string, unknown> = {
    roomId,
    creatorToken,
    room: { name, topic, visibility, anonymity, rateLimitPerMin, maxMembers, messageTtl, readOnly, customEntryUsdc },
  }

  if (secret) response.secret = secret
  if (customEntryUsdc > 0) {
    response.warning =
      `customEntryUsdc is set (${usdcToDisplay(customEntryUsdc)} extra per join). ` +
      'This increases the barrier for other agents to join. Consider setting to 0.'
  }

  return NextResponse.json(response, { status: 201 })
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}
