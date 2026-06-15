/**
 * WebSocket connection handler: lifecycle management, join/disconnect, heartbeat.
 */

import type { ServerWebSocket } from "bun";
import { roomManager } from "../rooms/manager";
import type { Room } from "../rooms/room";
import {
  parseMessage,
  serializeMessage,
  type ClientMessage,
  type ServerMessage,
} from "./protocol";
import { routeMessage } from "./router";

export interface ConnectionData {
  connectionId: string;
  roomCode: string | null;
  displayName: string | null;
  missedPongs: number;
  lastPongTime: number;
  pingInterval: ReturnType<typeof setInterval> | null;
}

// Global connection registry: connectionId -> WebSocket
const connections = new Map<string, ServerWebSocket<ConnectionData>>();

let connectionCounter = 0;

/**
 * Generate a unique connection ID.
 */
function generateConnectionId(): string {
  connectionCounter++;
  return `conn_${Date.now()}_${connectionCounter}`;
}

/**
 * Get a connection by its ID.
 */
export function getConnection(
  connectionId: string
): ServerWebSocket<ConnectionData> | undefined {
  return connections.get(connectionId);
}

/**
 * Get all connections in a specific room.
 */
export function getRoomConnections(
  roomCode: string
): ServerWebSocket<ConnectionData>[] {
  const result: ServerWebSocket<ConnectionData>[] = [];
  for (const [, ws] of connections) {
    if (ws.data.roomCode === roomCode) {
      result.push(ws);
    }
  }
  return result;
}

/**
 * Send a message to a specific connection.
 */
export function sendTo(connectionId: string, msg: ServerMessage): void {
  const ws = connections.get(connectionId);
  if (ws) {
    ws.send(serializeMessage(msg));
  }
}

/**
 * Broadcast a message to all connections in a room.
 */
export function broadcastToRoom(roomCode: string, msg: ServerMessage): void {
  const serialized = serializeMessage(msg);
  for (const [, ws] of connections) {
    if (ws.data.roomCode === roomCode) {
      ws.send(serialized);
    }
  }
}

/**
 * Broadcast a message to all connections in a room except one.
 */
export function broadcastToRoomExcept(
  roomCode: string,
  excludeId: string,
  msg: ServerMessage
): void {
  const serialized = serializeMessage(msg);
  for (const [, ws] of connections) {
    if (ws.data.roomCode === roomCode && ws.data.connectionId !== excludeId) {
      ws.send(serialized);
    }
  }
}

const MAX_MISSED_PONGS = 3;

/**
 * Get the heartbeat interval (reads env each time for testability).
 */
export function getHeartbeatIntervalMs(): number {
  return parseInt(process.env.HEARTBEAT_INTERVAL_MS || "5000", 10);
}

/**
 * Start sending ping messages to a connection.
 */
function startHeartbeat(ws: ServerWebSocket<ConnectionData>): void {
  const intervalMs = getHeartbeatIntervalMs();
  const interval = setInterval(() => {
    ws.data.missedPongs++;

    if (ws.data.missedPongs >= MAX_MISSED_PONGS) {
      // Connection is dead - close it
      stopHeartbeat(ws);
      ws.close(1001, "Heartbeat timeout");
      return;
    }

    // Send ping
    const pingMsg: ServerMessage = {
      type: "ping",
      serverTime: Date.now(),
    };
    ws.send(serializeMessage(pingMsg));
  }, intervalMs);

  ws.data.pingInterval = interval;
}

/**
 * Stop heartbeat for a connection.
 */
function stopHeartbeat(ws: ServerWebSocket<ConnectionData>): void {
  if (ws.data.pingInterval !== null) {
    clearInterval(ws.data.pingInterval);
    ws.data.pingInterval = null;
  }
}

/**
 * Handle a pong response from the client.
 */
function handlePong(ws: ServerWebSocket<ConnectionData>, serverTime: number): void {
  const now = Date.now();
  ws.data.missedPongs = 0;
  ws.data.lastPongTime = now;

  // Update participant latency if in a room
  if (ws.data.roomCode) {
    const room = roomManager.getRoom(ws.data.roomCode);
    if (room) {
      const participant = room.data.participants.get(ws.data.connectionId);
      if (participant) {
        // Round-trip time divided by 2 for approximate one-way latency
        participant.latency = Math.round((now - serverTime) / 2);
      }
    }
  }
}

/**
 * Handle the join message: validate room, add participant, send room state.
 */
