/**
 * Playback command handlers: play, pause, seek.
 * Processes commands, updates room state, broadcasts to participants,
 * and propagates to linked rooms.
 */

import type { ServerWebSocket } from "bun";
import type { Room } from "../rooms/room";
import { roomManager } from "../rooms/manager";
import { broadcastToRoom } from "../ws/handler";
import type { ConnectionData } from "../ws/handler";
import type { ClientMessage, ServerMessage } from "../ws/protocol";
import {
  registerPlaybackHandler,
  registerHeartbeatHandler,
} from "../ws/router";
import { getCurrentPosition, getSyncEngine } from "./engine";

/**
 * Handle play command: set isPlaying = true, update lastUpdated, broadcast.
 */
export function handlePlay(room: Room): void {
  const state = room.data.playbackState;

  // If already playing, no-op
  if (state.isPlaying) return;

  // Snapshot current position before changing state
  state.position = getCurrentPosition(room);
  state.isPlaying = true;
  state.lastUpdated = Date.now();

  // Broadcast playback:update to all participants
  const updateMsg: ServerMessage = {
    type: "playback:update",
    isPlaying: true,
    position: state.position,
    timestamp: state.lastUpdated,
  };
  broadcastToRoom(room.data.id, updateMsg);

  // Propagate to linked room
  propagateToLinkedRoom(room, () => {
    const linkedRoom = roomManager.getRoom(room.data.linkedRoomId!);
    if (linkedRoom) {
      handlePlay(linkedRoom);
    }
  });
}

/**
 * Handle pause command: set isPlaying = false, snapshot position, broadcast.
 */
export function handlePause(room: Room): void {
  const state = room.data.playbackState;

  // If already paused, no-op
  if (!state.isPlaying) return;

  // Snapshot current position
  state.position = getCurrentPosition(room);
  state.isPlaying = false;
  state.lastUpdated = Date.now();

  // Broadcast playback:update to all participants
  const updateMsg: ServerMessage = {
    type: "playback:update",
    isPlaying: false,
    position: state.position,
    timestamp: state.lastUpdated,
  };
  broadcastToRoom(room.data.id, updateMsg);

  // Propagate to linked room
  propagateToLinkedRoom(room, () => {
    const linkedRoom = roomManager.getRoom(room.data.linkedRoomId!);
    if (linkedRoom) {
      handlePause(linkedRoom);
    }
  });
}

/**
 * Handle seek command: set new position, broadcast.
 */
export function handleSeek(room: Room, position: number): void {
  const state = room.data.playbackState;

  state.position = position;
  state.lastUpdated = Date.now();

  // Broadcast playback:update to all participants
  const updateMsg: ServerMessage = {
    type: "playback:update",
    isPlaying: state.isPlaying,
    position: state.position,
    timestamp: state.lastUpdated,
  };
  broadcastToRoom(room.data.id, updateMsg);

  // Propagate to linked room
  propagateToLinkedRoom(room, () => {
    const linkedRoom = roomManager.getRoom(room.data.linkedRoomId!);
    if (linkedRoom) {
      handleSeek(linkedRoom, position);
    }
  });
}

/**
 * Propagate a command to the linked room if one exists.
 * Prevents infinite loops by only propagating one level.
 */
let propagating = false;

function propagateToLinkedRoom(room: Room, action: () => void): void {
  if (propagating) return; // Prevent infinite recursion
  if (!room.data.linkedRoomId) return;

  const linkedRoom = roomManager.getRoom(room.data.linkedRoomId);
  if (!linkedRoom) return;

  propagating = true;
  try {
    action();
  } finally {
    propagating = false;
  }
}

/**
 * Register all playback and heartbeat handlers with the router.
 */
export function registerSyncHandlers(): void {
  // playback:play handler
  registerPlaybackHandler(
    "playback:play",
    (ws: ServerWebSocket<ConnectionData>, _message: ClientMessage) => {
      const room = roomManager.getRoom(ws.data.roomCode!);
      if (!room) return;
      handlePlay(room);
    }
  );

  // playback:pause handler
  registerPlaybackHandler(
    "playback:pause",
    (ws: ServerWebSocket<ConnectionData>, _message: ClientMessage) => {
      const room = roomManager.getRoom(ws.data.roomCode!);
      if (!room) return;
      handlePause(room);
    }
  );

  // playback:seek handler
  registerPlaybackHandler(
    "playback:seek",
    (ws: ServerWebSocket<ConnectionData>, message: ClientMessage) => {
      if (message.type !== "playback:seek") return;
      const room = roomManager.getRoom(ws.data.roomCode!);
      if (!room) return;
      handleSeek(room, message.position);
    }
  );

  // heartbeat handler
  registerHeartbeatHandler(
    "heartbeat",
    (ws: ServerWebSocket<ConnectionData>, message: ClientMessage) => {
      if (message.type !== "heartbeat") return;
      const room = roomManager.getRoom(ws.data.roomCode!);
      if (!room) return;

      const engine = getSyncEngine(room);
      engine.processHeartbeat(
        ws.data.connectionId,
        message.position,
        message.isBuffering
      );
    }
  );
}
