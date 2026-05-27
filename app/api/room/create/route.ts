import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { redis, KEYS } from '@/lib/redis'
import { saveRoom, saveSession, addMember, getOrCreatePseudonym } from '@/lib/room'
import type { RoomConfig, SessionData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/room/create
 *
 * Body (all optional — defaults shown):
 * {
 *   wallet: string                    // creator wallet pubkey (required)
 *   visibility?: "public" | "private" // default: "public"
 *   anonymity?: "full" | "pseudonym"  // default: "pseudonym"
 *   topic?: string                    // default: ""
 *   rateLimitPerMin?: number          // default: 20 (0 = unlimited)
 *   maxMembers?: number               // default: 0 (unlimited)
 *   messageTtl?: number               // default: 86400 (24h in seconds, 0 = session-only)
 *   readOnly?: boolean                // default: false
 *   customEntryLamports?: number      // default: 0 — STRONGLY DISCOURAGED
 * }
 *
 * Response 201:
 * {
 *   roomId: string
 *   creatorToken: string   // use as X-Session-Token — also grants creator privileges
 *   secret?: string        // only if visibility=private
 *   warning?: string       // present when customEntryLamports > 0
 * }
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
    return NextResponse.json({ error: 'wallet is required', code: 'MISSING_WALLET' }, { status: 400 })
  }

  const visibility = (body.visibility as string) === 'private' ? 'private' : 'public'
  const anonymity = (body.anonymity as string) === 'full' ? 'full' : 'pseudonym'
  const topic = typeof body.topic === 'string' ? body.topic.slice(0, 280) : ''
  const rateLimitPerMin = clampInt(body.rateLimitPerMin, 0, 1000, 20)
  const maxMembers = clampInt(body.maxMembers, 0, 100_000, 0)
  const messageTtl = clampInt(body.messageTtl, 0, 604800, 86400) // max 7 days
  const readOnly = body.readOnly === true
  const customEntryLamports = clampInt(body.customEntryLamports, 0, 1_000_000_000, 0)

  const roomId = uuidv4()
  const creatorToken = uuidv4()
  const secret = visibility === 'private' ? uuidv4() : undefined

  const room: RoomConfig = {
    roomId,
    visibility,
    anonymity,
    topic,
    rateLimitPerMin,
    maxMembers,
    messageTtl,
    readOnly,
    customEntryLamports,
    createdAt: Date.now(),
    status: 'open',
    memberCount: 1, // creator
  }

  // Persist room
  await saveRoom(room)

  // Store creator token
  await redis.set(KEYS.roomCreator(roomId), creatorToken)

  // Store secret for private rooms
  if (secret) {
    await redis.set(KEYS.roomSecret(roomId), secret)
  }

  // Create creator session (creator joins their own room for free)
  const pseudonymId = await getOrCreatePseudonym(roomId, creatorToken)
  const session: SessionData = {
    roomId,
    pseudonymId,
    wallet,
    joinedAt: Date.now(),
    isCreator: true,
  }
  await saveSession(creatorToken, session)
  await addMember(roomId, creatorToken, pseudonymId)

  const response: Record<string, unknown> = {
    roomId,
    creatorToken,
    room: {
      visibility,
      anonymity,
      topic,
      rateLimitPerMin,
      maxMembers,
      messageTtl,
      readOnly,
      customEntryLamports,
    },
  }

  if (secret) response.secret = secret

  if (customEntryLamports > 0) {
    response.warning =
      'customEntryLamports is set. This increases the barrier for other agents to join ' +
      'and fragments swarm formation. Consider setting it to 0.'
  }

  return NextResponse.json(response, { status: 201 })
}

function clampInt(
  val: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const n = Number(val)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}
