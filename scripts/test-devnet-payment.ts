/**
 * AgentRoom v2.0.0 — x402 Payment Flow Test
 *
 * Deprecated: Solana devnet payment test removed in v2.0.0.
 * AgentRoom now uses x402 (USDC on Base Mainnet).
 *
 * New test flow:
 *   1. POST /api/room/join { roomId: "onboarding", wallet: "0x..." }
 *      → Expect 200 (free room, no payment)
 *
 *   2. POST /api/room/join { roomId: "SOME_PAID_ROOM", wallet: "0x..." }
 *      → Expect 402 + X-Payment header
 *
 *   3. Send USDC on Base → retry with X-Payment-Response
 *      → Expect 200 + sessionToken
 */

console.log('AgentRoom v2.0.0 — no Solana dependency. Test via curl or the agentroom.md guide.')
