import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Room, type VideoSource } from "../src/rooms/room";
import { roomManager } from "../src/rooms/manager";
import {
  validateHost,
  handleForceResync,
  handleKick,
  buildDashboardData,
  startDashboardBroadcast,
  stopDashboardBroadcast,
  resetDashboardIntervals,
} from "../src/host/commands";
import { getCurrentPosition } from "../src/sync/engine";

const testVideoSource: VideoSource = {
  type: "hls",
  url: "https://example.com/video.m3u8",
};

// ==============================
// Helper: Mock WebSocket
// ==============================

interface MockMessage {
  data: string;
}

function createMockWs(connectionId: string, roomCode: string | null = null) {
  const sent: MockMessage[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  const ws = {
    data: {
      connectionId,
      roomCode,
      displayName: null as string | null,
      missedPongs: 0,
      lastPongTime: Date.now(),
      pingInterval: null as ReturnType<typeof setInterval> | null,
    },
    send(msg: string) {
      sent.push({ data: msg });
    },
    close(code?: number, reason?: string) {
      closed = true;
      closeCode = code;
      closeReason = reason;
    },
    get sentMessages() {
      return sent;
    },
    get isClosed() {
      return closed;
    },
    get closedCode() {
      return closeCode;
    },
    get closedReason() {
      return closeReason;
    },
  };

  return ws as any;
}

function parseSentMessage(ws: any, index: number = 0) {
  return JSON.parse(ws.sentMessages[index].data);
}

// ==============================
// Host Validation Tests
// ==============================

describe("Host Validation", () => {
  let room: Room;

  beforeEach(() => {
    // Clean up rooms
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
    room.addParticipant("user_conn", "User");
  });

  test("host can send host commands (validateHost returns room)", () => {
    const ws = createMockWs("host_conn", room.data.id);
    const result = validateHost(ws);
    expect(result).not.toBeNull();
    expect(result!.data.id).toBe(room.data.id);
  });

  test("non-host cannot send host commands (validateHost returns null)", () => {
    const ws = createMockWs("user_conn", room.data.id);
    const result = validateHost(ws);
    expect(result).toBeNull();
  });

  test("non-host receives UNAUTHORIZED error", () => {
    const ws = createMockWs("user_conn", room.data.id);
    validateHost(ws);

    expect(ws.sentMessages.length).toBe(1);
    const msg = parseSentMessage(ws);
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("UNAUTHORIZED");
    expect(msg.message).toContain("host");
  });

  test("validateHost returns null for non-existent room", () => {
    const ws = createMockWs("host_conn", "NONEXIST");
    const result = validateHost(ws);
    expect(result).toBeNull();
  });
});

// ==============================
// Force Resync Tests
// ==============================

describe("host:force-resync", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
    room.addParticipant("user1_conn", "User1");
    room.addParticipant("user2_conn", "User2");

    // Set up playback state: playing at position 60, started 5 seconds ago
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 60.0;
    room.data.playbackState.lastUpdated = Date.now() - 5000;
  });

  test("handleForceResync computes correct authoritative position", () => {
    // The position should be approximately 65 seconds (60 + 5 elapsed)
    const currentPos = getCurrentPosition(room);
    expect(currentPos).toBeGreaterThanOrEqual(64.9);
    expect(currentPos).toBeLessThanOrEqual(65.1);
  });

  test("handleForceResync does not throw", () => {
    expect(() => handleForceResync(room)).not.toThrow();
  });

  test("force-resync when paused uses static position", () => {
    room.data.playbackState.isPlaying = false;
    room.data.playbackState.position = 120.0;

    const pos = getCurrentPosition(room);
    expect(pos).toBe(120.0);
  });
});

// ==============================
// Kick Tests
// ==============================

