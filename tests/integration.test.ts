import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { roomManager } from "../src/rooms/manager";
import { websocketHandlers, resetConnections, type ConnectionData } from "../src/ws/handler";
import { registerSyncHandlers } from "../src/sync/commands";
import { registerHostHandlers } from "../src/host/commands";
import { registerChatHandlers } from "../src/chat/commands";
import { resetSyncEngines } from "../src/sync/engine";
import { resetDashboardIntervals } from "../src/host/commands";
import { resetRateLimits } from "../src/chat/broker";
import type { VideoSource } from "../src/rooms/room";

// Register handlers once
registerSyncHandlers();
registerHostHandlers();
registerChatHandlers();

const TEST_SOURCE: VideoSource = { type: "hls", url: "https://example.com/video.m3u8" };

/**
 * Helper: start a test server on a random port.
 */
function startTestServer(): { server: any; port: number } {
  const port = 5000 + Math.floor(Math.random() * 4000);
  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req);
        if (upgraded) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      // Minimal API for creating rooms
      if (url.pathname === "/api/rooms" && req.method === "POST") {
        return (async () => {
          const body = await req.json() as any;
          const videoSource = body.videoSource;
          const linkedVideoSource = body.linkedVideoSource;
          const result = roomManager.createRoom(videoSource, linkedVideoSource);
          return Response.json(result, { status: 201 });
        })();
      }
      if (url.pathname.startsWith("/api/rooms/") && req.method === "GET") {
        const code = url.pathname.split("/").pop()!;
        const room = roomManager.getRoom(code);
        if (!room) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(room.toPublicInfo());
      }
      return new Response("Not Found", { status: 404 });
    },
    websocket: websocketHandlers,
  });
  return { server, port };
}

/**
 * Helper: connect a WebSocket client and wait for open.
 */
async function connectClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("Connection timeout")), 3000);
  });
  return ws;
}

/**
 * Helper: collect messages from a WebSocket using event listener pattern.
 * Uses addEventListener so multiple waitFor calls do not clobber each other.
 */
function createMessageCollector(ws: WebSocket): { messages: any[]; waitFor: (type: string, timeout?: number) => Promise<any> } {
  const messages: any[] = [];
  const listeners: Array<(data: any) => void> = [];

  ws.addEventListener("message", (event: MessageEvent) => {
    const data = JSON.parse(event.data as string);
    messages.push(data);
    // Notify all pending listeners
    for (const listener of listeners) {
      listener(data);
    }
  });

  function waitFor(type: string, timeout = 3000): Promise<any> {
    // Check if already received
    const idx = messages.findIndex((m) => m.type === type);
    if (idx !== -1) {
      const found = messages[idx];
      messages.splice(idx, 1);
      return Promise.resolve(found);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const listenerIdx = listeners.indexOf(listener);
        if (listenerIdx !== -1) listeners.splice(listenerIdx, 1);
        reject(new Error(`Timeout waiting for message type: ${type}`));
      }, timeout);

      function listener(data: any) {
        if (data.type === type) {
          clearTimeout(timer);
          const listenerIdx = listeners.indexOf(listener);
          if (listenerIdx !== -1) listeners.splice(listenerIdx, 1);
          const msgIdx = messages.indexOf(data);
          if (msgIdx !== -1) messages.splice(msgIdx, 1);
          resolve(data);
        }
      }

      listeners.push(listener);
    });
  }

  return { messages, waitFor };
}

/**
 * Helper: join a room via WebSocket and wait for room:state.
 * If a collector already exists, use it. Otherwise create one.
 */
async function joinRoom(ws: WebSocket, roomCode: string, displayName: string, existingCollector?: ReturnType<typeof createMessageCollector>): Promise<{ state: any; collector: ReturnType<typeof createMessageCollector> }> {
  const collector = existingCollector || createMessageCollector(ws);
  ws.send(JSON.stringify({ type: "join", roomCode, displayName }));
  const state = await collector.waitFor("room:state");
  return { state, collector };
}

// ==============================
// Full Flow Integration Tests
// ==============================

