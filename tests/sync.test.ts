import { describe, test, expect, beforeEach } from "bun:test";
import { Room, type VideoSource } from "../src/rooms/room";
import { roomManager } from "../src/rooms/manager";
import {
  SyncEngine,
  getCurrentPosition,
  computeSuggestedRate,
  getSyncEngine,
  resetSyncEngines,
} from "../src/sync/engine";
import { handlePlay, handlePause, handleSeek } from "../src/sync/commands";

const testVideoSource: VideoSource = {
  type: "hls",
  url: "https://example.com/video.m3u8",
};

// ==============================
// Authoritative Clock Tests
// ==============================

describe("Authoritative Clock", () => {
  let room: Room;

  beforeEach(() => {
    room = new Room("TEST01", testVideoSource);
  });

  test("returns position when paused (no time advancement)", () => {
    room.data.playbackState.isPlaying = false;
    room.data.playbackState.position = 60.0;
    room.data.playbackState.lastUpdated = Date.now() - 5000;

    const pos = getCurrentPosition(room);
    expect(pos).toBe(60.0);
  });

  test("advances position based on elapsed time when playing", () => {
    const now = Date.now();
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 100.0;
    room.data.playbackState.lastUpdated = now - 3000; // 3 seconds ago

    const pos = getCurrentPosition(room);
    // Should be approximately 103 seconds (100 + 3)
    expect(pos).toBeGreaterThanOrEqual(102.9);
    expect(pos).toBeLessThanOrEqual(103.1);
  });

  test("position stays at 0 when freshly created and paused", () => {
    const pos = getCurrentPosition(room);
    expect(pos).toBe(0);
  });

  test("handles large elapsed time correctly", () => {
    const now = Date.now();
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 0;
    room.data.playbackState.lastUpdated = now - 3600000; // 1 hour ago

    const pos = getCurrentPosition(room);
    // Should be approximately 3600 seconds
    expect(pos).toBeGreaterThanOrEqual(3599.9);
    expect(pos).toBeLessThanOrEqual(3600.1);
  });

  test("SyncEngine.getCurrentPosition matches standalone function", () => {
    const engine = new SyncEngine(room);
    const now = Date.now();
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 50.0;
    room.data.playbackState.lastUpdated = now - 2000;

    const enginePos = engine.getCurrentPosition();
    const fnPos = getCurrentPosition(room);
    expect(enginePos).toBe(fnPos);
  });

  test("caps the position at the known duration", () => {
    const now = Date.now();
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 100.0;
    room.data.playbackState.lastUpdated = now - 60000; // 60s ago -> would be 160
    room.data.playbackState.duration = 105;

    // Without a cap this would be ~160; the clock must stop at the duration.
    expect(getCurrentPosition(room)).toBe(105);
  });

  test("does not cap when duration is unknown (0)", () => {
    const now = Date.now();
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 100.0;
    room.data.playbackState.lastUpdated = now - 10000;
    room.data.playbackState.duration = 0;

    expect(getCurrentPosition(room)).toBeGreaterThanOrEqual(109.9);
  });

  test("processHeartbeat records the reported duration", () => {
    room.addParticipant("conn_1", "Alice");
    const engine = new SyncEngine(room);
    engine.processHeartbeat("conn_1", 10, false, 240);
    expect(room.data.playbackState.duration).toBe(240);
  });
});

// ==============================
// Drift Detection Tests
// ==============================

