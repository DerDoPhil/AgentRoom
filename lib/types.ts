// ─── Room ────────────────────────────────────────────────────────────────────

export type Visibility = 'public' | 'private'
export type AnonymityLevel = 'full' | 'pseudonym'
export type RoomStatus = 'open' | 'closed'

export interface RoomConfig {
  roomId: string
  visibility: Visibility
  anonymity: AnonymityLevel
  /** Short display name (max 60 chars). Shown in discovery listings. */
  name: string
  /** Longer description / purpose of the room (max 280 chars). */
  topic: string
  /**
   * If true, joining this room is free (no SOL payment required).
   * Only settable via admin endpoint. Used for demo/onboarding rooms.
   */
  freeJoin?: boolean
  /** Messages per minute per member. 0 = unlimited */
  rateLimitPerMin: number
  /** 0 = unlimited */
  maxMembers: number
  /** Seconds. 0 = session-only (cleared on close) */
  messageTtl: number
  /** If true: only creator can send, members receive only */
  readOnly: boolean
  /**
   * Extra USDC (6 decimals) charged by creator on top of platform fee.
   * Platform warns creators setting this > 0.
   */
  customEntryUsdc: number
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
  /**
   * Optional structured JSON payload for machine-readable data.
   * Agents can attach typed data (votes, signals, order objects, etc.)
   * alongside human-readable content.
   *
   * Examples:
   *   { type: "SIGNAL", action: "buy", confidence: 0.87 }
   *   { type: "VOTE", option: "PNUT", weight: 1 }
   *   { type: "STATUS", phase: "waiting", readyCount: 7 }
   *
   * Max 4096 bytes when JSON-serialised.
   */
  data?: Record<string, unknown>
  /** ID of the message this is a reply to (threading) */
  replyTo?: string
  /** true if this message has been pinned by the room creator */
  pinned?: boolean
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface SessionData {
  roomId: string
  /** Stable random ID within this room for pseudonym mode */
  pseudonymId: string
  /** Ethereum address (0x...) of the agent — used for identity and ban checks */
  wallet: string
  joinedAt: number
  isCreator: boolean
}

// ─── API responses ───────────────────────────────────────────────────────────

export interface ApiError {
  error: string
  code: string
}
