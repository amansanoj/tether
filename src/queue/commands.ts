/**
 * Queue commands: add, remove, next, prev, jump.
 * The queue is shared across all participants. Changing the current track
 * resets playback to position 0 (playing) and broadcasts the change so every
 * client loads the new source in sync.
 */

import type { ServerWebSocket } from "bun";
import { roomManager } from "../rooms/manager";
import type { Room, QueueItem, VideoSource } from "../rooms/room";
import { broadcastToRoom, type ConnectionData } from "../ws/handler";
import type { ClientMessage, ServerMessage } from "../ws/protocol";
import { registerQueueHandler } from "../ws/router";
import { getCurrentPosition } from "../sync/engine";

// Debounce auto-advance so multiple clients reporting "ended" don't skip
// several tracks at once.
const lastTrackChange = new Map<string, number>();

function broadcastQueue(room: Room): void {
  const msg: ServerMessage = {
    type: "queue:update",
    queue: room.data.queue,
    currentIndex: room.data.currentIndex,
  };
  broadcastToRoom(room.data.id, msg);
}

/**
 * Switch to a different queue index: reset playback and tell everyone to load
 * the new source.
 */
function changeTrack(room: Room, newIndex: number): void {
  if (newIndex < 0 || newIndex >= room.data.queue.length) return;

  room.data.currentIndex = newIndex;
  room.data.playbackState = {
    isPlaying: true,
    position: 0,
    lastUpdated: Date.now(),
    playbackRate: 1.0,
  };
  lastTrackChange.set(room.data.id, Date.now());

  broadcastQueue(room);
  broadcastToRoom(room.data.id, {
    type: "playback:update",
    isPlaying: true,
    position: 0,
    timestamp: Date.now(),
  });
}

function getRoom(ws: ServerWebSocket<ConnectionData>): Room | undefined {
  return ws.data.roomCode ? roomManager.getRoom(ws.data.roomCode) : undefined;
}

export function registerQueueHandlers(): void {
  registerQueueHandler("queue:add", (ws, message: ClientMessage) => {
    if (message.type !== "queue:add") return;
    const room = getRoom(ws);
    if (!room) return;

    const src = message.source;
    if (!src || typeof src.url !== "string" || src.url.length === 0) return;

    const allowed = ["file", "hls", "youtube", "vimeo"];
    const type = allowed.includes(src.type) ? src.type : "youtube";
    const source = {
      type,
      url: src.url,
      ...(src.label ? { label: src.label } : {}),
    } as VideoSource;

    const item: QueueItem = {
      id: crypto.randomUUID(),
      source,
      title: (message.title && message.title.trim()) || src.url,
      addedBy: ws.data.displayName || "Someone",
      addedById: ws.data.connectionId,
    };

    room.data.queue.push(item);
    broadcastQueue(room);
  });

  registerQueueHandler("queue:remove", (ws, message: ClientMessage) => {
    if (message.type !== "queue:remove") return;
    const room = getRoom(ws);
    if (!room) return;

    const idx = room.data.queue.findIndex((q) => q.id === message.id);
    if (idx === -1) return;

    const wasCurrent = idx === room.data.currentIndex;
    room.data.queue.splice(idx, 1);

    if (idx < room.data.currentIndex) {
      room.data.currentIndex--;
    }
    if (room.data.currentIndex >= room.data.queue.length) {
      room.data.currentIndex = Math.max(0, room.data.queue.length - 1);
    }

    if (wasCurrent && room.data.queue.length > 0) {
      // The playing track was removed — load the track now at that index.
      changeTrack(room, room.data.currentIndex);
    } else {
      broadcastQueue(room);
    }
  });

  registerQueueHandler("queue:next", (ws) => {
    const room = getRoom(ws);
    if (!room) return;

    // Debounce: ignore rapid "next" (e.g. every client reporting song ended).
    const last = lastTrackChange.get(room.data.id) || 0;
    if (Date.now() - last < 1500) return;

    if (room.data.currentIndex < room.data.queue.length - 1) {
      changeTrack(room, room.data.currentIndex + 1);
    } else if (room.data.playbackState.isPlaying) {
      // End of the queue — stop the authoritative clock so drift doesn't keep
      // accumulating against a finished video.
      room.data.playbackState.position = getCurrentPosition(room);
      room.data.playbackState.isPlaying = false;
      room.data.playbackState.lastUpdated = Date.now();
      lastTrackChange.set(room.data.id, Date.now());
      broadcastToRoom(room.data.id, {
        type: "playback:update",
        isPlaying: false,
        position: room.data.playbackState.position,
        timestamp: Date.now(),
      });
    }
  });

  registerQueueHandler("queue:prev", (ws) => {
    const room = getRoom(ws);
    if (!room) return;
    if (room.data.currentIndex > 0) {
      changeTrack(room, room.data.currentIndex - 1);
    }
  });

  registerQueueHandler("queue:jump", (ws, message: ClientMessage) => {
    if (message.type !== "queue:jump") return;
    const room = getRoom(ws);
    if (!room) return;
    changeTrack(room, message.index);
  });
}
