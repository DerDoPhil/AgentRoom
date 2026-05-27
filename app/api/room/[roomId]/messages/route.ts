import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { requireSession } from '@/lib/auth'
import { getRoom, getMessages, pushMessage, checkRateLimit } from '@/lib/room'
import type { Message } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/room/[roomId]/messages
 *
 * Headers: X-Session-Token (required)
 *
 * Query params:
 *   limit?  number  max messages to return (default 50, max 200)
 *   offset? number  skip N newest messages (for pagination, default 0)
 *
 * Response 200:
 * {
 *   messages: Array<{
 *     id: string
 *     sender: string | null    // null if anonymity=full
 *     content: string
 *     ts: number               // unix ms
 *   }>
 *   count: number
 * }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const { roomId } = await params
  const auth = await requireSession(req, roomId)
  if ('error' in auth) return auth.error

  const url = new URL(req.url)
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0)

  const room = await getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 })
  }

  const rawMessages = await getMessages(roomId, limit, offset)

  // Strip sender if anonymity=full
  const messages = rawMessages.map((m) => ({
    ...m,
    sender: room.anonymity === 'full' ? null : m.sender,
  }))

  return NextResponse.json({ messages, count: messages.length })
}

/**
 * POST /api/room/[roomId]/messages
 *
 * Headers: X-Session-Token (required)
 *
 * Body:
 * {
 *   content: string   // max 4000 chars
 * }
 *
 * Response 201:
 * {
 *   id: string
 *   sender: string | null
 *   content: string
 *   ts: number
 * }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const { roomId } = await params
  const auth = await requireSession(req, roomId)
  if ('error' in auth) return auth.error

  const { session } = auth

  const room = await getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 })
  }
  if (room.status !== 'open') {
    return NextResponse.json({ error: 'Room is closed', code: 'ROOM_CLOSED' }, { status: 410 })
  }

  // Read-only: only creator can write
  if (room.readOnly && !session.isCreator) {
    return NextResponse.json(
      { error: 'Room is read-only. Only the creator can send messages.', code: 'READ_ONLY' },
      { status: 403 }
    )
  }

  // Rate limit check
  const token = req.headers.get('x-session-token')!
  const withinLimit = await checkRateLimit(roomId, token, room.rateLimitPerMin)
  if (!withinLimit) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded: ${room.rateLimitPerMin} messages/minute`,
        code: 'RATE_LIMITED',
        retryAfter: 60,
      },
      { status: 429 }
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 })
  }

  const content = typeof body.content === 'string' ? body.content.slice(0, 4000) : ''
  if (!content.trim()) {
    return NextResponse.json({ error: 'content is required', code: 'EMPTY_CONTENT' }, { status: 400 })
  }

  const msg: Message = {
    id: uuidv4(),
    sender: room.anonymity === 'full' ? null : session.pseudonymId,
    content,
    ts: Date.now(),
  }

  await pushMessage(roomId, msg, room.messageTtl)

  return NextResponse.json(msg, { status: 201 })
}