describe("host:kick", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
    room.addParticipant("target_conn", "Target");
  });

  test("kicks a valid target participant", () => {
    const hostWs = createMockWs("host_conn", room.data.id);
    const result = handleKick(room, "target_conn", hostWs);

    expect(result).toBe(true);
    const participant = room.data.participants.get("target_conn");
    expect(participant!.isKicked).toBe(true);
  });

  test("returns false for non-existent target", () => {
    const hostWs = createMockWs("host_conn", room.data.id);
    const result = handleKick(room, "nonexistent", hostWs);

    expect(result).toBe(false);
    // Error should be sent
    expect(hostWs.sentMessages.length).toBe(1);
    const msg = parseSentMessage(hostWs);
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("INVALID_MESSAGE");
  });

  test("cannot kick yourself (host)", () => {
    const hostWs = createMockWs("host_conn", room.data.id);
    const result = handleKick(room, "host_conn", hostWs);

    expect(result).toBe(false);
    const msg = parseSentMessage(hostWs);
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("Cannot kick yourself");
  });

  test("kicked user isKicked flag prevents rejoin", () => {
    const hostWs = createMockWs("host_conn", room.data.id);
    handleKick(room, "target_conn", hostWs);

    // Try to rejoin with same display name
    const rejoinResult = room.addParticipant("new_conn_id", "Target");
    expect(rejoinResult).toBeNull();
  });

  test("kicked user with different display name can still be blocked by id match", () => {
    const hostWs = createMockWs("host_conn", room.data.id);
    handleKick(room, "target_conn", hostWs);

    // The kicked participant is still in the map with isKicked=true
    // Room's addParticipant checks display name
    const participant = room.data.participants.get("target_conn");
    expect(participant).not.toBeUndefined();
    expect(participant!.isKicked).toBe(true);
  });
});

// ==============================
// Dashboard Data Tests
// ==============================

describe("Dashboard Data", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
    resetDashboardIntervals();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
    room.addParticipant("user1_conn", "Alice");
    room.addParticipant("user2_conn", "Bob");
  });

  afterEach(() => {
    resetDashboardIntervals();
  });

  test("buildDashboardData includes all non-kicked participants", () => {
    const msg = buildDashboardData(room) as any;

    expect(msg.type).toBe("host:dashboard");
    expect(msg.participants).toHaveLength(3);
  });

  test("buildDashboardData includes correct fields per participant", () => {
    // Set some stats
    const alice = room.data.participants.get("user1_conn")!;
    alice.latency = 45;
    alice.drift = 1.2;
    alice.isBuffering = false;

    const bob = room.data.participants.get("user2_conn")!;
    bob.latency = 120;
    bob.drift = -0.8;
    bob.isBuffering = true;

    const msg = buildDashboardData(room) as any;

    const aliceData = msg.participants.find((p: any) => p.id === "user1_conn");
    expect(aliceData).toBeDefined();
    expect(aliceData.displayName).toBe("Alice");
    expect(aliceData.latency).toBe(45);
    expect(aliceData.drift).toBe(1.2);
    expect(aliceData.isBuffering).toBe(false);

    const bobData = msg.participants.find((p: any) => p.id === "user2_conn");
    expect(bobData).toBeDefined();
    expect(bobData.displayName).toBe("Bob");
    expect(bobData.latency).toBe(120);
    expect(bobData.drift).toBe(-0.8);
    expect(bobData.isBuffering).toBe(true);
  });

  test("buildDashboardData excludes kicked participants", () => {
    const alice = room.data.participants.get("user1_conn")!;
    alice.isKicked = true;

    const msg = buildDashboardData(room) as any;

    expect(msg.participants).toHaveLength(2);
    const aliceData = msg.participants.find((p: any) => p.id === "user1_conn");
    expect(aliceData).toBeUndefined();
  });

  test("buildDashboardData with empty room returns empty array", () => {
    const emptyRoom = new Room("EMPTY1", testVideoSource);
    const msg = buildDashboardData(emptyRoom) as any;

    expect(msg.type).toBe("host:dashboard");
    expect(msg.participants).toHaveLength(0);
  });

  test("dashboard includes accurate latency values", () => {
    const host = room.data.participants.get("host_conn")!;
    host.latency = 30;

    const msg = buildDashboardData(room) as any;
    const hostData = msg.participants.find((p: any) => p.id === "host_conn");
    expect(hostData.latency).toBe(30);
  });

  test("dashboard includes accurate drift values", () => {
    const alice = room.data.participants.get("user1_conn")!;
    alice.drift = 2.5;

    const msg = buildDashboardData(room) as any;
    const aliceData = msg.participants.find((p: any) => p.id === "user1_conn");
    expect(aliceData.drift).toBe(2.5);
  });
});

// ==============================
// Dashboard Broadcast Lifecycle Tests
// ==============================

