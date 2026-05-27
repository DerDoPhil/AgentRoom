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
//  room:{id}:messages       → List: JSON Message objects (newest at head)
//  room:{id}:ratelimit:{tok}→ String: message count this minute (TTL 60s)
//  session:{token}          → Hash: SessionData fields
//  payment:pending:{nonce}  → Hash: PendingPayment fields (TTL 10min)
//  payment:used:{txSig}     → String "1" (TTL 1h — dedup guard)
//  pseudonym:{roomId}:{tok} → String: "Agent#XXXX" (stable per room)

export const KEYS = {
  room: (id: string) => `room:${id}`,
  roomCreator: (id: string) => `room:${id}:creator`,
  roomSecret: (id: string) => `room:${id}:secret`,
  roomMembers: (id: string) => `room:${id}:members`,
  roomBans: (id: string) => `room:${id}:bans`,
  roomMessages: (id: string) => `room:${id}:messages`,
  roomRateLimit: (id: string, token: string) => `room:${id}:ratelimit:${token}`,
  session: (token: string) => `session:${token}`,
  pendingPayment: (nonce: string) => `payment:pending:${nonce}`,
  usedPayment: (txSig: string) => `payment:used:${txSig}`,
  pseudonym: (roomId: string, token: string) => `pseudonym:${roomId}:${token}`,
}

export const TTL = {
  pendingPayment: 600,     // 10 min
  usedPayment: 3600,       // 1h dedup guard
  sessionDefault: 86400,   // 24h
  rateLimitWindow: 60,     // 1 min sliding window
}
