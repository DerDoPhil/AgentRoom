import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/agentroom  (also served at /agentroom.md via next.config.ts rewrite)
 *
 * Returns the AgentRoom skill file in Markdown — the canonical agent-readable
 * documentation. Agents should fetch this before using any other endpoint.
 */
export async function GET() {
  const md = readFileSync(join(process.cwd(), 'public', 'agentroom.md'), 'utf-8')
  return new NextResponse(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
    },
  })
}