function handleJoin(
  ws: ServerWebSocket<ConnectionData>,
  roomCode: string,
  displayName: string
): void {
  const room = roomManager.getRoom(roomCode);

  if (!room) {
    ws.send(
      serializeMessage({
        type: "error",
        code: "ROOM_NOT_FOUND",
        message: "Room not found",
      })
    );
    return;
  }

  // Check for slot hold (reconnection)
  const existingId = roomManager.claimSlotHold(displayName, roomCode);
  let participantId: string;

  if (existingId) {
    // Reconnecting - use existing participant ID
    participantId = existingId;
    // Re-add participant with original ID
    const participant = room.addParticipant(participantId, displayName);
    if (!participant) {
      ws.send(
        serializeMessage({
          type: "error",
          code: "ROOM_FULL",
          message: "Room is full or you have been kicked",
        })
      );
      return;
    }
  } else {
    // New join - use connection ID as participant ID
    participantId = ws.data.connectionId;
    const participant = room.addParticipant(participantId, displayName);
    if (!participant) {
      ws.send(
        serializeMessage({
          type: "error",
          code: "ROOM_FULL",
          message: "Room is full or you have been kicked",
        })
      );
      return;
    }
  }

  // Update connection data
  ws.data.roomCode = roomCode;
  ws.data.displayName = displayName;

  // If we reconnected with a different participant ID, remap the connection
  if (existingId) {
    connections.delete(ws.data.connectionId);
    ws.data.connectionId = participantId;
    connections.set(participantId, ws);
  }

  // Compute current playback position
  const playbackState = room.data.playbackState;
  const now = Date.now();
  const currentPosition = playbackState.isPlaying
    ? playbackState.position + (now - playbackState.lastUpdated) / 1000
    : playbackState.position;

  // Build participant list for response
  const participants = Array.from(room.data.participants.values()).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    joinedAt: p.joinedAt,
  }));

  // Send room state to the joining client
  const stateMsg: ServerMessage = {
    type: "room:state",
    room: {
      id: room.data.id,
      videoSource: room.data.videoSource,
      hostId: room.data.hostId,
      linkedRoomId: room.data.linkedRoomId,
    },
    participants,
    playbackState: {
      isPlaying: playbackState.isPlaying,
      position: currentPosition,
      timestamp: now,
    },
    chatHistory: room.data.chatHistory,
  };
  ws.send(serializeMessage(stateMsg));

  // Broadcast participant joined to others in the room
  broadcastToRoomExcept(roomCode, ws.data.connectionId, {
    type: "room:participant-joined",
    participant: {
      id: participantId,
      displayName,
      joinedAt: Date.now(),
    },
  });
}

/**
 * Handle participant disconnect: start slot hold, notify others.
 */
function handleDisconnect(ws: ServerWebSocket<ConnectionData>): void {
  const { connectionId, roomCode, displayName } = ws.data;

  stopHeartbeat(ws);
  connections.delete(connectionId);

  if (!roomCode || !displayName) return;

  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  // Start slot hold for reconnection (keeps participant in room for 60s)
  roomManager.createSlotHold(connectionId, displayName, roomCode);

  // Broadcast participant left to others
  broadcastToRoom(roomCode, {
    type: "room:participant-left",
    participantId: connectionId,
  });
}

// --- Bun WebSocket handlers ---

export const websocketHandlers = {
  open(ws: ServerWebSocket<ConnectionData>) {
    const connectionId = generateConnectionId();
    ws.data = {
      connectionId,
      roomCode: null,
      displayName: null,
      missedPongs: 0,
      lastPongTime: Date.now(),
      pingInterval: null,
    };
    connections.set(connectionId, ws);
    startHeartbeat(ws);
  },

  message(ws: ServerWebSocket<ConnectionData>, message: string | Buffer) {
    const raw = typeof message === "string" ? message : message.toString();
    const parsed = parseMessage(raw);

    if (!parsed) {
      ws.send(
        serializeMessage({
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Invalid or malformed message",
        })
      );
      return;
    }

    // Handle join
    if (parsed.type === "join") {
      handleJoin(ws, parsed.roomCode, parsed.displayName);
      return;
    }

    // Handle pong
    if (parsed.type === "pong") {
      handlePong(ws, parsed.serverTime);
      return;
    }

    // All other messages require the client to be in a room
    if (!ws.data.roomCode) {
      ws.send(
        serializeMessage({
          type: "error",
          code: "INVALID_MESSAGE",
          message: "You must join a room first",
        })
      );
      return;
    }

    // Route to appropriate handler
    routeMessage(ws, parsed);
  },

  close(ws: ServerWebSocket<ConnectionData>, code: number, reason: string) {
    handleDisconnect(ws);
  },

  error(ws: ServerWebSocket<ConnectionData>, error: Error) {
    handleDisconnect(ws);
  },
};

/**
 * Get the total number of active connections.
 */
export function getConnectionCount(): number {
  return connections.size;
}

/**
 * Reset all connections (for testing purposes).
 */
export function resetConnections(): void {
  for (const [, ws] of connections) {
    stopHeartbeat(ws);
  }
  connections.clear();
  connectionCounter = 0;
}