describe("Integration: Full Flow", () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    process.env.HEARTBEAT_INTERVAL_MS = "60000"; // Long interval to avoid noise
    process.env.ROOM_MAX_PARTICIPANTS = "10";
    resetConnections();
    resetSyncEngines();
    resetDashboardIntervals();
    resetRateLimits();
    // Clean existing rooms
    const rooms = (roomManager as any).rooms as Map<string, any>;
    for (const code of Array.from(rooms.keys())) {
      roomManager.deleteRoom(code);
    }
    const result = startTestServer();
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
    process.env.ROOM_MAX_PARTICIPANTS = "3";
  });

  test("create room via API, two clients join, play/pause/seek sync", async () => {
    // Create room via REST API
    const createRes = await fetch(`http://localhost:${port}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoSource: TEST_SOURCE }),
    });
    expect(createRes.status).toBe(201);
    const { roomCode } = await createRes.json() as any;
    expect(roomCode).toBeTruthy();

    // Verify room exists via GET
    const getRes = await fetch(`http://localhost:${port}/api/rooms/${roomCode}`);
    expect(getRes.status).toBe(200);
    const roomInfo = await getRes.json() as any;
    expect(roomInfo.id).toBe(roomCode);

    // Client 1 joins
    const ws1 = await connectClient(port);
    const { state: state1, collector: col1 } = await joinRoom(ws1, roomCode, "Alice");
    expect(state1.room.id).toBe(roomCode);
    expect(state1.participants).toHaveLength(1);
    expect(state1.playbackState.isPlaying).toBe(false);

    // Client 2 joins
    const ws2 = await connectClient(port);

    // Wait for participant-joined on client 1
    const joinNotifPromise = col1.waitFor("room:participant-joined");

    const { state: state2, collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    expect(state2.participants).toHaveLength(2);

    const joinNotif = await joinNotifPromise;
    expect(joinNotif.participant.displayName).toBe("Bob");

    // Client 1 sends play command
    ws1.send(JSON.stringify({ type: "playback:play" }));

    // Both clients should receive playback:update
    const update1 = await col1.waitFor("playback:update");
    const update2 = await col2.waitFor("playback:update");
    expect(update1.isPlaying).toBe(true);
    expect(update2.isPlaying).toBe(true);
    expect(update1.position).toBeCloseTo(0, 0);

    // Client 2 sends seek
    ws2.send(JSON.stringify({ type: "playback:seek", position: 60 }));

    const seekUpdate1 = await col1.waitFor("playback:update");
    const seekUpdate2 = await col2.waitFor("playback:update");
    expect(seekUpdate1.position).toBeCloseTo(60, 0);
    expect(seekUpdate2.position).toBeCloseTo(60, 0);
    expect(seekUpdate1.isPlaying).toBe(true);

    // Client 1 sends pause
    ws1.send(JSON.stringify({ type: "playback:pause" }));

    const pauseUpdate1 = await col1.waitFor("playback:update");
    const pauseUpdate2 = await col2.waitFor("playback:update");
    expect(pauseUpdate1.isPlaying).toBe(false);
    expect(pauseUpdate2.isPlaying).toBe(false);
    expect(pauseUpdate1.position).toBeGreaterThanOrEqual(60);

    ws1.close();
    ws2.close();
  });

  test("GET nonexistent room returns 404", async () => {
    const res = await fetch(`http://localhost:${port}/api/rooms/XXXXXX`);
    expect(res.status).toBe(404);
  });
});

// ==============================
// Reconnection Integration Tests
// ==============================