describe("Drift Detection", () => {
  let room: Room;
  let engine: SyncEngine;

  beforeEach(() => {
    room = new Room("DRIFT1", testVideoSource);
    room.addParticipant("conn_1", "Alice");
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 100.0;
    room.data.playbackState.lastUpdated = Date.now();
    engine = new SyncEngine(room);
  });

  test("drift below 0.5s triggers suggestedRate of 1.0", () => {
    // Report position very close to authoritative
    const authPos = engine.getCurrentPosition();
    const result = engine.processHeartbeat("conn_1", authPos + 0.2, false);

    expect(result.suggestedRate).toBe(1.0);
    expect(Math.abs(result.drift)).toBeLessThanOrEqual(0.5);
  });

  test("drift exactly at 0 sends rate 1.0", () => {
    const authPos = engine.getCurrentPosition();
    const result = engine.processHeartbeat("conn_1", authPos, false);

    expect(result.suggestedRate).toBe(1.0);
    expect(Math.abs(result.drift)).toBeLessThanOrEqual(0.5);
  });

  test("drift between 0.5 and 3.0 is dead zone (no adjustment)", () => {
    const authPos = engine.getCurrentPosition();
    // Report position 1.5 seconds ahead
    const result = engine.processHeartbeat("conn_1", authPos + 1.5, false);

    expect(result.suggestedRate).toBeNull();
    expect(Math.abs(result.drift)).toBeGreaterThan(0.5);
    expect(Math.abs(result.drift)).toBeLessThanOrEqual(3.0);
  });

  test("drift between -0.5 and -3.0 is dead zone (no adjustment)", () => {
    const authPos = engine.getCurrentPosition();
    // Report position 2 seconds behind
    const result = engine.processHeartbeat("conn_1", authPos - 2.0, false);

    expect(result.suggestedRate).toBeNull();
    expect(Math.abs(result.drift)).toBeGreaterThan(0.5);
    expect(Math.abs(result.drift)).toBeLessThanOrEqual(3.0);
  });

  test("drift above 3.0s (client ahead) triggers rate < 1.0", () => {
    const authPos = engine.getCurrentPosition();
    // Report position 5 seconds ahead of authoritative
    const result = engine.processHeartbeat("conn_1", authPos + 5.0, false);

    expect(result.suggestedRate).not.toBeNull();
    expect(result.suggestedRate!).toBeLessThan(1.0);
    expect(result.suggestedRate!).toBeGreaterThanOrEqual(0.8);
  });

  test("drift below -3.0s (client behind) triggers rate > 1.0", () => {
    const authPos = engine.getCurrentPosition();
    // Report position 5 seconds behind authoritative
    const result = engine.processHeartbeat("conn_1", authPos - 5.0, false);

    expect(result.suggestedRate).not.toBeNull();
    expect(result.suggestedRate!).toBeGreaterThan(1.0);
    expect(result.suggestedRate!).toBeLessThanOrEqual(1.2);
  });

  test("very large drift caps rate at boundaries", () => {
    const authPos = engine.getCurrentPosition();
    // Report position 100 seconds ahead
    const result = engine.processHeartbeat("conn_1", authPos + 100.0, false);

    expect(result.suggestedRate).not.toBeNull();
    expect(result.suggestedRate!).toBe(0.8);
  });

  test("very large negative drift caps rate at max", () => {
    const authPos = engine.getCurrentPosition();
    // Report position 100 seconds behind
    const result = engine.processHeartbeat("conn_1", authPos - 100.0, false);

    expect(result.suggestedRate).not.toBeNull();
    expect(result.suggestedRate!).toBe(1.2);
  });
});

// ==============================
// Buffering Exemption Tests
// ==============================

describe("Buffering Exemption", () => {
  let room: Room;
  let engine: SyncEngine;

  beforeEach(() => {
    room = new Room("BUFF01", testVideoSource);
    room.addParticipant("conn_1", "Bob");
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 100.0;
    room.data.playbackState.lastUpdated = Date.now();
    engine = new SyncEngine(room);
  });

  test("buffering client with large drift gets no adjustment", () => {
    const authPos = engine.getCurrentPosition();
    // 10 seconds behind but buffering - should not get rate adjustment
    const result = engine.processHeartbeat("conn_1", authPos - 10.0, true);

    expect(result.suggestedRate).toBeNull();
    expect(result.drift).toBeLessThan(-3.0);
  });

  test("buffering client with small drift gets no adjustment", () => {
    const authPos = engine.getCurrentPosition();
    const result = engine.processHeartbeat("conn_1", authPos + 0.1, true);

    expect(result.suggestedRate).toBeNull();
  });

  test("buffering state is updated on participant", () => {
    const authPos = engine.getCurrentPosition();
    engine.processHeartbeat("conn_1", authPos, true);

    const participant = room.data.participants.get("conn_1");
    expect(participant).not.toBeUndefined();
    expect(participant!.isBuffering).toBe(true);
  });

  test("non-buffering state is updated on participant", () => {
    const authPos = engine.getCurrentPosition();
    engine.processHeartbeat("conn_1", authPos, false);

    const participant = room.data.participants.get("conn_1");
    expect(participant!.isBuffering).toBe(false);
  });
});

// ==============================
// Rate Suggestion Calculation Tests
// ==============================

describe("computeSuggestedRate", () => {
  test("positive drift (client ahead) returns rate below 1.0", () => {
    const rate = computeSuggestedRate(5.0);
    expect(rate).toBeLessThan(1.0);
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });

  test("negative drift (client behind) returns rate above 1.0", () => {
    const rate = computeSuggestedRate(-5.0);
    expect(rate).toBeGreaterThan(1.0);
    expect(rate).toBeLessThanOrEqual(1.2);
  });

  test("drift at threshold (3.0) returns rate close to 1.0", () => {
    const ratePositive = computeSuggestedRate(3.0);
    // At exactly the threshold, deviation should be minimal
    expect(ratePositive).toBeGreaterThanOrEqual(0.99);
    expect(ratePositive).toBeLessThanOrEqual(1.0);
  });

  test("drift at max scaling (10.0) returns boundary rate", () => {
    const rate = computeSuggestedRate(10.0);
    expect(rate).toBe(0.8);
  });

  test("drift beyond max scaling still caps at boundary", () => {
    const rate = computeSuggestedRate(50.0);
    expect(rate).toBe(0.8);
  });

  test("negative drift at max scaling returns 1.2", () => {
    const rate = computeSuggestedRate(-10.0);
    expect(rate).toBe(1.2);
  });

  test("rate scales linearly between threshold and max", () => {
    const rateMid = computeSuggestedRate(6.5); // midpoint between 3 and 10
    // Should be around 0.9 (midpoint between 1.0 and 0.8)
    expect(rateMid).toBeGreaterThan(0.8);
    expect(rateMid).toBeLessThan(1.0);
  });
});

