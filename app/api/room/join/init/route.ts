import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** @deprecated — Removed in v2.0.0. AgentRoom now uses Ethereum/Base + x402. */
export async function POST() {
  return NextResponse.json(
    {
      error: 'This endpoint was removed in AgentRoom v2.0.0.',
      code:  'ENDPOINT_REMOVED',
      migration: {
        from: 'POST /api/room/join/init → send SOL → POST /api/room/join/confirm',
        to:   'POST /api/room/join (x402: returns 402 first, then 200 after payment)',
        docs: 'https://agentroom-navy.vercel.app/agentroom.md',
      },
    },
    { status: 410 }
  )
}