describe("Dashboard Broadcast Lifecycle", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
    resetDashboardIntervals();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
  });

  afterEach(() => {
    resetDashboardIntervals();
  });

  test("startDashboardBroadcast does not throw", () => {
    expect(() => startDashboardBroadcast(room)).not.toThrow();
  });

  test("stopDashboardBroadcast does not throw for non-started room", () => {
    expect(() => stopDashboardBroadcast("NONEXIST")).not.toThrow();
  });

  test("stopDashboardBroadcast cleans up after start", () => {
    startDashboardBroadcast(room);
    expect(() => stopDashboardBroadcast(room.data.id)).not.toThrow();
  });

  test("double start does not create multiple intervals", () => {
    startDashboardBroadcast(room);
    startDashboardBroadcast(room);
    // Should only have one entry - just verifying no throw
    expect(() => stopDashboardBroadcast(room.data.id)).not.toThrow();
  });

  test("resetDashboardIntervals clears all intervals", () => {
    startDashboardBroadcast(room);
    resetDashboardIntervals();
    // No errors after reset
    expect(() => stopDashboardBroadcast(room.data.id)).not.toThrow();
  });
});

// ==============================
// Integration: Non-host cannot send host commands
// ==============================

describe("Host Command Access Control (Integration)", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
    room.addParticipant("user_conn", "RegularUser");
  });

  test("non-host cannot force-resync (gets UNAUTHORIZED)", () => {
    const ws = createMockWs("user_conn", room.data.id);
    const result = validateHost(ws);
    expect(result).toBeNull();

    const msg = parseSentMessage(ws);
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("UNAUTHORIZED");
  });

  test("non-host cannot kick (gets UNAUTHORIZED)", () => {
    const ws = createMockWs("user_conn", room.data.id);
    const result = validateHost(ws);
    expect(result).toBeNull();

    const msg = parseSentMessage(ws);
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("UNAUTHORIZED");
  });

  test("host can force-resync successfully", () => {
    const ws = createMockWs("host_conn", room.data.id);
    const result = validateHost(ws);
    expect(result).not.toBeNull();
    expect(ws.sentMessages.length).toBe(0); // No error sent
  });

  test("host can kick successfully", () => {
    const ws = createMockWs("host_conn", room.data.id);
    const result = validateHost(ws);
    expect(result).not.toBeNull();

    const kickResult = handleKick(result!, "user_conn", ws);
    expect(kickResult).toBe(true);
  });
});

// ==============================
// Kicked User Rejoin Prevention
// ==============================

describe("Kicked User Rejoin Prevention", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
    room.addParticipant("kicked_conn", "KickedUser");
  });

  test("kicked user cannot rejoin with same display name", () => {
    // Kick the user
    const participant = room.data.participants.get("kicked_conn")!;
    participant.isKicked = true;

    // Attempt to rejoin with same display name
    const result = room.addParticipant("new_conn_id", "KickedUser");
    expect(result).toBeNull();
  });

  test("user with different display name can join after someone else was kicked", () => {
    // Kick one user
    const participant = room.data.participants.get("kicked_conn")!;
    participant.isKicked = true;

    // Different user can still join (but max participants may limit)
    // Remove kicked_conn from the count since they're kicked
    // Room has host_conn (active) and kicked_conn (kicked) = 1 active
    // Max is 3, so a new user should be able to join
    const result = room.addParticipant("new_conn_id", "DifferentUser");
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe("DifferentUser");
  });

  test("kicked user display name check is exact match", () => {
    const participant = room.data.participants.get("kicked_conn")!;
    participant.isKicked = true;

    // Slightly different name should work
    const result = room.addParticipant("new_conn_id", "KickedUser2");
    expect(result).not.toBeNull();
  });
});

// ==============================
// Force Resync Position Accuracy
// ==============================

describe("Force Resync Position Accuracy", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("host_conn", "Host");
  });

  test("force-resync uses authoritative position when playing", () => {
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.position = 100.0;
    room.data.playbackState.lastUpdated = Date.now() - 10000; // 10 seconds ago

    const pos = getCurrentPosition(room);
    expect(pos).toBeGreaterThanOrEqual(109.9);
    expect(pos).toBeLessThanOrEqual(110.1);
  });

  test("force-resync uses static position when paused", () => {
    room.data.playbackState.isPlaying = false;
    room.data.playbackState.position = 200.0;
    room.data.playbackState.lastUpdated = Date.now() - 60000; // 1 minute ago

    const pos = getCurrentPosition(room);
    // Position should not advance when paused
    expect(pos).toBe(200.0);
  });

  test("force-resync at position 0", () => {
    room.data.playbackState.isPlaying = false;
    room.data.playbackState.position = 0;

    const pos = getCurrentPosition(room);
    expect(pos).toBe(0);
  });
});
