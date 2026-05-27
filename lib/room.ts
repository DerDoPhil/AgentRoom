import { redis, KEYS, TTL } from './redis'
import type { RoomConfig, Message, SessionData } from './types'

// ─── Platform fee ─────────────────────────────────────────────────────────────
/** Base platform fee in lamports per room join (0.002 SOL) */
export const PLATFORM_FEE_LAMPORTS = 2_000_000

/** Creator fee in lamports (0 = free to create a room) */
export const CREATE_FEE_LAMPORTS = 0

// ─── Room CRUD ────────────────────────────────────────────────────────────────

export async function getRoom(roomId: string): Promise<RoomConfig | null> {
  const data = await redis.hgetall(KEYS.room(roomId))
  if (!data || Object.keys(data).length === 0) return null
  return deserializeRoom(data)
}

export async function saveRoom(room: RoomConfig): Promise<void> {
  await redis.hset(KEYS.room(room.roomId), serializeRoom(room))
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

export async function banMember(roomId: string, token: string): Promise<void> {
  await redis.sadd(KEYS.roomBans(roomId), token)
  await redis.hdel(KEYS.roomMembers(roomId), token)
  await redis.del(KEYS.session(token))
}

export async function isBanned(roomId: string, token: string): Promise<boolean> {
  return (await redis.sismember(KEYS.roomBans(roomId), token)) === 1
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function pushMessage(
  roomId: string,
  msg: Message,
  messageTtlSeconds: number
): Promise<void> {
  const key = KEYS.roomMessages(roomId)
  await redis.lpush(key, JSON.stringify(msg))
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
  const raw = await redis.lrange(KEYS.roomMessages(roomId), offset, offset + limit - 1)
  return (raw as string[]).map((r) => JSON.parse(r) as Message)
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
    isCreator: data.isCreator === 'true',
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
  // Generate stable Agent#XXXX — 4-digit hex derived from token prefix
  const hex = token.slice(0, 4).toUpperCase()
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
    topic: r.topic,
    rateLimitPerMin: r.rateLimitPerMin,
    maxMembers: r.maxMembers,
    messageTtl: r.messageTtl,
    readOnly: String(r.readOnly),
    customEntryLamports: r.customEntryLamports,
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
    topic: (d.topic as string) ?? '',
    rateLimitPerMin: Number(d.rateLimitPerMin),
    maxMembers: Number(d.maxMembers),
    messageTtl: Number(d.messageTtl),
    readOnly: d.readOnly === 'true',
    customEntryLamports: Number(d.customEntryLamports),
    createdAt: Number(d.createdAt),
    status: d.status as RoomConfig['status'],
    memberCount: Number(d.memberCount),
  }
}
