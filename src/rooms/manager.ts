/**
 * Room manager: in-memory storage, creation, lookup, lifecycle management.
 */

import { generateRoomCode } from "../utils/id";
import { Room, type VideoSource, type AudioTrack } from "./room";

const GRACE_PERIOD_MS = parseInt(
  process.env.CLEANUP_GRACE_PERIOD_MS || "300000",
  10
);
const SLOT_HOLD_MS = 60000; // 60 seconds for reconnection

interface SlotHold {
  participantId: string;
  displayName: string;
  roomCode: string;
  timer: ReturnType<typeof setTimeout>;
}

class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private slotHolds: Map<string, SlotHold> = new Map();

  /**
   * Creates a new room with the given video source.
   * Optionally creates a linked room if linkedVideoSource is provided.
   * Returns the room code(s).
   */
  createRoom(
    videoSource: VideoSource,
    linkedVideoSource?: VideoSource,
    audioTracks: AudioTrack[] = []
  ): { roomCode: string; linkedRoomCode?: string } {
    const existingCodes = new Set(this.rooms.keys());

    const roomCode = generateRoomCode(existingCodes);
    const room = new Room(roomCode, videoSource, audioTracks);
    room.data.queue.push({
      id: crypto.randomUUID(),
      source: videoSource,
      title: videoSource.label || "Track 1",
      addedBy: "host",
    });
    this.rooms.set(roomCode, room);

    let linkedRoomCode: string | undefined;

    if (linkedVideoSource) {
      existingCodes.add(roomCode);
      linkedRoomCode = generateRoomCode(existingCodes);
      const linkedRoom = new Room(linkedRoomCode, linkedVideoSource);
      linkedRoom.data.queue.push({
        id: crypto.randomUUID(),
        source: linkedVideoSource,
        title: linkedVideoSource.label || "Track 1",
        addedBy: "host",
      });
      this.rooms.set(linkedRoomCode, linkedRoom);

      // Link rooms together
      room.data.linkedRoomId = linkedRoomCode;
      linkedRoom.data.linkedRoomId = roomCode;
    }

    return { roomCode, linkedRoomCode };
  }

  /**
   * Gets a room by its code.
   */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  /**
   * Deletes a room by its code.
   */
  deleteRoom(code: string): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;

    // Clear cleanup timer if any
    if (room.data.cleanupTimer !== null) {
      clearTimeout(room.data.cleanupTimer);
    }

    // Unlink paired room
    if (room.data.linkedRoomId) {
      const linked = this.rooms.get(room.data.linkedRoomId);
      if (linked) {
        linked.data.linkedRoomId = null;
      }
    }

    // Clean up any slot holds for this room
    for (const [key, hold] of this.slotHolds) {
      if (hold.roomCode === code) {
        clearTimeout(hold.timer);
        this.slotHolds.delete(key);
      }
    }

    return this.rooms.delete(code);
  }

  /**
   * Returns the total number of active rooms.
   */
  getRoomCount(): number {
    return this.rooms.size;
  }

  /**
   * Starts the grace period timer for an empty room.
   * After GRACE_PERIOD_MS, the room is deleted.
   */
  startGracePeriod(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;

    // Only start if room is empty
    if (room.getParticipantCount() > 0) return;

    // Don't start if already running
    if (room.data.cleanupTimer !== null) return;

    room.data.cleanupTimer = setTimeout(() => {
      // Check again that room is still empty
      const currentRoom = this.rooms.get(code);
      if (currentRoom && currentRoom.getParticipantCount() === 0) {
        this.deleteRoom(code);
      }
    }, GRACE_PERIOD_MS);
  }

  /**
   * Creates a participant slot hold for reconnection.
   * The slot is reserved for SLOT_HOLD_MS (60 seconds).
   */
  createSlotHold(
    participantId: string,
    displayName: string,
    roomCode: string
  ): void {
    // Clear existing hold for this participant
    const existing = this.slotHolds.get(participantId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.slotHolds.delete(participantId);
      // After slot hold expires, remove participant from room
      const room = this.rooms.get(roomCode);
      if (room) {
        room.removeParticipant(participantId);
        // If room is now empty, start grace period
        if (room.getParticipantCount() === 0) {
          this.startGracePeriod(roomCode);
        }
      }
    }, SLOT_HOLD_MS);

    this.slotHolds.set(participantId, {
      participantId,
      displayName,
      roomCode,
      timer,
    });
  }

  /**
   * Checks if a slot hold exists for a display name in a room.
   * If found, clears the hold and returns the participant ID.
   */
  claimSlotHold(displayName: string, roomCode: string): string | null {
    for (const [key, hold] of this.slotHolds) {
      if (hold.displayName === displayName && hold.roomCode === roomCode) {
        clearTimeout(hold.timer);
        this.slotHolds.delete(key);
        return hold.participantId;
      }
    }
    return null;
  }
}

// Singleton instance
export const roomManager = new RoomManager();
