import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { redis, KEYS } from '@/lib/redis'
import { saveRoom, saveSession, addMember, getOrCreatePseudonym, registerPublicRoom } from '@/lib/room'
import type { RoomConfig, SessionData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/admin/room
 *
 * Admin-only: Create a room without requiring payment.
 * Used for permanent demo/onboarding rooms (freeJoin=true).
 *
 * Requires header: X-Admin-Key: <ADMIN_SECRET env var>
 *
 * Body: same as /api/room/create but no nonce/txSig needed.
 *       Set freeJoin: true to allow members to join without paying.
 */
export async function POST(req: NextRequest) {
  // Admin auth
  const adminKey = req.headers.get('x-admin-key')
  const adminSecret = process.env.ADMIN_SECRET
  if (!adminSecret || adminKey !== adminSecret) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 })
  }

  const wallet    = (body.wallet as string) || 'admin'
  const visibility = (body.visibility as string) === 'private' ? 'private' : 'public'
  const anonymity  = (body.anonymity  as string) === 'full'    ? 'full'    : 'pseudonym'
  const name       = typeof body.name  === 'string' ? body.name.slice(0, 60)   : ''
  const topic      = typeof body.topic === 'string' ? body.topic.slice(0, 280) : ''
  const freeJoin   = body.freeJoin === true
  const rateLimitPerMin = clampInt(body.rateLimitPerMin, 0, 1000,           20)
  const maxMembers      = clampInt(body.maxMembers,      0, 100_000,        0)
  const messageTtl      = clampInt(body.messageTtl,      0, 604800,         86400)
  const readOnly        = body.readOnly === true
  const customEntryUsdc = clampInt(body.customEntryUsdc, 0, 1_000_000_000,  0)

  // Allow custom roomId for permanent/stable rooms
  const roomId       = typeof body.roomId === 'string' ? body.roomId : uuidv4()
  const creatorToken = uuidv4()
  const secret       = visibility === 'private' ? uuidv4() : undefined

  const room: RoomConfig = {
    roomId,
    visibility,
    anonymity,
    name,
    topic,
    freeJoin,
    rateLimitPerMin,
    maxMembers,
    messageTtl,
    readOnly,
    customEntryUsdc,
    createdAt: Date.now(),
    status: 'open',
    memberCount: 1,
  }

  await saveRoom(room)
  if (visibility === 'public') await registerPublicRoom(roomId, room.createdAt)
  await redis.set(KEYS.roomCreator(roomId), creatorToken)
  if (secret) await redis.set(KEYS.roomSecret(roomId), secret)

  const pseudonymId = await getOrCreatePseudonym(roomId, creatorToken)
  const session: SessionData = { roomId, pseudonymId, wallet, joinedAt: Date.now(), isCreator: true }
  await saveSession(creatorToken, session)
  await addMember(roomId, creatorToken, pseudonymId)

  return NextResponse.json({ roomId, creatorToken, freeJoin, room: { name, topic, visibility, freeJoin } }, { status: 201 })
}

function clampInt(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}
