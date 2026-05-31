import { NextRequest, NextResponse } from 'next/server'
import { requireCreator, requireSession } from '@/lib/auth'
import { getRoom, pinMessage, unpinMessage, getPinnedMessageIds, getMessages } from '@/lib/room'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/room/[roomId]/pin
 *
 * Retrieve pinned messages for this room. Requires membership.
 * Returns pinned messages in full (content + data), newest pin first.
 * Max 5 pinned messages per room.
 *
 * Response 200:
 * {
 *   pinned: Message[]   // full message objects (newest pin first)
 * }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const { roomId } = await params
  const auth = await requireSession(req, roomId)
  if ('error' in auth) return auth.error

  const room = await getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 })
  }

  const pinnedIds = await getPinnedMessageIds(roomId)
  if (!pinnedIds.length) return NextResponse.json({ pinned: [] })

  // Fetch recent messages and find the pinned ones
  // We fetch up to 500 to cover most scenarios (list is capped at 500 in room.ts)
  const allMessages = await getMessages(roomId, 500, 0)
  const pinnedSet = new Set(pinnedIds)
  const pinned = allMessages
    .filter((m) => pinnedSet.has(m.id))
    // Re-order by pinnedIds order (newest pin first)
    .sort((a, b) => pinnedIds.indexOf(a.id) - pinnedIds.indexOf(b.id))
    .map((m) => ({
      ...m,
      sender: room.anonymity === 'full' ? null : m.sender,
      pinned: true,
    }))

  return NextResponse.json({ pinned })
}

/**
 * POST /api/room/[roomId]/pin
 *
 * Pin or unpin a message. Creator only.
 *
 * Body:
 * {
 *   messageId: string
 *   action?: "pin" | "unpin"   // default: "pin"
 * }
 *
 * Response 200:
 * {
 *   ok: true
 *   action: "pin" | "unpin"
 *   messageId: string
 * }
 *
 * Errors:
 *   PIN_LIMIT — already at max 5 pinned messages (for pin action)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const { roomId } = await params
  const auth = await requireCreator(req, roomId)
  if ('error' in auth) return auth.error

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 })
  }

  const messageId = typeof body.messageId === 'string' ? body.messageId : ''
  if (!messageId) {
    return NextResponse.json({ error: 'messageId is required', code: 'MISSING_FIELD' }, { status: 400 })
  }

  const action = body.action === 'unpin' ? 'unpin' : 'pin'

  if (action === 'unpin') {
    await unpinMessage(roomId, messageId)
    return NextResponse.json({ ok: true, action: 'unpin', messageId })
  }

  // Pin: enforce max 5 limit
  const existing = await getPinnedMessageIds(roomId)
  if (existing.length >= 5 && !existing.includes(messageId)) {
    return NextResponse.json(
      { error: 'Max 5 pinned messages per room. Unpin one first.', code: 'PIN_LIMIT' },
      { status: 409 }
    )
  }

  await pinMessage(roomId, messageId)
  return NextResponse.json({ ok: true, action: 'pin', messageId })
}