// ==============================
// Participant State Update Tests
// ==============================

describe("Participant State Updates", () => {
  let room: Room;
  let engine: SyncEngine;

  beforeEach(() => {
    room = new Room("STATE1", testVideoSource);
    room.addParticipant("conn_1", "Charlie");
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 50.0;
    room.data.playbackState.lastUpdated = Date.now();
    engine = new SyncEngine(room);
  });

  test("updates reportedPosition on heartbeat", () => {
    engine.processHeartbeat("conn_1", 55.0, false);

    const participant = room.data.participants.get("conn_1");
    expect(participant!.reportedPosition).toBe(55.0);
  });

  test("updates drift on heartbeat", () => {
    const authPos = engine.getCurrentPosition();
    engine.processHeartbeat("conn_1", authPos + 2.0, false);

    const participant = room.data.participants.get("conn_1");
    expect(participant!.drift).toBeCloseTo(2.0, 1);
  });

  test("updates lastHeartbeat timestamp", () => {
    const before = Date.now();
    engine.processHeartbeat("conn_1", 50.0, false);
    const after = Date.now();

    const participant = room.data.participants.get("conn_1");
    expect(participant!.lastHeartbeat).toBeGreaterThanOrEqual(before);
    expect(participant!.lastHeartbeat).toBeLessThanOrEqual(after);
  });

  test("handles heartbeat for non-existent participant gracefully", () => {
    // Should not throw
    const result = engine.processHeartbeat("nonexistent", 50.0, false);
    expect(result.drift).toBeDefined();
  });
});

// ==============================
// Play/Pause/Seek Command Tests
// ==============================

