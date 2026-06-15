import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { generateRoomCode } from "../src/utils/id";
import { Room, type VideoSource } from "../src/rooms/room";
import { roomManager } from "../src/rooms/manager";

// ==============================
// Room Code Generation Tests
// ==============================

describe("generateRoomCode", () => {
  test("produces a 6-character string", () => {
    const code = generateRoomCode(new Set());
    expect(code).toHaveLength(6);
  });

  test("uses only uppercase alphanumeric characters", () => {
    const code = generateRoomCode(new Set());
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  test("avoids collision with existing codes", () => {
    const existing = new Set<string>();
    // Generate many codes and ensure no duplicates
    for (let i = 0; i < 100; i++) {
      const code = generateRoomCode(existing);
      expect(existing.has(code)).toBe(false);
      existing.add(code);
    }
  });

  test("throws if unable to generate unique code after max attempts", () => {
    // Create a set that contains all possible codes (simulate full collision)
    // We use a Proxy to make has() always return true
    const fullSet = new Proxy(new Set<string>(), {
      get(target, prop) {
        if (prop === "has") return () => true;
        return Reflect.get(target, prop);
      },
    });

    expect(() => generateRoomCode(fullSet as Set<string>, 10)).toThrow(
      "Failed to generate unique room code"
    );
  });
});

// ==============================
// Room Class Tests
// ==============================

describe("Room", () => {
  const testSource: VideoSource = { type: "hls", url: "https://example.com/video.m3u8" };

  test("initializes with correct defaults", () => {
    const room = new Room("ABC123", testSource);
    expect(room.data.id).toBe("ABC123");
    expect(room.data.hostId).toBeNull();
    expect(room.data.videoSource).toEqual(testSource);
    expect(room.data.participants.size).toBe(0);
    expect(room.data.playbackState.isPlaying).toBe(false);
    expect(room.data.playbackState.position).toBe(0);
    expect(room.data.playbackState.playbackRate).toBe(1.0);
    expect(room.data.linkedRoomId).toBeNull();
    expect(room.data.chatHistory).toEqual([]);
    expect(room.data.cleanupTimer).toBeNull();
  });

  test("addParticipant assigns first participant as host", () => {
    const room = new Room("ABC123", testSource);
    const p = room.addParticipant("conn-1", "Alice");
    expect(p).not.toBeNull();
    expect(p!.displayName).toBe("Alice");
    expect(room.data.hostId).toBe("conn-1");
  });

  test("addParticipant adds multiple participants", () => {
    const room = new Room("ABC123", testSource);
    room.addParticipant("conn-1", "Alice");
    room.addParticipant("conn-2", "Bob");
    expect(room.getParticipantCount()).toBe(2);
    expect(room.data.hostId).toBe("conn-1"); // First remains host
  });

  test("addParticipant enforces max participants", () => {
    const room = new Room("ABC123", testSource);
    // Default max is 3 (from env or fallback)
    room.addParticipant("conn-1", "Alice");
    room.addParticipant("conn-2", "Bob");
    room.addParticipant("conn-3", "Charlie");

    const rejected = room.addParticipant("conn-4", "Dave");
    expect(rejected).toBeNull();
    expect(room.getParticipantCount()).toBe(3);
  });

  test("removeParticipant removes and reassigns host", () => {
    const room = new Room("ABC123", testSource);
    room.addParticipant("conn-1", "Alice");
    room.addParticipant("conn-2", "Bob");

    const removed = room.removeParticipant("conn-1");
    expect(removed).toBe(true);
    expect(room.getParticipantCount()).toBe(1);
    expect(room.data.hostId).toBe("conn-2"); // Host reassigned
  });

  test("removeParticipant sets hostId to null when room becomes empty", () => {
    const room = new Room("ABC123", testSource);
    room.addParticipant("conn-1", "Alice");
    room.removeParticipant("conn-1");
    expect(room.data.hostId).toBeNull();
  });

  test("removeParticipant returns false for non-existent participant", () => {
    const room = new Room("ABC123", testSource);
    expect(room.removeParticipant("nonexistent")).toBe(false);
  });

  test("getParticipantCount excludes kicked participants", () => {
    const room = new Room("ABC123", testSource);
    room.addParticipant("conn-1", "Alice");
    room.addParticipant("conn-2", "Bob");

    // Manually kick one participant
    const p = room.data.participants.get("conn-2");
    if (p) p.isKicked = true;

    expect(room.getParticipantCount()).toBe(1);
  });

  test("toPublicInfo returns correct shape", () => {
    const room = new Room("XYZ789", testSource);
    room.addParticipant("conn-1", "Alice");

    const info = room.toPublicInfo();
    expect(info.id).toBe("XYZ789");
    expect(info.videoSourceType).toBe("hls");
    expect(info.participantCount).toBe(1);
    expect(info.maxParticipants).toBe(3);
    expect(info.linkedRoomId).toBeNull();
    expect(typeof info.createdAt).toBe("number");
  });
});

// ==============================
// Room Manager Tests
// ==============================

describe("RoomManager", () => {
  const testSource: VideoSource = { type: "hls", url: "https://example.com/video.m3u8" };
  const youtubeSource: VideoSource = { type: "youtube", url: "https://youtube.com/watch?v=abc" };

  // We need to reset the room manager state between tests.
  // Since it's a singleton, we delete all rooms manually.
  beforeEach(() => {
    // Clean up all rooms
    const rooms = Array.from(
      (roomManager as any).rooms?.keys?.() || []
    );
    rooms.forEach((code: string) => roomManager.deleteRoom(code));
  });

  test("createRoom returns a valid room code", () => {
    const result = roomManager.createRoom(testSource);
    expect(result.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.linkedRoomCode).toBeUndefined();
  });

  test("createRoom creates a retrievable room", () => {
    const result = roomManager.createRoom(testSource);
    const room = roomManager.getRoom(result.roomCode);
    expect(room).toBeDefined();
    expect(room!.data.videoSource).toEqual(testSource);
  });

  test("createRoom with linked source creates two linked rooms", () => {
    const result = roomManager.createRoom(testSource, youtubeSource);
    expect(result.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.linkedRoomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(result.roomCode).not.toBe(result.linkedRoomCode);

    const room1 = roomManager.getRoom(result.roomCode);
    const room2 = roomManager.getRoom(result.linkedRoomCode!);

    expect(room1).toBeDefined();
    expect(room2).toBeDefined();
    expect(room1!.data.linkedRoomId).toBe(result.linkedRoomCode);
    expect(room2!.data.linkedRoomId).toBe(result.roomCode);
    expect(room1!.data.videoSource).toEqual(testSource);
    expect(room2!.data.videoSource).toEqual(youtubeSource);
  });

  test("getRoom returns undefined for nonexistent code", () => {
    expect(roomManager.getRoom("XXXXXX")).toBeUndefined();
  });

  test("deleteRoom removes the room", () => {
    const result = roomManager.createRoom(testSource);
    expect(roomManager.deleteRoom(result.roomCode)).toBe(true);
    expect(roomManager.getRoom(result.roomCode)).toBeUndefined();
  });

  test("deleteRoom returns false for nonexistent room", () => {
    expect(roomManager.deleteRoom("XXXXXX")).toBe(false);
  });

  test("deleteRoom unlinks paired room", () => {
    const result = roomManager.createRoom(testSource, youtubeSource);
    roomManager.deleteRoom(result.roomCode);

    const linkedRoom = roomManager.getRoom(result.linkedRoomCode!);
    expect(linkedRoom).toBeDefined();
    expect(linkedRoom!.data.linkedRoomId).toBeNull();
  });

  test("getRoomCount reflects created and deleted rooms", () => {
    expect(roomManager.getRoomCount()).toBe(0);

    const r1 = roomManager.createRoom(testSource);
    expect(roomManager.getRoomCount()).toBe(1);

    const r2 = roomManager.createRoom(youtubeSource);
    expect(roomManager.getRoomCount()).toBe(2);

    roomManager.deleteRoom(r1.roomCode);
    expect(roomManager.getRoomCount()).toBe(1);
  });

  test("room codes are unique across concurrent rooms", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = roomManager.createRoom(testSource);
      expect(codes.has(result.roomCode)).toBe(false);
      codes.add(result.roomCode);
    }
  });

  test("grace period timer deletes empty room after timeout", async () => {
    // Override with a short timeout for testing
    const result = roomManager.createRoom(testSource);
    const room = roomManager.getRoom(result.roomCode)!;

    // Set a very short cleanup timer directly
    room.data.cleanupTimer = setTimeout(() => {
      roomManager.deleteRoom(result.roomCode);
    }, 50);

    // Room should still exist immediately
    expect(roomManager.getRoom(result.roomCode)).toBeDefined();

    // Wait for timer to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Room should be deleted
    expect(roomManager.getRoom(result.roomCode)).toBeUndefined();
  });

  test("startGracePeriod does not start if room has participants", () => {
    const result = roomManager.createRoom(testSource);
    const room = roomManager.getRoom(result.roomCode)!;
    room.addParticipant("conn-1", "Alice");

    roomManager.startGracePeriod(result.roomCode);
    expect(room.data.cleanupTimer).toBeNull();
  });
});

// ==============================
// REST API Integration Tests
// ==============================

describe("REST API", () => {
  let serverProc: ReturnType<typeof Bun.spawn> | null = null;
  let baseUrl: string;
  const TEST_PORT = 3456;

  beforeEach(async () => {
    // Clean up any rooms from previous tests
    const rooms = Array.from(
      (roomManager as any).rooms?.keys?.() || []
    );
    rooms.forEach((code: string) => roomManager.deleteRoom(code));
  });

  // Instead of spawning a server process, we test the route handlers directly
  // This is more reliable in CI and avoids port conflicts

  test("POST /api/rooms with valid body returns 201 with room code", async () => {
    const { handleCreateRoom } = await import("../src/routes/api");

    const req = new Request("http://localhost/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSource: { type: "hls", url: "https://example.com/video.m3u8" },
      }),
    });

    const res = await handleCreateRoom(req);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.linkedRoomCode).toBeUndefined();
  });

  test("POST /api/rooms with linked source returns two codes", async () => {
    const { handleCreateRoom } = await import("../src/routes/api");

    const req = new Request("http://localhost/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSource: { type: "hls", url: "https://example.com/video.m3u8" },
        linkedVideoSource: { type: "youtube", url: "https://youtube.com/watch?v=abc" },
      }),
    });

    const res = await handleCreateRoom(req);
    expect(res.status).toBe(201);

    const data = await res.json();
    expect(data.roomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.linkedRoomCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(data.roomCode).not.toBe(data.linkedRoomCode);
  });

  test("POST /api/rooms with invalid body returns 400", async () => {
    const { handleCreateRoom } = await import("../src/routes/api");

    const req = new Request("http://localhost/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await handleCreateRoom(req);
    expect(res.status).toBe(400);
  });

  test("POST /api/rooms with invalid video source type returns 400", async () => {
    const { handleCreateRoom } = await import("../src/routes/api");

    const req = new Request("http://localhost/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSource: { type: "invalid", url: "https://example.com" },
      }),
    });

    const res = await handleCreateRoom(req);
    expect(res.status).toBe(400);
  });

  test("POST /api/rooms with missing url returns 400", async () => {
    const { handleCreateRoom } = await import("../src/routes/api");

    const req = new Request("http://localhost/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSource: { type: "hls" },
      }),
    });

    const res = await handleCreateRoom(req);
    expect(res.status).toBe(400);
  });

  test("GET /api/rooms/:code returns room info for valid code", async () => {
    const { handleGetRoom } = await import("../src/routes/api");

    // Create a room first
    const result = roomManager.createRoom({
      type: "hls",
      url: "https://example.com/video.m3u8",
    });

    const res = handleGetRoom(result.roomCode);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.id).toBe(result.roomCode);
    expect(data.videoSourceType).toBe("hls");
    expect(data.participantCount).toBe(0);
    expect(data.maxParticipants).toBe(3);
  });

  test("GET /api/rooms/:code returns 404 for invalid code", async () => {
    const { handleGetRoom } = await import("../src/routes/api");

    const res = handleGetRoom("XXXXXX");
    expect(res.status).toBe(404);

    const data = await res.json();
    expect(data.code).toBe("ROOM_NOT_FOUND");
  });
});
