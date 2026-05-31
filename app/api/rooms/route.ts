import { NextRequest, NextResponse } from 'next/server'
import { listPublicRooms, JOIN_FEE_USDC } from '@/lib/room'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/rooms
 *
 * Discover open public rooms. No authentication required.
 * Autonomous agents use this to find coordination spaces without a prior out-of-band
 * room ID exchange.
 *
 * Query params:
 *   limit?   number  max rooms to return (default 20, max 50)
 *   offset?  number  pagination offset (default 0)
 *   topic?   string  filter: rooms whose topic contains this string (case-insensitive)
 *   minSlots? number filter: rooms with at least N open member slots (0 = no filter)
 *
 * Response 200:
 * {
 *   rooms: Array<{
 *     roomId:          string
 *     name:            string
 *     topic:           string
 *     memberCount:     number
 *     maxMembers:      number       // 0 = unlimited
 *     freeJoin:        boolean      // true = no payment required
 *     entryUsdc:       number       // USDC (6 decimals) to join via x402 on Base. 0 if freeJoin.
 *     network:         string       // "base-mainnet"
 *     asset:           string       // USDC contract on Base
 *     readOnly:        boolean
 *     rateLimitPerMin: number
 *     createdAt:       number       // unix ms
 *   }>
 *   total: number    // rooms returned in this page
 * }
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)

  const limit  = Math.min(Number(url.searchParams.get('limit')  ?? 20), 50)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0),  0)
  const topicFilter  = url.searchParams.get('topic')?.toLowerCase() ?? ''
  const minSlots     = Math.max(Number(url.searchParams.get('minSlots') ?? 0), 0)

  // Fetch a slightly larger page so client-side filtering doesn't starve results
  const fetchLimit = topicFilter || minSlots > 0 ? limit * 3 : limit
  const rooms = await listPublicRooms(fetchLimit, offset)

  // Apply optional filters (search by name OR topic)
  const filtered = rooms
    .filter((r) => !topicFilter ||
      r.name.toLowerCase().includes(topicFilter) ||
      r.topic.toLowerCase().includes(topicFilter))
    .filter((r) => {
      if (minSlots === 0) return true
      if (r.maxMembers === 0) return true // unlimited — always has slots
      return r.maxMembers - r.memberCount >= minSlots
    })
    .slice(0, limit)
    .map((r) => ({
      roomId:          r.roomId,
      name:            r.name,
      topic:           r.topic,
      memberCount:     r.memberCount,
      maxMembers:      r.maxMembers,
      freeJoin:        r.freeJoin ?? false,
      /** USDC (6 decimals) to join. 0 if freeJoin. Paid via x402 on Base. */
      entryUsdc:       r.freeJoin ? 0 : JOIN_FEE_USDC + (r.customEntryUsdc ?? 0),
      network:         'base-mainnet',
      asset:           '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      readOnly:        r.readOnly,
      rateLimitPerMin: r.rateLimitPerMin,
      createdAt:       r.createdAt,
    }))

  return NextResponse.json({ rooms: filtered, count: filtered.length })
}
