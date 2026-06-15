/**
 * Sync engine: authoritative playback clock, drift detection, rate adjustment.
 * Each room has its own SyncEngine instance.
 */

import type { Room } from "../rooms/room";
import { sendTo } from "../ws/handler";
import type { ServerMessage } from "../ws/protocol";

const DRIFT_THRESHOLD_HIGH = 3.0; // seconds - triggers rate adjustment
const DRIFT_THRESHOLD_LOW = 0.5; // seconds - resets rate to 1.0
const MIN_RATE = 0.8;
const MAX_RATE = 1.2;

/**
 * Compute the current authoritative playback position for a room.
 * When playing, position advances with elapsed time.
 * When paused, position stays fixed.
 */
export function getCurrentPosition(room: Room): number {
  const { isPlaying, position, lastUpdated } = room.data.playbackState;

  if (!isPlaying) {
    return position;
  }

  const elapsed = (Date.now() - lastUpdated) / 1000;
  return position + elapsed;
}

/**
 * Compute the suggested playback rate based on drift magnitude.
 * Uses a linear scale between MIN_RATE and MAX_RATE.
 *
 * - drift > 0: client is ahead, slow down (rate < 1.0)
 * - drift < 0: client is behind, speed up (rate > 1.0)
 */
export function computeSuggestedRate(drift: number): number {
  const absDrift = Math.abs(drift);

  // Cap drift for rate calculation (beyond a certain point, max rate applies)
  // Scale: at drift = 3.0s, rate starts changing; at drift = 10s, max rate reached
  const maxDriftForScaling = 10.0;
  const scaledDrift = Math.min(absDrift, maxDriftForScaling);

  // Linear interpolation between 1.0 and the max deviation (0.2)
  const rateDeviation = 0.2 * ((scaledDrift - DRIFT_THRESHOLD_HIGH) / (maxDriftForScaling - DRIFT_THRESHOLD_HIGH));
  const clampedDeviation = Math.max(0, Math.min(0.2, rateDeviation));

  if (drift > 0) {
    // Client is ahead - slow down
    return Math.max(MIN_RATE, 1.0 - clampedDeviation);
  } else {
    // Client is behind - speed up
    return Math.min(MAX_RATE, 1.0 + clampedDeviation);
  }
}

/**
 * SyncEngine manages drift detection and rate adjustment for a single room.
 */
export class SyncEngine {
  private room: Room;

  constructor(room: Room) {
    this.room = room;
  }

  /**
   * Get the current authoritative position for this room.
   */
  getCurrentPosition(): number {
    return getCurrentPosition(this.room);
  }

  /**
   * Process a heartbeat from a participant.
   * Computes drift and sends sync:adjust if needed.
   */
  processHeartbeat(
    connectionId: string,
    reportedPosition: number,
    isBuffering: boolean
  ): { drift: number; suggestedRate: number | null } {
    const authPosition = this.getCurrentPosition();
    const drift = reportedPosition - authPosition;

    // Update participant state
    this.updateParticipantState(connectionId, reportedPosition, drift, isBuffering);

    // If buffering, do not penalize - no adjustment sent
    if (isBuffering) {
      return { drift, suggestedRate: null };
    }

    const absDrift = Math.abs(drift);

    if (absDrift > DRIFT_THRESHOLD_HIGH) {
      // Large drift - compute rate adjustment
      const suggestedRate = computeSuggestedRate(drift);
      const adjustMsg: ServerMessage = {
        type: "sync:adjust",
        drift,
        suggestedRate,
      };
      sendTo(connectionId, adjustMsg);
      return { drift, suggestedRate };
    } else if (absDrift <= DRIFT_THRESHOLD_LOW) {
      // Small drift - reset to normal rate
      const adjustMsg: ServerMessage = {
        type: "sync:adjust",
        drift,
        suggestedRate: 1.0,
      };
      sendTo(connectionId, adjustMsg);
      return { drift, suggestedRate: 1.0 };
    }

    // Dead zone (between 0.5 and 3.0) - no adjustment
    return { drift, suggestedRate: null };
  }

  /**
   * Update a participant's state with latest heartbeat data.
   */
  updateParticipantState(
    connectionId: string,
    reportedPosition: number,
    drift: number,
    isBuffering: boolean
  ): void {
    const participant = this.room.data.participants.get(connectionId);
    if (participant) {
      participant.reportedPosition = reportedPosition;
      participant.drift = drift;
      participant.isBuffering = isBuffering;
      participant.lastHeartbeat = Date.now();
    }
  }
}

// Store sync engines per room
const syncEngines = new Map<string, SyncEngine>();

/**
 * Get or create a SyncEngine for a room.
 */
export function getSyncEngine(room: Room): SyncEngine {
  let engine = syncEngines.get(room.data.id);
  if (!engine) {
    engine = new SyncEngine(room);
    syncEngines.set(room.data.id, engine);
  }
  return engine;
}

/**
 * Remove a SyncEngine when its room is deleted.
 */
export function removeSyncEngine(roomId: string): void {
  syncEngines.delete(roomId);
}

/**
 * Reset all sync engines (for testing).
 */
export function resetSyncEngines(): void {
  syncEngines.clear();
}
