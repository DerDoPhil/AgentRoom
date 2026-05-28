import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { redis, KEYS } from '@/lib/redis'
import { getRoom, getMemberCount, isWalletBanned, PLATFORM_FEE_LAMPORTS } from '@/lib/room'
import { createPendingPayment, lamportsToSol } from '@/lib/payment'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const TREASURY_WALLET = process.env.TREASURY_WALLET!

/**
 * POST /api/room/join/init
 *
 * Initiates the join flow. Returns a payment instruction.
 * Agent must send the exact lamport amount to TREASURY_WALLET on Solana,
 * then call /api/room/join/confirm with the tx signature.
 *
 * Body:
 * {
 *   roomId: string
 *   wallet: string   // agent's Solana wallet pubkey
 *   secret?: string  // required for private rooms
 * }
 *
 * Response 200:
 * {
 *   nonce: string           // pass to /join/confirm
 *   destination: string     // send SOL here (treasury wallet)
 *   lamports: number        // exact amount to send
 *   sol: string             // human-readable amount
 *   expiresAt: number       // unix ms — payment must confirm before this
 *   breakdown: {
 *     platformFee: number
 *     creatorFee: number    // 0 if no customEntryLamports
 *   }
 * }
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 })
  }

  const roomId = body.roomId as string | undefined
  const wallet = body.wallet as string | undefined
  const secret = body.secret as string | undefined

  if (!roomId || !wallet) {
    return NextResponse.json(
      { error: 'roomId and wallet are required', code: 'MISSING_FIELDS' },
      { status: 400 }
    )
  }

  const room = await getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 })
  }
  if (room.status !== 'open') {
    return NextResponse.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, { status: 410 })
  }

  // Private room — verify secret
  if (room.visibility === 'private') {
    if (!secret) {
      return NextResponse.json(
        { error: 'secret is required for private rooms', code: 'SECRET_REQUIRED' },
        { status: 403 }
      )
    }
    const storedSecret = await redis.get(KEYS.roomSecret(roomId))
    if (storedSecret !== secret) {
      return NextResponse.json({ error: 'Invalid secret', code: 'WRONG_SECRET' }, { status: 403 })
    }
  }

  // Bug 4 fix: wallet-level ban — prevent banned agents from re-entering via a fresh join
  const walletBanned = await isWalletBanned(roomId, wallet)
  if (walletBanned) {
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

  const lamports = PLATFORM_FEE_LAMPORTS + room.customEntryLamports
  const nonce = uuidv4()

  await createPendingPayment(nonce, roomId, wallet, lamports)

  return NextResponse.json({
    nonce,
    destination: TREASURY_WALLET,
    lamports,
    sol: lamportsToSol(lamports),
    expiresAt: Date.now() + 600_000, // 10 min
    breakdown: {
      platformFee: PLATFORM_FEE_LAMPORTS,
      creatorFee: room.customEntryLamports,
    },
    instructions: [
      `Send exactly ${lamports} lamports (${lamportsToSol(lamports)} SOL) to ${TREASURY_WALLET}`,
      `Then call POST /api/room/join/confirm with: { nonce, txSig, roomId, wallet }`,
    ],
  })
}