describe("Integration: Reconnection", () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    process.env.HEARTBEAT_INTERVAL_MS = "60000";
    process.env.ROOM_MAX_PARTICIPANTS = "10";
    resetConnections();
    resetSyncEngines();
    resetDashboardIntervals();
    resetRateLimits();
    const rooms = (roomManager as any).rooms as Map<string, any>;
    for (const code of Array.from(rooms.keys())) {
      roomManager.deleteRoom(code);
    }
    const result = startTestServer();
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
    process.env.ROOM_MAX_PARTICIPANTS = "3";
  });

  test("disconnect holds slot, reconnect with same name resyncs", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    // Client 1 (Alice) joins
    const ws1 = await connectClient(port);
    const { state: state1, collector: col1 } = await joinRoom(ws1, roomCode, "Alice");
    expect(state1.participants).toHaveLength(1);

    // Client 2 (Bob) joins
    const ws2 = await connectClient(port);
    const joinNotif = col1.waitFor("room:participant-joined");
    const { collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    await joinNotif;

    // Play the video so state is non-trivial
    ws1.send(JSON.stringify({ type: "playback:play" }));
    await col1.waitFor("playback:update");
    await col2.waitFor("playback:update");

    // Disconnect Bob
    const leftPromise = col1.waitFor("room:participant-left");
    ws2.close();
    await leftPromise;

    // Wait a brief moment, then reconnect Bob with same name
    await new Promise((r) => setTimeout(r, 100));

    const ws2b = await connectClient(port);
    const joinNotif2 = col1.waitFor("room:participant-joined");
    const { state: reconState } = await joinRoom(ws2b, roomCode, "Bob");

    // Should get current playback state (playing, position > 0)
    expect(reconState.playbackState.isPlaying).toBe(true);
    expect(reconState.playbackState.position).toBeGreaterThanOrEqual(0);
    expect(reconState.room.id).toBe(roomCode);

    // Alice should see Bob rejoin
    const rejoin = await joinNotif2;
    expect(rejoin.participant.displayName).toBe("Bob");

    ws1.close();
    ws2b.close();
  });
});

// ==============================
// Chat Integration Tests
// ==============================

describe("Integration: Chat", () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    process.env.HEARTBEAT_INTERVAL_MS = "60000";
    process.env.ROOM_MAX_PARTICIPANTS = "10";
    resetConnections();
    resetSyncEngines();
    resetDashboardIntervals();
    resetRateLimits();
    const rooms = (roomManager as any).rooms as Map<string, any>;
    for (const code of Array.from(rooms.keys())) {
      roomManager.deleteRoom(code);
    }
    const result = startTestServer();
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
    process.env.ROOM_MAX_PARTICIPANTS = "3";
  });

  test("chat messages are delivered to all participants", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    const ws2 = await connectClient(port);
    const joinNotifP = col1.waitFor("room:participant-joined");
    const { collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    await joinNotifP;

    // Alice sends a message
    ws1.send(JSON.stringify({ type: "chat:message", content: "Hello everyone!" }));

    const msg1 = await col1.waitFor("chat:new-message");
    const msg2 = await col2.waitFor("chat:new-message");

    expect(msg1.message.content).toBe("Hello everyone!");
    expect(msg1.message.senderName).toBe("Alice");
    expect(msg2.message.content).toBe("Hello everyone!");
    expect(msg2.message.senderName).toBe("Alice");

    // Bob sends a message
    ws2.send(JSON.stringify({ type: "chat:message", content: "Hi Alice!" }));

    const msg3 = await col1.waitFor("chat:new-message");
    const msg4 = await col2.waitFor("chat:new-message");

    expect(msg3.message.content).toBe("Hi Alice!");
    expect(msg3.message.senderName).toBe("Bob");
    expect(msg4.message.content).toBe("Hi Alice!");

    ws1.close();
    ws2.close();
  });

  test("rate limiting prevents message spam", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    // Send 6 messages rapidly (limit is 5 per second)
    for (let i = 0; i < 6; i++) {
      ws1.send(JSON.stringify({ type: "chat:message", content: `msg${i}` }));
    }

    // Wait a bit for all to process
    await new Promise((r) => setTimeout(r, 200));

    // Should have received 5 chat:new-message and 1 error
    const chatMessages = col1.messages.filter((m) => m.type === "chat:new-message");
    const errors = col1.messages.filter((m) => m.type === "error" && m.code === "RATE_LIMITED");

    expect(chatMessages.length).toBe(5);
    expect(errors.length).toBe(1);

    ws1.close();
  });

  test("reactions are broadcast to all participants", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    const ws2 = await connectClient(port);
    const joinNotifP = col1.waitFor("room:participant-joined");
    const { collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    await joinNotifP;

    // Alice sends a reaction
    ws1.send(JSON.stringify({ type: "chat:reaction", emoji: "\u2764\uFE0F" }));

    const reaction1 = await col1.waitFor("chat:new-reaction");
    const reaction2 = await col2.waitFor("chat:new-reaction");

    expect(reaction1.emoji).toBe("\u2764\uFE0F");
    expect(reaction1.senderName).toBe("Alice");
    expect(reaction2.emoji).toBe("\u2764\uFE0F");

    ws1.close();
    ws2.close();
  });

  test("late joiner receives chat history", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    // Alice sends some messages
    ws1.send(JSON.stringify({ type: "chat:message", content: "First message" }));
    ws1.send(JSON.stringify({ type: "chat:message", content: "Second message" }));

    await col1.waitFor("chat:new-message");
    await col1.waitFor("chat:new-message");

    // Bob joins late and should receive chat history
    const ws2 = await connectClient(port);
    const { state } = await joinRoom(ws2, roomCode, "Bob");

    expect(state.chatHistory.length).toBe(2);
    expect(state.chatHistory[0].content).toBe("First message");
    expect(state.chatHistory[1].content).toBe("Second message");

    ws1.close();
    ws2.close();
  });
});

