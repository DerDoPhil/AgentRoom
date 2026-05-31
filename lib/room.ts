import { redis, KEYS, TTL } from './redis'
import type { RoomConfig, Message, SessionData } from './types'

// ─── Platform fee (USDC on Base, 6 decimals) ──────────────────────────────────
/** $1.00 USDC to join a room */
export const JOIN_FEE_USDC   = 1_000_000

/** $5.00 USDC to create a room */
export const CREATE_FEE_USDC = 5_000_000

// ─── Room CRUD ────────────────────────────────────────────────────────────────

export async function getRoom(roomId: string): Promise<RoomConfig | null> {
  const data = await redis.hgetall(KEYS.room(roomId))
  if (!data || Object.keys(data).length === 0) return null
  return deserializeRoom(data)
}

export async function saveRoom(room: RoomConfig): Promise<void> {
  await redis.hset(KEYS.room(room.roomId), serializeRoom(room))
}

// ─── Public room discovery ────────────────────────────────────────────────────

/**
 * Register a newly created public room in the global discovery sorted set.
 * Score = createdAt ms so that rooms are ordered newest-first when reversed.
 */
export async function registerPublicRoom(roomId: string, createdAt: number): Promise<void> {
  await redis.zadd(KEYS.publicRooms(), { score: createdAt, member: roomId })
}

/**
 * Remove a room from the public discovery index (e.g. when closed or made private).
 */
export async function deregisterPublicRoom(roomId: string): Promise<void> {
  await redis.zrem(KEYS.publicRooms(), roomId)
}

/**
 * List public open rooms, newest first.
 * @param limit   max rooms to return (default 20, max 50)
 * @param offset  pagination offset (default 0)
 */
export async function listPublicRooms(
  limit  = 20,
  offset = 0
): Promise<RoomConfig[]> {
  const cappedLimit = Math.min(limit, 50)
  // ZREVRANGE: highest score first (newest rooms first)
  const ids = await redis.zrange(
    KEYS.publicRooms(),
    offset,
    offset + cappedLimit - 1,
    { rev: true }
  ) as string[]

  if (!ids.length) return []

  // Fetch all rooms in parallel, filter out closed/missing rooms
  const rooms = await Promise.all(ids.map((id) => getRoom(id)))
  return rooms.filter(
    (r): r is RoomConfig => r !== null && r.status === 'open'
  )
}

