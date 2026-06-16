/**
 * WebSocket protocol: message type definitions, parsing, and serialization.
 */

// --- Client -> Server Message Types ---

export interface JoinMessage {
  type: "join";
  roomCode: string;
  displayName: string;
}

export interface PlaybackPlayMessage {
  type: "playback:play";
}

export interface PlaybackPauseMessage {
  type: "playback:pause";
}

export interface PlaybackSeekMessage {
  type: "playback:seek";
  position: number;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  position: number;
  isBuffering: boolean;
  clientTime: number;
}

export interface ChatMessageMessage {
  type: "chat:message";
  content: string;
}

export interface ChatReactionMessage {
  type: "chat:reaction";
  emoji: string;
}

export interface HostKickMessage {
  type: "host:kick";
  targetId: string;
}

export interface HostForceResyncMessage {
  type: "host:force-resync";
}

export interface PongMessage {
  type: "pong";
  serverTime: number;
}

export type ClientMessage =
  | JoinMessage
  | PlaybackPlayMessage
  | PlaybackPauseMessage
  | PlaybackSeekMessage
  | HeartbeatMessage
  | ChatMessageMessage
  | ChatReactionMessage
  | HostKickMessage
  | HostForceResyncMessage
  | PongMessage;

// --- Server -> Client Message Types ---

export interface RoomStateMessage {
  type: "room:state";
  room: {
    id: string;
    videoSource: { type: string; url: string; label?: string };
    audioTracks: Array<{ label: string; url: string }>;
    hostId: string | null;
    linkedRoomId: string | null;
    linkedRoomLabel: string | null;
  };
  participants: Array<{
    id: string;
    displayName: string;
    joinedAt: number;
  }>;
  playbackState: {
    isPlaying: boolean;
    position: number;
    timestamp: number;
  };
  chatHistory: Array<{
    id: string;
    senderId: string;
    senderName: string;
    content: string;
    timestamp: number;
  }>;
}

export interface RoomParticipantJoinedMessage {
  type: "room:participant-joined";
  participant: {
    id: string;
    displayName: string;
    joinedAt: number;
  };
}

export interface RoomParticipantLeftMessage {
  type: "room:participant-left";
  participantId: string;
}

export interface PlaybackUpdateMessage {
  type: "playback:update";
  isPlaying: boolean;
  position: number;
  timestamp: number;
}

export interface PlaybackForceResyncMessage {
  type: "playback:force-resync";
  position: number;
}

export interface SyncAdjustMessage {
  type: "sync:adjust";
  drift: number;
  suggestedRate: number;
}

export interface ChatNewMessageMessage {
  type: "chat:new-message";
  message: {
    id: string;
    senderId: string;
    senderName: string;
    content: string;
    timestamp: number;
  };
}

export interface ChatNewReactionMessage {
  type: "chat:new-reaction";
  emoji: string;
  senderName: string;
}

export interface HostDashboardMessage {
  type: "host:dashboard";
  participants: Array<{
    id: string;
    displayName: string;
    latency: number;
    drift: number;
    isBuffering: boolean;
  }>;
}

export interface PingMessage {
  type: "ping";
  serverTime: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export interface KickedMessage {
  type: "kicked";
  reason: string;
}

export type ServerMessage =
  | RoomStateMessage
  | RoomParticipantJoinedMessage
  | RoomParticipantLeftMessage
  | PlaybackUpdateMessage
  | PlaybackForceResyncMessage
  | SyncAdjustMessage
  | ChatNewMessageMessage
  | ChatNewReactionMessage
  | HostDashboardMessage
  | PingMessage
  | ErrorMessage
  | KickedMessage;

// --- Valid message types ---

const VALID_CLIENT_MESSAGE_TYPES = new Set([
  "join",
  "playback:play",
  "playback:pause",
  "playback:seek",
  "heartbeat",
  "chat:message",
  "chat:reaction",
  "host:kick",
  "host:force-resync",
  "pong",
]);

/**
 * Parse and validate an incoming WebSocket message.
 * Returns the parsed message or null if invalid.
 */
export function parseMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw);

    // Must be an object
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    // Must have a valid type field
    if (typeof parsed.type !== "string" || !VALID_CLIENT_MESSAGE_TYPES.has(parsed.type)) {
      return null;
    }

    // Type-specific validation
    switch (parsed.type) {
      case "join":
        if (typeof parsed.roomCode !== "string" || parsed.roomCode.length === 0) return null;
        if (typeof parsed.displayName !== "string" || parsed.displayName.length === 0) return null;
        break;
      case "playback:seek":
        if (typeof parsed.position !== "number" || parsed.position < 0) return null;
        break;
      case "heartbeat":
        if (typeof parsed.position !== "number") return null;
        if (typeof parsed.isBuffering !== "boolean") return null;
        if (typeof parsed.clientTime !== "number") return null;
        break;
      case "chat:message":
        if (typeof parsed.content !== "string" || parsed.content.length === 0) return null;
        break;
      case "chat:reaction":
        if (typeof parsed.emoji !== "string" || parsed.emoji.length === 0) return null;
        break;
      case "host:kick":
        if (typeof parsed.targetId !== "string" || parsed.targetId.length === 0) return null;
        break;
      case "pong":
        if (typeof parsed.serverTime !== "number") return null;
        break;
      // playback:play, playback:pause, host:force-resync need no extra fields
    }

    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

/**
 * Serialize an outgoing server message to a JSON string.
 */
export function serializeMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