// ==============================
// Host Controls Integration Tests
// ==============================

describe("Integration: Host Controls", () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    process.env.HEARTBEAT_INTERVAL_MS = "60000";
    process.env.ROOM_MAX_PARTICIPANTS = "10";
    resetConnections();
    resetSyncEngines();
    resetDashboardIntervals();
    resetRateLimits();
    const rooms = (roomManager as any).rooms as Map<string, any>;
    for (const code of Array.from(rooms.keys())) {
      roomManager.deleteRoom(code);
    }
    const result = startTestServer();
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
    process.env.ROOM_MAX_PARTICIPANTS = "3";
  });

  test("host can kick a user", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    // Alice joins first (becomes host)
    const ws1 = await connectClient(port);
    const { state: state1, collector: col1 } = await joinRoom(ws1, roomCode, "Alice");
    const hostId = state1.room.hostId;
    expect(hostId).not.toBeNull();

    // Bob joins
    const ws2 = await connectClient(port);
    const joinNotifP = col1.waitFor("room:participant-joined");
    const { state: state2, collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    await joinNotifP;

    // Get Bob's participant ID from his state
    const bobId = state2.participants.find((p: any) => p.displayName === "Bob")?.id;
    expect(bobId).toBeTruthy();

    // Host kicks Bob
    ws1.send(JSON.stringify({ type: "host:kick", targetId: bobId }));

    // Bob should receive kicked message
    const kicked = await col2.waitFor("kicked");
    expect(kicked.reason).toContain("kicked");

    // Alice should receive participant-left
    const left = await col1.waitFor("room:participant-left");
    expect(left.participantId).toBe(bobId);

    ws1.close();
    ws2.close();
  });

  test("host can force-resync all participants", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    // Alice joins (host)
    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    // Bob joins
    const ws2 = await connectClient(port);
    const joinNotifP = col1.waitFor("room:participant-joined");
    const { collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    await joinNotifP;

    // Play video first so position is meaningful
    ws1.send(JSON.stringify({ type: "playback:play" }));
    await col1.waitFor("playback:update");
    await col2.waitFor("playback:update");

    // Host sends force-resync
    ws1.send(JSON.stringify({ type: "host:force-resync" }));

    // Both should receive playback:force-resync
    const resync1 = await col1.waitFor("playback:force-resync");
    const resync2 = await col2.waitFor("playback:force-resync");

    expect(typeof resync1.position).toBe("number");
    expect(typeof resync2.position).toBe("number");
    expect(resync1.position).toBeGreaterThanOrEqual(0);

    ws1.close();
    ws2.close();
  });

  test("non-host cannot kick", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    const ws1 = await connectClient(port);
    const { state: state1, collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    const ws2 = await connectClient(port);
    const joinNotifP = col1.waitFor("room:participant-joined");
    const { state: state2, collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    await joinNotifP;

    const aliceId = state2.participants.find((p: any) => p.displayName === "Alice")?.id;

    // Bob (non-host) tries to kick Alice
    ws2.send(JSON.stringify({ type: "host:kick", targetId: aliceId }));

    const error = await col2.waitFor("error");
    expect(error.code).toBe("UNAUTHORIZED");

    ws1.close();
    ws2.close();
  });
});

