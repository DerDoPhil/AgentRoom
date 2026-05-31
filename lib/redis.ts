import { Redis } from '@upstash/redis'

// Reads UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN automatically.
// These are set when you install Upstash Redis from Vercel Marketplace and connect
// it to this project. See: https://vercel.com/marketplace?category=storage&search=redis
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// ─── Key schema ──────────────────────────────────────────────────────────────
//
//  room:{id}                → Hash: RoomConfig fields
//  room:{id}:creator        → String: creatorSessionToken
//  room:{id}:secret         → String: secret key (private rooms only)
//  room:{id}:members        → Hash: sessionToken → pseudonymId
//  room:{id}:bans           → Set: banned sessionTokens
//  room:{id}:wallet-bans    → Set: banned Ethereum addresses
//  room:{id}:messages       → List: JSON Message objects (newest at head)
//  room:{id}:pins           → List: pinned message IDs (newest first)
//  room:{id}:ratelimit:{tok}→ String: message count this minute (TTL 60s)
//  session:{token}          → Hash: SessionData fields
//  x402:used:{txHash}       → String "1" (7-day dedup guard — replay protection)
//  pseudonym:{roomId}:{tok} → String: "Agent#XXXX" (stable per room)
//  rooms:public             → ZSet: public open room IDs, score = createdAt ms
//  iprl:join:{ip}           → Counter: free-join attempts/minute per IP (TTL 60s)

export const KEYS = {
  room:           (id: string)                    => `room:${id}`,
  roomCreator:    (id: string)                    => `room:${id}:creator`,
  roomSecret:     (id: string)                    => `room:${id}:secret`,
  roomMembers:    (id: string)                    => `room:${id}:members`,
  roomBans:       (id: string)                    => `room:${id}:bans`,
  roomWalletBans: (id: string)                    => `room:${id}:wallet-bans`,
  roomMessages:   (id: string)                    => `room:${id}:messages`,
  roomPins:       (id: string)                    => `room:${id}:pins`,
  roomRateLimit:  (id: string, token: string)     => `room:${id}:ratelimit:${token}`,
  session:        (token: string)                 => `session:${token}`,
  usedPayment:    (txHash: string)                => `x402:used:${txHash}`,
  pseudonym:      (roomId: string, token: string) => `pseudonym:${roomId}:${token}`,
  publicRooms:    ()                              => `rooms:public`,
  ipFreeJoinRL:   (ip: string)                    => `iprl:join:${ip}`,
}

export const TTL = {
  usedPayment:    86400 * 7,  // 7 days — replay protection window
  sessionDefault: 86400,      // 24h
  rateLimitWindow: 60,        // 1 min sliding window
}

// ─── Free-tier protection ────────────────────────────────────────────────────
//
// Upstash free tier: 10k commands/day. To prevent a single client from burning
// the quota by spamming the free onboarding room (each join = ~7 commands),
// we cap free-joins at FREE_JOIN_RATE_LIMIT per minute per IP. Paid joins are
// not rate-limited at the IP level — the $1 USDC cost is the spam barrier.

export const FREE_JOIN_RATE_LIMIT = 5  // max free joins per IP per minute
