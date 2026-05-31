import { NextRequest, NextResponse } from 'next/server'
import { requireSession, requireCreator } from '@/lib/auth'
import { getRoom, saveRoom, removeMember, deregisterPublicRoom } from '@/lib/room'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/room/[roomId]
 *
 * Get room info. Requires membership (X-Session-Token).
 *
 * Response 200:
 * {
 *   roomId, visibility, anonymity, topic,
 *   rateLimitPerMin, maxMembers, messageTtl,
 *   readOnly, customEntryLamports,
 *   status, memberCount, createdAt
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

  return NextResponse.json(room)
}

/**
 * DELETE /api/room/[roomId]
 *
 * Close the room. Creator only.
 * All messages are preserved until TTL expires (or session-only = deleted now).
 * No new members can join. Existing sessions expire naturally.
 *
 * Headers: X-Session-Token (creator token required)
 *
 * Response 200:
 * { closed: true, roomId }
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const { roomId } = await params
  const auth = await requireCreator(req, roomId)
  if ('error' in auth) return auth.error

  const room = await getRoom(roomId)
  if (!room) {
    return NextResponse.json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' }, { status: 404 })
  }
  if (room.status === 'closed') {
    return NextResponse.json({ error: 'Room is already closed', code: 'ALREADY_CLOSED' }, { status: 409 })
  }

  room.status = 'closed'
  await saveRoom(room)

  // Remove from public discovery index
  await deregisterPublicRoom(roomId)

  return NextResponse.json({ closed: true, roomId })
}

/**
 * POST /api/room/[roomId]/leave
 * (handled via dedicated route — see leave/route.ts)
 *
 * Actually: a PATCH here for member self-removal
 *
 * DELETE used by creator to close, so we use a distinct endpoint for leaving.
 * See /api/room/[roomId]/leave/route.ts
 */