// ==============================
// Multi-Room Integration Tests
// ==============================

describe("Integration: Multi-Room (Linked Rooms)", () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    process.env.HEARTBEAT_INTERVAL_MS = "60000";
    process.env.ROOM_MAX_PARTICIPANTS = "10";
    resetConnections();
    resetSyncEngines();
    resetDashboardIntervals();
    resetRateLimits();
    const rooms = (roomManager as any).rooms as Map<string, any>;
    for (const code of Array.from(rooms.keys())) {
      roomManager.deleteRoom(code);
    }
    const result = startTestServer();
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
    process.env.ROOM_MAX_PARTICIPANTS = "3";
  });

  test("creating linked rooms sets up bidirectional link", async () => {
    const createRes = await fetch(`http://localhost:${port}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSource: TEST_SOURCE,
        linkedVideoSource: { type: "youtube", url: "https://youtube.com/watch?v=abc" },
      }),
    });
    expect(createRes.status).toBe(201);
    const { roomCode, linkedRoomCode } = await createRes.json() as any;
    expect(roomCode).toBeTruthy();
    expect(linkedRoomCode).toBeTruthy();

    // Verify both rooms exist
    const room1Res = await fetch(`http://localhost:${port}/api/rooms/${roomCode}`);
    expect(room1Res.status).toBe(200);
    const room1 = await room1Res.json() as any;
    expect(room1.linkedRoomId).toBe(linkedRoomCode);

    const room2Res = await fetch(`http://localhost:${port}/api/rooms/${linkedRoomCode}`);
    expect(room2Res.status).toBe(200);
    const room2 = await room2Res.json() as any;
    expect(room2.linkedRoomId).toBe(roomCode);
  });

  test("play command propagates to linked room", async () => {
    const source1 = TEST_SOURCE;
    const source2: VideoSource = { type: "youtube", url: "https://youtube.com/watch?v=abc" };
    const { roomCode, linkedRoomCode } = roomManager.createRoom(source1, source2);

    // Alice joins room 1
    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode!, "Alice");

    // Bob joins room 2 (linked)
    const ws2 = await connectClient(port);
    const { collector: col2 } = await joinRoom(ws2, linkedRoomCode!, "Bob");

    // Alice plays in room 1
    ws1.send(JSON.stringify({ type: "playback:play" }));

    // Both should receive playback:update
    const update1 = await col1.waitFor("playback:update");
    const update2 = await col2.waitFor("playback:update");

    expect(update1.isPlaying).toBe(true);
    expect(update2.isPlaying).toBe(true);

    ws1.close();
    ws2.close();
  });

  test("seek command propagates to linked room", async () => {
    const source1 = TEST_SOURCE;
    const source2: VideoSource = { type: "youtube", url: "https://youtube.com/watch?v=abc" };
    const { roomCode, linkedRoomCode } = roomManager.createRoom(source1, source2);

    // Alice in room 1
    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode!, "Alice");

    // Bob in room 2
    const ws2 = await connectClient(port);
    const { collector: col2 } = await joinRoom(ws2, linkedRoomCode!, "Bob");

    // Alice seeks to 120s
    ws1.send(JSON.stringify({ type: "playback:seek", position: 120 }));

    const seekUpdate1 = await col1.waitFor("playback:update");
    const seekUpdate2 = await col2.waitFor("playback:update");

    expect(seekUpdate1.position).toBeCloseTo(120, 0);
    expect(seekUpdate2.position).toBeCloseTo(120, 0);

    ws1.close();
    ws2.close();
  });

  test("pause command propagates to linked room", async () => {
    const source1 = TEST_SOURCE;
    const source2: VideoSource = { type: "youtube", url: "https://youtube.com/watch?v=abc" };
    const { roomCode, linkedRoomCode } = roomManager.createRoom(source1, source2);

    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode!, "Alice");

    const ws2 = await connectClient(port);
    const { collector: col2 } = await joinRoom(ws2, linkedRoomCode!, "Bob");

    // Start playing first
    ws1.send(JSON.stringify({ type: "playback:play" }));
    await col1.waitFor("playback:update");
    await col2.waitFor("playback:update");

    // Now pause from room 2
    ws2.send(JSON.stringify({ type: "playback:pause" }));

    const pause1 = await col1.waitFor("playback:update");
    const pause2 = await col2.waitFor("playback:update");

    expect(pause1.isPlaying).toBe(false);
    expect(pause2.isPlaying).toBe(false);

    ws1.close();
    ws2.close();
  });
});