describe("Playback Commands", () => {
  let room: Room;

  beforeEach(() => {
    resetSyncEngines();
    room = new Room("CMD001", testVideoSource);
    room.data.playbackState.isPlaying = false;
    room.data.playbackState.position = 30.0;
    room.data.playbackState.lastUpdated = Date.now();
  });

  test("handlePlay sets isPlaying to true", () => {
    handlePlay(room);
    expect(room.data.playbackState.isPlaying).toBe(true);
  });

  test("handlePlay updates lastUpdated", () => {
    const before = Date.now();
    handlePlay(room);
    const after = Date.now();

    expect(room.data.playbackState.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(room.data.playbackState.lastUpdated).toBeLessThanOrEqual(after);
  });

  test("handlePlay is no-op if already playing", () => {
    room.data.playbackState.isPlaying = true;
    const originalTimestamp = room.data.playbackState.lastUpdated;

    handlePlay(room);
    // lastUpdated should not change since it is already playing
    expect(room.data.playbackState.lastUpdated).toBe(originalTimestamp);
  });

  test("handlePause sets isPlaying to false", () => {
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 30.0;
    room.data.playbackState.lastUpdated = Date.now();

    handlePause(room);
    expect(room.data.playbackState.isPlaying).toBe(false);
  });

  test("handlePause snapshots current position", () => {
    const now = Date.now();
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 30.0;
    room.data.playbackState.lastUpdated = now - 5000; // 5 seconds ago

    handlePause(room);

    // Position should be approximately 35 seconds (30 + 5)
    expect(room.data.playbackState.position).toBeGreaterThanOrEqual(34.9);
    expect(room.data.playbackState.position).toBeLessThanOrEqual(35.1);
  });

  test("handlePause is no-op if already paused", () => {
    room.data.playbackState.isPlaying = false;
    const originalTimestamp = room.data.playbackState.lastUpdated;
    const originalPosition = room.data.playbackState.position;

    handlePause(room);
    expect(room.data.playbackState.lastUpdated).toBe(originalTimestamp);
    expect(room.data.playbackState.position).toBe(originalPosition);
  });

  test("handleSeek sets new position", () => {
    handleSeek(room, 120.0);
    expect(room.data.playbackState.position).toBe(120.0);
  });

  test("handleSeek updates lastUpdated", () => {
    const before = Date.now();
    handleSeek(room, 120.0);
    const after = Date.now();

    expect(room.data.playbackState.lastUpdated).toBeGreaterThanOrEqual(before);
    expect(room.data.playbackState.lastUpdated).toBeLessThanOrEqual(after);
  });

  test("handleSeek preserves isPlaying state", () => {
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.lastUpdated = Date.now();

    handleSeek(room, 200.0);
    expect(room.data.playbackState.isPlaying).toBe(true);
    expect(room.data.playbackState.position).toBe(200.0);
  });

  test("handleSeek to 0 works correctly", () => {
    room.data.playbackState.position = 500.0;

    handleSeek(room, 0);
    expect(room.data.playbackState.position).toBe(0);
  });
});

// ==============================
// Linked Room Propagation Tests
// ==============================

describe("Linked Room Command Propagation", () => {
  beforeEach(() => {
    resetSyncEngines();
    // Clean up any existing rooms
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
  });

  test("handlePlay propagates to linked room", () => {
    const { roomCode, linkedRoomCode } = roomManager.createRoom(
      testVideoSource,
      { type: "hls", url: "https://example.com/linked.m3u8" }
    );

    const room = roomManager.getRoom(roomCode)!;
    const linkedRoom = roomManager.getRoom(linkedRoomCode!)!;

    // Both rooms start paused
    expect(room.data.playbackState.isPlaying).toBe(false);
    expect(linkedRoom.data.playbackState.isPlaying).toBe(false);

    handlePlay(room);

    expect(room.data.playbackState.isPlaying).toBe(true);
    expect(linkedRoom.data.playbackState.isPlaying).toBe(true);
  });

  test("handlePause propagates to linked room", () => {
    const { roomCode, linkedRoomCode } = roomManager.createRoom(
      testVideoSource,
      { type: "hls", url: "https://example.com/linked.m3u8" }
    );

    const room = roomManager.getRoom(roomCode)!;
    const linkedRoom = roomManager.getRoom(linkedRoomCode!)!;

    // Start both rooms playing
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.lastUpdated = Date.now();
    linkedRoom.data.playbackState.isPlaying = true;
    linkedRoom.data.playbackState.lastUpdated = Date.now();

    handlePause(room);

    expect(room.data.playbackState.isPlaying).toBe(false);
    expect(linkedRoom.data.playbackState.isPlaying).toBe(false);
  });

  test("handleSeek propagates to linked room", () => {
    const { roomCode, linkedRoomCode } = roomManager.createRoom(
      testVideoSource,
      { type: "hls", url: "https://example.com/linked.m3u8" }
    );

    const room = roomManager.getRoom(roomCode)!;
    const linkedRoom = roomManager.getRoom(linkedRoomCode!)!;

    handleSeek(room, 75.0);

    expect(room.data.playbackState.position).toBe(75.0);
    expect(linkedRoom.data.playbackState.position).toBe(75.0);
  });

  test("propagation does not cause infinite loop", () => {
    const { roomCode, linkedRoomCode } = roomManager.createRoom(
      testVideoSource,
      { type: "hls", url: "https://example.com/linked.m3u8" }
    );

    const room = roomManager.getRoom(roomCode)!;
    const linkedRoom = roomManager.getRoom(linkedRoomCode!)!;

    // This should complete without infinite recursion
    handlePlay(room);
    expect(room.data.playbackState.isPlaying).toBe(true);
    expect(linkedRoom.data.playbackState.isPlaying).toBe(true);
  });

  test("command without linked room does not throw", () => {
    const { roomCode } = roomManager.createRoom(testVideoSource);
    const room = roomManager.getRoom(roomCode)!;

    // Should not throw even without linked room
    expect(() => handlePlay(room)).not.toThrow();
    expect(() => handlePause(room)).not.toThrow();
    expect(() => handleSeek(room, 50.0)).not.toThrow();
  });
});

// ==============================
// SyncEngine Factory Tests
// ==============================

describe("SyncEngine Factory", () => {
  beforeEach(() => {
    resetSyncEngines();
  });

  test("getSyncEngine creates engine for new room", () => {
    const room = new Room("FAC001", testVideoSource);
    const engine = getSyncEngine(room);
    expect(engine).toBeInstanceOf(SyncEngine);
  });

  test("getSyncEngine returns same engine for same room", () => {
    const room = new Room("FAC002", testVideoSource);
    const engine1 = getSyncEngine(room);
    const engine2 = getSyncEngine(room);
    expect(engine1).toBe(engine2);
  });

  test("getSyncEngine creates different engines for different rooms", () => {
    const room1 = new Room("FAC003", testVideoSource);
    const room2 = new Room("FAC004", testVideoSource);
    const engine1 = getSyncEngine(room1);
    const engine2 = getSyncEngine(room2);
    expect(engine1).not.toBe(engine2);
  });
});
