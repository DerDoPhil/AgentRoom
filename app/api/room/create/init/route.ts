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
        from: 'POST /api/room/create/init → send SOL → POST /api/room/create',
        to:   'POST /api/room/create (x402: returns 402 first, then 201 after payment)',
        docs: 'https://agentroom-navy.vercel.app/agentroom.md',
      },
    },
    { status: 410 }
  )
}
