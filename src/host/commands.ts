/**
 * Host commands: dashboard data, force-resync, kick.
 * Only the room host can issue host:* commands.
 */

import type { ServerWebSocket } from "bun";
import { roomManager } from "../rooms/manager";
import type { Room } from "../rooms/room";
import {
  sendTo,
  broadcastToRoom,
  getConnection,
  type ConnectionData,
} from "../ws/handler";
import type { ClientMessage, ServerMessage } from "../ws/protocol";
import { registerHostHandler } from "../ws/router";
import { getCurrentPosition } from "../sync/engine";

/**
 * Validate that the sender is the host of the room.
 * Returns the room if valid, or null (and sends error) if unauthorized.
 */
export function validateHost(
  ws: ServerWebSocket<ConnectionData>
): Room | null {
  const room = roomManager.getRoom(ws.data.roomCode!);
  if (!room) return null;

  if (ws.data.connectionId !== room.data.hostId) {
    const errorMsg: ServerMessage = {
      type: "error",
      code: "UNAUTHORIZED",
      message: "Only the host can perform this action",
    };
    ws.send(JSON.stringify(errorMsg));
    return null;
  }

  return room;
}

/**
 * Handle host:force-resync command.
 * Computes current authoritative position and broadcasts playback:force-resync
 * to ALL participants so they hard-seek.
 */
export function handleForceResync(room: Room): void {
  const currentPosition = getCurrentPosition(room);

  const resyncMsg: ServerMessage = {
    type: "playback:force-resync",
    position: currentPosition,
  };

  broadcastToRoom(room.data.id, resyncMsg);
}

/**
 * Handle host:kick command.
 * Marks the target as kicked, sends a kicked message, and closes their connection.
 */
export function handleKick(
  room: Room,
  targetId: string,
  ws: ServerWebSocket<ConnectionData>
): boolean {
  const participant = room.data.participants.get(targetId);

  if (!participant) {
    const errorMsg: ServerMessage = {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Target participant not found",
    };
    ws.send(JSON.stringify(errorMsg));
    return false;
  }

  // Cannot kick yourself
  if (targetId === room.data.hostId) {
    const errorMsg: ServerMessage = {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Cannot kick yourself",
    };
    ws.send(JSON.stringify(errorMsg));
    return false;
  }

  // Mark as kicked
  participant.isKicked = true;

  // Send kicked message to the target
  const kickedMsg: ServerMessage = {
    type: "kicked",
    reason: "You have been kicked by the host",
  };
  sendTo(targetId, kickedMsg);

  // Close target's WebSocket connection
  const targetWs = getConnection(targetId);
  if (targetWs) {
    targetWs.close(1000, "Kicked by host");
  }

  // Broadcast participant left to others
  broadcastToRoom(room.data.id, {
    type: "room:participant-left",
    participantId: targetId,
  });

  return true;
}

/**
 * Build dashboard data payload for the host.
 */
export function buildDashboardData(room: Room): ServerMessage {
  const participants: Array<{
    id: string;
    displayName: string;
    latency: number;
    drift: number;
    isBuffering: boolean;
  }> = [];

  for (const [, p] of room.data.participants) {
    if (!p.isKicked) {
      participants.push({
        id: p.id,
        displayName: p.displayName,
        latency: p.latency,
        drift: p.drift,
        isBuffering: p.isBuffering,
      });
    }
  }

  return {
    type: "host:dashboard",
    participants,
  };
}

// Dashboard interval tracking per room
const dashboardIntervals = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Start the dashboard broadcast interval for a room.
 * Sends host:dashboard to the host every 2 seconds.
 */
export function startDashboardBroadcast(room: Room): void {
  // Don't start if already running
  if (dashboardIntervals.has(room.data.id)) return;

  const interval = setInterval(() => {
    // Only send if there's still a host
    if (!room.data.hostId) {
      stopDashboardBroadcast(room.data.id);
      return;
    }

    const dashboardMsg = buildDashboardData(room);
    sendTo(room.data.hostId, dashboardMsg);
  }, 2000);

  dashboardIntervals.set(room.data.id, interval);
}

/**
 * Stop the dashboard broadcast for a room.
 */
export function stopDashboardBroadcast(roomId: string): void {
  const interval = dashboardIntervals.get(roomId);
  if (interval) {
    clearInterval(interval);
    dashboardIntervals.delete(roomId);
  }
}

/**
 * Reset all dashboard intervals (for testing).
 */
export function resetDashboardIntervals(): void {
  for (const [, interval] of dashboardIntervals) {
    clearInterval(interval);
  }
  dashboardIntervals.clear();
}

/**
 * Register all host command handlers with the router.
 */
export function registerHostHandlers(): void {
  // host:force-resync handler
  registerHostHandler(
    "host:force-resync",
    (ws: ServerWebSocket<ConnectionData>, _message: ClientMessage) => {
      const room = validateHost(ws);
      if (!room) return;
      handleForceResync(room);
    }
  );

  // host:kick handler
  registerHostHandler(
    "host:kick",
    (ws: ServerWebSocket<ConnectionData>, message: ClientMessage) => {
      if (message.type !== "host:kick") return;
      const room = validateHost(ws);
      if (!room) return;
      handleKick(room, message.targetId, ws);
    }
  );
}
