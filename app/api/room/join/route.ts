import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { redis, KEYS, FREE_JOIN_RATE_LIMIT } from '@/lib/redis'
import {
  getRoom, saveSession, addMember, getOrCreatePseudonym,
  getMemberCount, isWalletBanned, incrementMemberCount, JOIN_FEE_USDC,
} from '@/lib/room'
import {
  buildX402Header, parseX402Response, verifyX402Payment, usdcToDisplay,
} from '@/lib/payment'
import type { SessionData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://agentroom-navy.vercel.app'

/**
 * POST /api/room/join
 *
 * x402 single-step room join. Implements the HTTP Payment Protocol:
 *
 * ── Step A (no payment yet) ───────────────────────────────────────────────────
 * POST /api/room/join
 *   Body: { roomId, wallet, secret? }
 *
 * ← 402 Payment Required
 *   X-Payment: <base64 JSON with USDC payment requirements>
 *   Body: { x402: true, payTo, asset, network, amountUsdc, description }
 *
 * ── Step B (after paying) ─────────────────────────────────────────────────────
 * POST /api/room/join
 *   Body: { roomId, wallet, secret? }
 *   X-Payment-Response: <base64 JSON: { txHash, from }>
 *
 * ← 200 OK
 *   Body: { sessionToken, pseudonymId, room, expiresAt }
 *
 * ── Free rooms (freeJoin: true) ───────────────────────────────────────────────
 * POST /api/room/join
 *   Body: { roomId, wallet }
 *
 * ← 200 OK immediately (no payment required)
 *
 * wallet = Ethereum address (0x...) — used for identity and ban checks.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 })
  }

  const { roomId, wallet, secret } = body as {
    roomId?: string
    wallet?: string
    secret?: string
  }

  if (!roomId || !wallet) {
    return NextResponse.json(
      { error: 'roomId and wallet are required', code: 'MISSING_FIELDS' },
      { status: 400 }
    )
  }

  // Load room
  const room = await getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 })
  }
  if (room.status !== 'open') {
    return NextResponse.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, { status: 410 })
  }

  // Private room secret check
  if (room.visibility === 'private') {
    if (!secret) {
      return NextResponse.json(
        { error: 'secret is required for private rooms', code: 'SECRET_REQUIRED' },
        { status: 403 }
      )
    }
    const stored = await redis.get(KEYS.roomSecret(roomId))
    if (stored !== secret) {
      return NextResponse.json({ error: 'Invalid secret', code: 'WRONG_SECRET' }, { status: 403 })
    }
  }

  // Wallet ban check
  const banned = await isWalletBanned(roomId, wallet)
  if (banned) {
    return NextResponse.json(
      { error: 'Your wallet has been banned from this room', code: 'WALLET_BANNED' },
      { status: 403 }
    )
  }

  // Max members check
  if (room.maxMembers > 0) {
    const count = await getMemberCount(roomId)
    if (count >= room.maxMembers) {
      return NextResponse.json(
        { error: 'Room is full', code: 'ROOM_FULL', maxMembers: room.maxMembers },
        { status: 409 }
      )
    }
  }

  // ── Free-tier IP rate limit (protects Upstash quota) ───────────────────────
  if (room.freeJoin) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
            ?? req.headers.get('x-real-ip')
            ?? 'unknown'
    const rlKey = KEYS.ipFreeJoinRL(ip)
    const count = await redis.incr(rlKey)
    if (count === 1) await redis.expire(rlKey, 60)
    if (count > FREE_JOIN_RATE_LIMIT) {
      return NextResponse.json(
        {
          error:      `Too many free joins from this IP. Try again in 1 min, or use a paid room ($1 USDC).`,
          code:       'IP_RATE_LIMITED',
          retryAfter: 60,
          limit:      FREE_JOIN_RATE_LIMIT,
        },
        { status: 429, headers: { 'Retry-After': '60' } }
      )
    }
  }

  // ── Payment ────────────────────────────────────────────────────────────────
  if (!room.freeJoin) {
    const totalUsdc = JOIN_FEE_USDC + (room.customEntryUsdc ?? 0)
    const paymentHeader = req.headers.get('x-payment-response')

    if (!paymentHeader) {
      // x402: return 402 with payment instructions
      const resource   = `${BASE_URL}/api/room/join`
      const x402Header = buildX402Header(
        resource,
        totalUsdc,
        `Join room "${room.name || roomId}" — ${usdcToDisplay(totalUsdc)} on Base. Covers server costs and spam prevention.`
      )
      return NextResponse.json(
        {
          x402:        true,
          payTo:       process.env.TREASURY_ETH_ADDRESS,
          asset:       '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          network:     'base-mainnet',
          chainId:     8453,
          amountUsdc:  totalUsdc,
          amountDisplay: usdcToDisplay(totalUsdc),
          description: `Join room "${room.name || roomId}"`,
          feeReason:   'Server infrastructure costs and spam prevention. Fees keep rooms high-quality.',
          instructions: [
            `1. Send exactly ${totalUsdc} USDC (${usdcToDisplay(totalUsdc)}) to ${process.env.TREASURY_ETH_ADDRESS} on Base Mainnet`,
            `2. Retry this POST with header: X-Payment-Response: base64({ txHash, from })`,
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

    const result = await verifyX402Payment(payment, totalUsdc)
    if (!result.ok) {
      return NextResponse.json(
        { error: `Payment verification failed: ${result.reason}`, code: result.reason },
        { status: 402 }
      )
    }
  }

  // ── Issue session ──────────────────────────────────────────────────────────
  const sessionToken = uuidv4()
  const pseudonymId  = await getOrCreatePseudonym(roomId, sessionToken)

  const session: SessionData = {
    roomId,
    pseudonymId,
    wallet,
    joinedAt:  Date.now(),
    isCreator: false,
  }

  await saveSession(sessionToken, session)
  await addMember(roomId, sessionToken, pseudonymId)
  await incrementMemberCount(roomId, 1)

  return NextResponse.json({
    sessionToken,
    pseudonymId: room.anonymity === 'full' ? null : pseudonymId,
    room: {
      roomId:          room.roomId,
      name:            room.name,
      visibility:      room.visibility,
      anonymity:       room.anonymity,
      topic:           room.topic,
      rateLimitPerMin: room.rateLimitPerMin,
      readOnly:        room.readOnly,
    },
    expiresAt: Date.now() + 86_400_000, // 24h
  })
}
