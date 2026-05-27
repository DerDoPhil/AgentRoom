import { NextRequest, NextResponse } from 'next/server'
import { requireCreator } from '@/lib/auth'
import { banMember, isMember, incrementMemberCount } from '@/lib/room'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * POST /api/room/[roomId]/ban
 *
 * Ban a member from the room. Creator only.
 * The banned session token is immediately invalidated and added to the ban list.
 * Any subsequent request with that token will receive 403 BANNED.
 *
 * Headers: X-Session-Token (creator token required)
 *
 * Body:
 * {
 *   targetToken: string   // session token of the member to ban
 * }
 *
 * Response 200:
 * {
 *   banned: true
 *   targetToken: string
 * }
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

  const targetToken = body.targetToken as string | undefined
  if (!targetToken) {
    return NextResponse.json(
      { error: 'targetToken is required', code: 'MISSING_TARGET' },
      { status: 400 }
    )
  }

  // Prevent creator from banning themselves
  if (targetToken === req.headers.get('x-session-token')) {
    return NextResponse.json(
      { error: 'Cannot ban yourself', code: 'CANNOT_BAN_SELF' },
      { status: 400 }
    )
  }

  const wasMember = await isMember(roomId, targetToken)

  await banMember(roomId, targetToken)

  if (wasMember) {
    await incrementMemberCount(roomId, -1)
  }

  return NextResponse.json({ banned: true, targetToken })
}