// ==============================
// Edge Cases
// ==============================

describe("Integration: Edge Cases", () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    process.env.HEARTBEAT_INTERVAL_MS = "60000";
    process.env.ROOM_MAX_PARTICIPANTS = "10";
    resetConnections();
    resetSyncEngines();
    resetDashboardIntervals();
    resetRateLimits();
    const rooms = (roomManager as any).rooms as Map<string, any>;
    for (const code of Array.from(rooms.keys())) {
      roomManager.deleteRoom(code);
    }
    const result = startTestServer();
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
    process.env.ROOM_MAX_PARTICIPANTS = "3";
  });

  test("multiple rapid play/pause toggles are handled correctly", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    const ws1 = await connectClient(port);
    const { collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    // Rapid play/pause
    ws1.send(JSON.stringify({ type: "playback:play" }));
    ws1.send(JSON.stringify({ type: "playback:pause" }));
    ws1.send(JSON.stringify({ type: "playback:play" }));

    // Wait for all messages to be processed
    await new Promise((r) => setTimeout(r, 200));

    // Should have received 3 playback:update messages
    const updates = col1.messages.filter((m) => m.type === "playback:update");
    expect(updates.length).toBe(3);

    // Final state should be playing
    const lastUpdate = updates[updates.length - 1];
    expect(lastUpdate.isPlaying).toBe(true);

    ws1.close();
  });

  test("heartbeat from a participant updates state", async () => {
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    const ws1 = await connectClient(port);
    await joinRoom(ws1, roomCode, "Alice");

    // Send a heartbeat
    ws1.send(JSON.stringify({
      type: "heartbeat",
      position: 30.5,
      isBuffering: false,
      clientTime: Date.now(),
    }));

    // Small delay for processing
    await new Promise((r) => setTimeout(r, 100));

    // Verify participant state was updated in the room
    const room = roomManager.getRoom(roomCode)!;
    const participants = Array.from(room.data.participants.values());
    expect(participants.length).toBe(1);
    expect(participants[0].reportedPosition).toBe(30.5);
    expect(participants[0].isBuffering).toBe(false);

    ws1.close();
  });

  test("kicked user cannot rejoin", async () => {
    process.env.ROOM_MAX_PARTICIPANTS = "3";
    const { roomCode } = roomManager.createRoom(TEST_SOURCE);

    // Alice joins (host)
    const ws1 = await connectClient(port);
    const { state: state1, collector: col1 } = await joinRoom(ws1, roomCode, "Alice");

    // Bob joins
    const ws2 = await connectClient(port);
    const joinNotifP = col1.waitFor("room:participant-joined");
    const { state: state2, collector: col2 } = await joinRoom(ws2, roomCode, "Bob");
    await joinNotifP;

    const bobId = state2.participants.find((p: any) => p.displayName === "Bob")?.id;

    // Host kicks Bob
    ws1.send(JSON.stringify({ type: "host:kick", targetId: bobId }));
    await col2.waitFor("kicked");

    // Wait for disconnect to process
    await new Promise((r) => setTimeout(r, 200));

    // Bob tries to rejoin
    const ws3 = await connectClient(port);
    const col3 = createMessageCollector(ws3);
    ws3.send(JSON.stringify({ type: "join", roomCode, displayName: "Bob" }));

    const error = await col3.waitFor("error");
    expect(error.code).toBe("ROOM_FULL"); // kicked users are blocked

    ws1.close();
    ws3.close();
  });
});
