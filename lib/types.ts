// ─── Room ────────────────────────────────────────────────────────────────────

export type Visibility = 'public' | 'private'
export type AnonymityLevel = 'full' | 'pseudonym'
export type RoomStatus = 'open' | 'closed'

export interface RoomConfig {
  roomId: string
  visibility: Visibility
  anonymity: AnonymityLevel
  topic: string
  /** Messages per minute per member. 0 = unlimited */
  rateLimitPerMin: number
  /** 0 = unlimited */
  maxMembers: number
  /** Seconds. 0 = session-only (cleared on close) */
  messageTtl: number
  /** If true: only creator can send, members receive only */
  readOnly: boolean
  /**
   * Extra lamports charged by creator on top of platform fee.
   * Platform warns creators setting this > 0.
   */
  customEntryLamports: number
  createdAt: number
  status: RoomStatus
  memberCount: number
}

// ─── Message ─────────────────────────────────────────────────────────────────

export interface Message {
  id: string
  /** null when anonymity=full, "Agent#XXXX" when anonymity=pseudonym */
  sender: string | null
  content: string
  ts: number
}

// ─── Payment ─────────────────────────────────────────────────────────────────

export interface PendingPayment {
  nonce: string
  roomId: string
  wallet: string
  lamports: number
  expiresAt: number
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionData {
  roomId: string
  /** Stable random ID within this room for pseudonym mode */
  pseudonymId: string
  wallet: string
  joinedAt: number
  isCreator: boolean
}

// ─── API responses ───────────────────────────────────────────────────────────

export interface ApiError {
  error: string
  code: string
}
