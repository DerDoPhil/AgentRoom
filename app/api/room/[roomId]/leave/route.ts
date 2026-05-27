import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { removeMember, incrementMemberCount } from '@/lib/room'
import { redis, KEYS } from '@/lib/redis'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/room/[roomId]/leave
 *
 * Gracefully leave a room. Session token is invalidated.
 * Creator leaving closes the room — use DELETE /api/room/[roomId] instead.
 *
 * Headers: X-Session-Token (required)
 *
 * Response 200:
 * { left: true, roomId }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> }
) {
  const { roomId } = await params
  const auth = await requireSession(req, roomId)
  if ('error' in auth) return auth.error

  const { session } = auth

  if (session.isCreator) {
    return NextResponse.json(
      {
        error: 'Creators cannot leave their room — use DELETE /api/room/[roomId] to close it instead.',
        code: 'CREATOR_CANNOT_LEAVE',
      },
      { status: 400 }
    )
  }

  const token = req.headers.get('x-session-token')!

  await removeMember(roomId, token)
  await redis.del(KEYS.session(token))
  await incrementMemberCount(roomId, -1)

  return NextResponse.json({ left: true, roomId })
}
