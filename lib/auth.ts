import { NextRequest, NextResponse } from 'next/server'
import { getSession, isBanned, isMember } from './room'
import type { SessionData } from './types'

/**
 * Extracts and validates a session token from the request.
 * Checks: token exists → session in Redis → not banned → still a member.
 *
 * Returns the session or a ready-to-send error response.
 */
export async function requireSession(
  req: NextRequest,
  roomId: string
): Promise<{ session: SessionData } | { error: NextResponse }> {
  const token = req.headers.get('x-session-token')
  if (!token) {
    return {
      error: NextResponse.json(
        { error: 'Missing X-Session-Token header', code: 'NO_TOKEN' },
        { status: 401 }
      ),
    }
  }

  const session = await getSession(token)
  if (!session || session.roomId !== roomId) {
    return {
      error: NextResponse.json(
        { error: 'Invalid or expired session', code: 'INVALID_SESSION' },
        { status: 401 }
      ),
    }
  }

  const banned = await isBanned(roomId, token)
  if (banned) {
    return {
      error: NextResponse.json(
        { error: 'You have been banned from this room', code: 'BANNED' },
        { status: 403 }
      ),
    }
  }

  const member = await isMember(roomId, token)
  if (!member) {
    return {
      error: NextResponse.json(
        { error: 'Not a member of this room', code: 'NOT_MEMBER' },
        { status: 403 }
      ),
    }
  }

  return { session }
}

/**
 * Validates that the requester is the room creator.
 */
export async function requireCreator(
  req: NextRequest,
  roomId: string
): Promise<{ session: SessionData; token: string } | { error: NextResponse }> {
  const token = req.headers.get('x-session-token')
  if (!token) {
    return {
      error: NextResponse.json(
        { error: 'Missing X-Session-Token header', code: 'NO_TOKEN' },
        { status: 401 }
      ),
    }
  }

  const session = await getSession(token)
  if (!session || session.roomId !== roomId) {
    return {
      error: NextResponse.json(
        { error: 'Invalid or expired session', code: 'INVALID_SESSION' },
        { status: 401 }
      ),
    }
  }

  if (!session.isCreator) {
    return {
      error: NextResponse.json(
        { error: 'Creator access required', code: 'NOT_CREATOR' },
        { status: 403 }
      ),
    }
  }

  return { session, token }
}
