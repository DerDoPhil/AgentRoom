import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { getRoom, saveSession, addMember, getOrCreatePseudonym, getMemberCount, isWalletBanned, incrementMemberCount } from '@/lib/room'
import { getPendingPayment, consumePendingPayment, verifyPaymentTx, claimNonce } from '@/lib/payment'
import type { SessionData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/room/join/confirm
 *
 * Confirms payment and issues a session token for the room.
 *
 * Body:
 * {
 *   nonce: string    // from /join/init response
 *   txSig: string    // Solana transaction signature
 *   roomId: string
 *   wallet: string
 * }
 *
 * Response 200:
 * {
 *   sessionToken: string  // use as X-Session-Token for all room operations
 *   pseudonymId: string   // your identity in this room (null if anonymity=full)
 *   room: { roomId, visibility, anonymity, topic, rateLimitPerMin, readOnly }
 *   expiresAt: number     // unix ms — session expiry (24h from now)
 * }
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 })
  }

  const { nonce, txSig, roomId, wallet } = body as {
    nonce?: string
    txSig?: string
    roomId?: string
    wallet?: string
  }

  if (!nonce || !txSig || !roomId || !wallet) {
    return NextResponse.json(
      { error: 'nonce, txSig, roomId and wallet are required', code: 'MISSING_FIELDS' },
      { status: 400 }
    )
  }

  // Load and validate pending payment
  const pending = await getPendingPayment(nonce)
  if (!pending) {
    return NextResponse.json(
      { error: 'Nonce not found or expired (10 min limit)', code: 'NONCE_EXPIRED' },
      { status: 400 }
    )
  }
  if (pending.roomId !== roomId || pending.wallet !== wallet) {
    return NextResponse.json(
      { error: 'Nonce mismatch — roomId or wallet does not match init request', code: 'NONCE_MISMATCH' },
      { status: 400 }
    )
  }
  if (Date.now() > pending.expiresAt) {
    return NextResponse.json(
      { error: 'Payment window expired', code: 'PAYMENT_EXPIRED' },
      { status: 400 }
    )
  }

  // Verify room still exists and is open
  const room = await getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 })
  }
  if (room.status !== 'open') {
    return NextResponse.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, { status: 410 })
  }

  // Max members re-check (race condition guard)
  if (room.maxMembers > 0) {
    const count = await getMemberCount(roomId)
    if (count >= room.maxMembers) {
      return NextResponse.json(
        { error: 'Room filled up while payment was pending', code: 'ROOM_FULL' },
        { status: 409 }
      )
    }
  }

  // Bug 4 fix: wallet-level ban — second gate in case init was bypassed
  const walletBanned = await isWalletBanned(roomId, wallet)
  if (walletBanned) {
    return NextResponse.json(
      { error: 'Your wallet has been banned from this room', code: 'WALLET_BANNED' },
      { status: 403 }
    )
  }

  // Bug 2 fix: TOCTOU — atomically claim the nonce before any expensive work.
  // Prevents two concurrent requests with the same nonce both succeeding.
  const claimed = await claimNonce(nonce)
  if (!claimed) {
    return NextResponse.json(
      { error: 'This nonce is already being processed', code: 'NONCE_IN_USE' },
      { status: 409 }
    )
  }

  // Verify on-chain payment
  const result = await verifyPaymentTx(txSig, wallet, pending.lamports)
  if (!result.ok) {
    return NextResponse.json(
      { error: `Payment verification failed: ${result.reason}`, code: result.reason },
      { status: 402 }
    )
  }

  // Consume nonce (single-use)
  await consumePendingPayment(nonce)

  // Create session
  const sessionToken = uuidv4()
  const pseudonymId = await getOrCreatePseudonym(roomId, sessionToken)

  const session: SessionData = {
    roomId,
    pseudonymId,
    wallet,
    joinedAt: Date.now(),
    isCreator: false,
  }

  await saveSession(sessionToken, session)
  await addMember(roomId, sessionToken, pseudonymId)
  // Bug 1 fix: keep memberCount in sync with actual members hash
  await incrementMemberCount(roomId, 1)

  return NextResponse.json({
    sessionToken,
    pseudonymId: room.anonymity === 'full' ? null : pseudonymId,
    room: {
      roomId: room.roomId,
      visibility: room.visibility,
      anonymity: room.anonymity,
      topic: room.topic,
      rateLimitPerMin: room.rateLimitPerMin,
      readOnly: room.readOnly,
    },
    expiresAt: Date.now() + 86_400_000, // 24h
  })
}