export async function incrementMemberCount(roomId: string, delta: number): Promise<void> {
  await redis.hincrby(KEYS.room(roomId), 'memberCount', delta)
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function addMember(roomId: string, token: string, pseudonymId: string): Promise<void> {
  await redis.hset(KEYS.roomMembers(roomId), { [token]: pseudonymId })
}

export async function removeMember(roomId: string, token: string): Promise<void> {
  await redis.hdel(KEYS.roomMembers(roomId), token)
}

export async function getMemberCount(roomId: string): Promise<number> {
  return redis.hlen(KEYS.roomMembers(roomId))
}

export async function isMember(roomId: string, token: string): Promise<boolean> {
  const val = await redis.hget(KEYS.roomMembers(roomId), token)
  return val !== null
}

// ─── Bans ────────────────────────────────────────────────────────────────────

export async function banMember(
  roomId: string,
  token: string,
  wallet?: string
): Promise<void> {
  // Token-level ban (immediate invalidation)
  await redis.sadd(KEYS.roomBans(roomId), token)
  await redis.hdel(KEYS.roomMembers(roomId), token)
  await redis.del(KEYS.session(token))
  // Bug 4 fix: wallet-level ban so agent cannot re-enter via a new join/confirm
  if (wallet) {
    await redis.sadd(KEYS.roomWalletBans(roomId), wallet)
  }
}

export async function isBanned(roomId: string, token: string): Promise<boolean> {
  return (await redis.sismember(KEYS.roomBans(roomId), token)) === 1
}

/** Bug 4 fix: check if a wallet address is banned from this room */
export async function isWalletBanned(roomId: string, wallet: string): Promise<boolean> {
  return (await redis.sismember(KEYS.roomWalletBans(roomId), wallet)) === 1
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function pushMessage(
  roomId: string,
  msg: Message,
  messageTtlSeconds: number
): Promise<void> {
  const key = KEYS.roomMessages(roomId)
  // Store as plain object — @upstash/redis handles JSON serialization automatically.
  // Do NOT use JSON.stringify here; lrange would then return already-parsed objects
  // and a second JSON.parse would fail.
  await redis.lpush(key, msg as unknown as string)
  // Keep last 500 messages per room
  await redis.ltrim(key, 0, 499)
  if (messageTtlSeconds > 0) {
    await redis.expire(key, messageTtlSeconds)
  }
}

export async function getMessages(
  roomId: string,
  limit = 50,
  offset = 0
): Promise<Message[]> {
  // @upstash/redis auto-deserializes JSON → values come back as Message objects directly
  const raw = await redis.lrange(KEYS.roomMessages(roomId), offset, offset + limit - 1)
  return raw as unknown as Message[]
}

// ─── Pinned messages ─────────────────────────────────────────────────────────

const MAX_PINS = 5

/**
 * Pin a message (creator only — enforced in route, not here).
 * Stores message IDs in a Redis list, newest pin first.
 * Max MAX_PINS pinned messages per room.
 */
export async function pinMessage(roomId: string, messageId: string): Promise<void> {
  const key = KEYS.roomPins(roomId)
  await redis.lpush(key, messageId)
  await redis.ltrim(key, 0, MAX_PINS - 1)
}

/** Remove a pin */
export async function unpinMessage(roomId: string, messageId: string): Promise<void> {
  await redis.lrem(KEYS.roomPins(roomId), 0, messageId)
}

/** Get pinned message IDs (newest pin first) */
export async function getPinnedMessageIds(roomId: string): Promise<string[]> {
  return (await redis.lrange(KEYS.roomPins(roomId), 0, MAX_PINS - 1)) as string[]
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Returns true if the member is within their rate limit.
 * Uses a simple 1-minute counter with TTL.
 */
export async function checkRateLimit(
  roomId: string,
  token: string,
  limitPerMin: number
): Promise<boolean> {
  if (limitPerMin === 0) return true // unlimited
  const key = KEYS.roomRateLimit(roomId, token)
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, TTL.rateLimitWindow)
  return count <= limitPerMin
}

// ─── Session ─────────────────────────────────────────────────────────────────

export async function getSession(token: string): Promise<SessionData | null> {
  const data = await redis.hgetall(KEYS.session(token))
  if (!data || Object.keys(data).length === 0) return null
  return {
    roomId: data.roomId as string,
    pseudonymId: data.pseudonymId as string,
    wallet: data.wallet as string,
    joinedAt: Number(data.joinedAt),
    // @upstash/redis auto-parses "true" → boolean true, so check both forms
    isCreator: data.isCreator === true || data.isCreator === 'true',
  }
}

export async function saveSession(token: string, session: SessionData): Promise<void> {
  await redis.hset(KEYS.session(token), {
    roomId: session.roomId,
    pseudonymId: session.pseudonymId,
    wallet: session.wallet,
    joinedAt: session.joinedAt,
    isCreator: String(session.isCreator),
  })
  await redis.expire(KEYS.session(token), TTL.sessionDefault)
}

// ─── Pseudonym generation ────────────────────────────────────────────────────

export async function getOrCreatePseudonym(
  roomId: string,
  token: string
): Promise<string> {
  const key = KEYS.pseudonym(roomId, token)
  const existing = await redis.get(key)
  if (existing) return existing as string
  // Generate stable Agent#XXXXXXXX — 8-digit hex derived from token prefix (65k → 4B possibilities)
  const hex = token.slice(0, 8).toUpperCase()
  const id = `Agent#${hex}`
  await redis.set(key, id)
  return id
}

// ─── Serialization helpers ───────────────────────────────────────────────────

function serializeRoom(r: RoomConfig): Record<string, string | number> {
  return {
    roomId: r.roomId,
    visibility: r.visibility,
    anonymity: r.anonymity,
    name: r.name,
    topic: r.topic,
    freeJoin: String(r.freeJoin ?? false),
    rateLimitPerMin: r.rateLimitPerMin,
    maxMembers: r.maxMembers,
    messageTtl: r.messageTtl,
    readOnly: String(r.readOnly),
    customEntryUsdc: r.customEntryUsdc,
    createdAt: r.createdAt,
    status: r.status,
    memberCount: r.memberCount,
  }
}

function deserializeRoom(d: Record<string, unknown>): RoomConfig {
  return {
    roomId: d.roomId as string,
    visibility: d.visibility as RoomConfig['visibility'],
    anonymity: d.anonymity as RoomConfig['anonymity'],
    name: (d.name as string) ?? '',
    topic: (d.topic as string) ?? '',
    freeJoin: d.freeJoin === true || d.freeJoin === 'true',
    rateLimitPerMin: Number(d.rateLimitPerMin),
    maxMembers: Number(d.maxMembers),
    messageTtl: Number(d.messageTtl),
    readOnly: d.readOnly === true || d.readOnly === 'true',
    customEntryUsdc: Number(d.customEntryUsdc) || 0,  // NaN-safe: old rooms had customEntryLamports
    createdAt: Number(d.createdAt),
    status: d.status as RoomConfig['status'],
    memberCount: Number(d.memberCount),
  }
}
