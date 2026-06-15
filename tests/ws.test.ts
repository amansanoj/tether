import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parseMessage, serializeMessage, type ServerMessage } from "../src/ws/protocol";
import { roomManager } from "../src/rooms/manager";
import type { VideoSource } from "../src/rooms/room";

// ==============================
// Protocol: parseMessage Tests
// ==============================

describe("parseMessage", () => {
  test("parses valid join message", () => {
    const msg = parseMessage(JSON.stringify({
      type: "join",
      roomCode: "ABC123",
      displayName: "Alice",
    }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("join");
    if (msg!.type === "join") {
      expect(msg!.roomCode).toBe("ABC123");
      expect(msg!.displayName).toBe("Alice");
    }
  });

  test("parses valid playback:play message", () => {
    const msg = parseMessage(JSON.stringify({ type: "playback:play" }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("playback:play");
  });

  test("parses valid playback:pause message", () => {
    const msg = parseMessage(JSON.stringify({ type: "playback:pause" }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("playback:pause");
  });

  test("parses valid playback:seek message", () => {
    const msg = parseMessage(JSON.stringify({
      type: "playback:seek",
      position: 120.5,
    }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("playback:seek");
    if (msg!.type === "playback:seek") {
      expect(msg!.position).toBe(120.5);
    }
  });

  test("rejects playback:seek with negative position", () => {
    const msg = parseMessage(JSON.stringify({
      type: "playback:seek",
      position: -5,
    }));
    expect(msg).toBeNull();
  });

  test("parses valid heartbeat message", () => {
    const msg = parseMessage(JSON.stringify({
      type: "heartbeat",
      position: 45.2,
      isBuffering: false,
      clientTime: Date.now(),
    }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("heartbeat");
    if (msg!.type === "heartbeat") {
      expect(msg!.position).toBe(45.2);
      expect(msg!.isBuffering).toBe(false);
    }
  });

  test("rejects heartbeat with missing fields", () => {
    expect(parseMessage(JSON.stringify({
      type: "heartbeat",
      position: 45.2,
      // missing isBuffering and clientTime
    }))).toBeNull();

    expect(parseMessage(JSON.stringify({
      type: "heartbeat",
      position: 45.2,
      isBuffering: "no",  // wrong type
      clientTime: Date.now(),
    }))).toBeNull();
  });

  test("parses valid chat:message", () => {
    const msg = parseMessage(JSON.stringify({
      type: "chat:message",
      content: "Hello world!",
    }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("chat:message");
    if (msg!.type === "chat:message") {
      expect(msg!.content).toBe("Hello world!");
    }
  });

  test("rejects chat:message with empty content", () => {
    expect(parseMessage(JSON.stringify({
      type: "chat:message",
      content: "",
    }))).toBeNull();
  });

  test("parses valid chat:reaction", () => {
    const msg = parseMessage(JSON.stringify({
      type: "chat:reaction",
      emoji: "heart",
    }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("chat:reaction");
  });

  test("parses valid host:kick", () => {
    const msg = parseMessage(JSON.stringify({
      type: "host:kick",
      targetId: "conn-123",
    }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("host:kick");
    if (msg!.type === "host:kick") {
      expect(msg!.targetId).toBe("conn-123");
    }
  });

  test("parses valid host:force-resync", () => {
    const msg = parseMessage(JSON.stringify({ type: "host:force-resync" }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("host:force-resync");
  });

  test("parses valid pong message", () => {
    const msg = parseMessage(JSON.stringify({
      type: "pong",
      serverTime: 1700000000000,
    }));
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("pong");
    if (msg!.type === "pong") {
      expect(msg!.serverTime).toBe(1700000000000);
    }
  });

  test("rejects pong with missing serverTime", () => {
    expect(parseMessage(JSON.stringify({ type: "pong" }))).toBeNull();
  });

  test("rejects invalid JSON", () => {
    expect(parseMessage("not json")).toBeNull();
    expect(parseMessage("{broken")).toBeNull();
    expect(parseMessage("")).toBeNull();
  });

  test("rejects non-object values", () => {
    expect(parseMessage(JSON.stringify(null))).toBeNull();
    expect(parseMessage(JSON.stringify(42))).toBeNull();
    expect(parseMessage(JSON.stringify("string"))).toBeNull();
    expect(parseMessage(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  test("rejects messages with missing type", () => {
    expect(parseMessage(JSON.stringify({ roomCode: "ABC", displayName: "Alice" }))).toBeNull();
  });

  test("rejects messages with unknown type", () => {
    expect(parseMessage(JSON.stringify({ type: "unknown:command" }))).toBeNull();
    expect(parseMessage(JSON.stringify({ type: "admin:shutdown" }))).toBeNull();
  });

  test("rejects join with empty roomCode", () => {
    expect(parseMessage(JSON.stringify({
      type: "join",
      roomCode: "",
      displayName: "Alice",
    }))).toBeNull();
  });

  test("rejects join with empty displayName", () => {
    expect(parseMessage(JSON.stringify({
      type: "join",
      roomCode: "ABC123",
      displayName: "",
    }))).toBeNull();
  });

  test("rejects join with non-string fields", () => {
    expect(parseMessage(JSON.stringify({
      type: "join",
      roomCode: 123,
      displayName: "Alice",
    }))).toBeNull();
  });

  test("rejects host:kick with empty targetId", () => {
    expect(parseMessage(JSON.stringify({
      type: "host:kick",
      targetId: "",
    }))).toBeNull();
  });

  test("rejects chat:reaction with empty emoji", () => {
    expect(parseMessage(JSON.stringify({
      type: "chat:reaction",
      emoji: "",
    }))).toBeNull();
  });
});

// ==============================
// Protocol: serializeMessage Tests
// ==============================

describe("serializeMessage", () => {
  test("serializes room:state message", () => {
    const msg: ServerMessage = {
      type: "room:state",
      room: {
        id: "ABC123",
        videoSource: { type: "hls", url: "https://example.com/video.m3u8" },
        hostId: "conn-1",
        linkedRoomId: null,
      },
      participants: [
        { id: "conn-1", displayName: "Alice", joinedAt: 1700000000000 },
      ],
      playbackState: {
        isPlaying: false,
        position: 0,
        timestamp: 1700000000000,
      },
      chatHistory: [],
    };

    const serialized = serializeMessage(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe("room:state");
    expect(parsed.room.id).toBe("ABC123");
    expect(parsed.participants).toHaveLength(1);
    expect(parsed.playbackState.isPlaying).toBe(false);
  });

  test("serializes error message", () => {
    const msg: ServerMessage = {
      type: "error",
      code: "ROOM_NOT_FOUND",
      message: "Room not found",
    };

    const serialized = serializeMessage(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe("error");
    expect(parsed.code).toBe("ROOM_NOT_FOUND");
    expect(parsed.message).toBe("Room not found");
  });

  test("serializes ping message", () => {
    const now = Date.now();
    const msg: ServerMessage = {
      type: "ping",
      serverTime: now,
    };

    const serialized = serializeMessage(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe("ping");
    expect(parsed.serverTime).toBe(now);
  });

  test("serializes playback:update message", () => {
    const msg: ServerMessage = {
      type: "playback:update",
      isPlaying: true,
      position: 60.5,
      timestamp: Date.now(),
    };

    const serialized = serializeMessage(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe("playback:update");
    expect(parsed.isPlaying).toBe(true);
    expect(parsed.position).toBe(60.5);
  });

  test("serializes kicked message", () => {
    const msg: ServerMessage = {
      type: "kicked",
      reason: "Removed by host",
    };

    const serialized = serializeMessage(msg);
    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe("kicked");
    expect(parsed.reason).toBe("Removed by host");
  });
});

// ==============================
// WebSocket Router Tests
// ==============================

describe("WebSocket Router", () => {
  test("routes unknown message type and sends error", async () => {
    // Import the router
    const { routeMessage } = await import("../src/ws/router");
    
    const sentMessages: string[] = [];
    const mockWs = {
      data: {
        connectionId: "conn-1",
        roomCode: "ABC123",
        displayName: "Alice",
        missedPongs: 0,
        lastPongTime: Date.now(),
        pingInterval: null,
      },
      send(msg: string) {
        sentMessages.push(msg);
      },
    } as any;

    // Route a heartbeat message (no handler registered for it in this test)
    routeMessage(mockWs, { type: "heartbeat", position: 0, isBuffering: false, clientTime: Date.now() });

    expect(sentMessages.length).toBe(1);
    const response = JSON.parse(sentMessages[0]);
    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_MESSAGE");
  });

  test("registers and routes playback handlers", async () => {
    const { routeMessage, registerPlaybackHandler } = await import("../src/ws/router");

    let handledMessage: any = null;
    registerPlaybackHandler("playback:play", (ws, msg) => {
      handledMessage = msg;
    });

    const mockWs = {
      data: {
        connectionId: "conn-1",
        roomCode: "ABC123",
        displayName: "Alice",
        missedPongs: 0,
        lastPongTime: Date.now(),
        pingInterval: null,
      },
      send(msg: string) {},
    } as any;

    routeMessage(mockWs, { type: "playback:play" });
    expect(handledMessage).not.toBeNull();
    expect(handledMessage.type).toBe("playback:play");
  });

  test("registers and routes chat handlers", async () => {
    const { routeMessage, registerChatHandler } = await import("../src/ws/router");

    let handledMessage: any = null;
    registerChatHandler("chat:message", (ws, msg) => {
      handledMessage = msg;
    });

    const mockWs = {
      data: {
        connectionId: "conn-1",
        roomCode: "ABC123",
        displayName: "Alice",
        missedPongs: 0,
        lastPongTime: Date.now(),
        pingInterval: null,
      },
      send(msg: string) {},
    } as any;

    routeMessage(mockWs, { type: "chat:message", content: "Hello" });
    expect(handledMessage).not.toBeNull();
    expect(handledMessage.type).toBe("chat:message");
  });

  test("registers and routes host handlers", async () => {
    const { routeMessage, registerHostHandler } = await import("../src/ws/router");

    let handledMessage: any = null;
    registerHostHandler("host:kick", (ws, msg) => {
      handledMessage = msg;
    });

    const mockWs = {
      data: {
        connectionId: "conn-1",
        roomCode: "ABC123",
        displayName: "Alice",
        missedPongs: 0,
        lastPongTime: Date.now(),
        pingInterval: null,
      },
      send(msg: string) {},
    } as any;

    routeMessage(mockWs, { type: "host:kick", targetId: "conn-2" });
    expect(handledMessage).not.toBeNull();
    expect(handledMessage.type).toBe("host:kick");
  });
});

// ==============================
// WebSocket Connection Lifecycle Tests (Integration)
// ==============================

describe("WebSocket Connection Lifecycle", () => {
  const testSource: VideoSource = { type: "hls", url: "https://example.com/video.m3u8" };
  let testPort: number;
  let server: any;

  beforeEach(async () => {
    // Set short heartbeat interval for tests
    process.env.HEARTBEAT_INTERVAL_MS = "500";

    // Clean up rooms
    const rooms = Array.from((roomManager as any).rooms?.keys?.() || []);
    rooms.forEach((code: string) => roomManager.deleteRoom(code));

    // Start server on a random port
    testPort = 4000 + Math.floor(Math.random() * 1000);
    
    const { websocketHandlers } = await import("../src/ws/handler");
    
    server = Bun.serve({
      port: testPort,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(req);
          if (upgraded) return undefined as unknown as Response;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return new Response("OK");
      },
      websocket: websocketHandlers,
    });
  });

  afterEach(() => {
    if (server) {
      server.stop(true);
      server = null;
    }
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
  });

  test("client can establish WebSocket connection", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("sending valid join message returns room:state", async () => {
    // Create a room first
    const result = roomManager.createRoom(testSource);

    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const responsePromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        // Skip ping messages, wait for room:state
        if (data.type === "room:state") {
          resolve(data);
        }
      };
    });

    ws.send(JSON.stringify({
      type: "join",
      roomCode: result.roomCode,
      displayName: "Alice",
    }));

    const response = await responsePromise;
    expect(response.type).toBe("room:state");
    expect(response.room.id).toBe(result.roomCode);
    expect(response.room.videoSource.type).toBe("hls");
    expect(response.participants.length).toBe(1);
    expect(response.participants[0].displayName).toBe("Alice");
    expect(typeof response.playbackState.position).toBe("number");
    expect(typeof response.playbackState.timestamp).toBe("number");

    ws.close();
  });

  test("joining nonexistent room returns error", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const responsePromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "error") {
          resolve(data);
        }
      };
    });

    ws.send(JSON.stringify({
      type: "join",
      roomCode: "XXXXXX",
      displayName: "Alice",
    }));

    const response = await responsePromise;
    expect(response.type).toBe("error");
    expect(response.code).toBe("ROOM_NOT_FOUND");

    ws.close();
  });

  test("invalid message returns error response", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const responsePromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "error") {
          resolve(data);
        }
      };
    });

    ws.send("not valid json at all");

    const response = await responsePromise;
    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_MESSAGE");

    ws.close();
  });

  test("unknown message type returns error", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const responsePromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "error") {
          resolve(data);
        }
      };
    });

    ws.send(JSON.stringify({ type: "admin:shutdown" }));

    const response = await responsePromise;
    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_MESSAGE");

    ws.close();
  });

  test("server sends ping messages for heartbeat", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const pingPromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "ping") {
          resolve(data);
        }
      };
    });

    // Wait for the first ping (heartbeat interval is 500ms in tests)
    const ping = await Promise.race([
      pingPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 3000)),
    ]);

    expect(ping.type).toBe("ping");
    expect(typeof ping.serverTime).toBe("number");

    ws.close();
  });

  test("client pong resets missed pong counter", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    // Wait for ping, respond with pong
    const pingReceived = new Promise<number>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "ping") {
          resolve(data.serverTime);
        }
      };
    });

    const serverTime = await Promise.race([
      pingReceived,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Ping timeout")), 3000)),
    ]);

    // Send pong back
    ws.send(JSON.stringify({ type: "pong", serverTime }));

    // If we get another ping without being disconnected, the pong was processed
    const secondPing = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "ping") {
          resolve(data);
        }
      };
    });

    const result = await Promise.race([
      secondPing,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Second ping timeout")), 3000)),
    ]);

    expect(result.type).toBe("ping");
    ws.close();
  });

  test("sending message without joining returns error", async () => {
    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const responsePromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "error") {
          resolve(data);
        }
      };
    });

    // Try to send a playback command without joining
    ws.send(JSON.stringify({ type: "playback:play" }));

    const response = await responsePromise;
    expect(response.type).toBe("error");
    expect(response.code).toBe("INVALID_MESSAGE");
    expect(response.message).toContain("join a room first");

    ws.close();
  });

  test("second client gets participant-joined notification", async () => {
    const result = roomManager.createRoom(testSource);

    // First client joins
    const ws1 = new WebSocket(`ws://localhost:${testPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws1.onopen = () => resolve();
      ws1.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    // Wait for room:state for ws1
    const statePromise1 = new Promise<any>((resolve) => {
      ws1.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "room:state") resolve(data);
      };
    });

    ws1.send(JSON.stringify({
      type: "join",
      roomCode: result.roomCode,
      displayName: "Alice",
    }));

    await statePromise1;

    // Now set up listener on ws1 for participant-joined
    const participantJoinedPromise = new Promise<any>((resolve) => {
      ws1.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "room:participant-joined") resolve(data);
      };
    });

    // Second client joins
    const ws2 = new WebSocket(`ws://localhost:${testPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws2.onopen = () => resolve();
      ws2.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    ws2.send(JSON.stringify({
      type: "join",
      roomCode: result.roomCode,
      displayName: "Bob",
    }));

    const notification = await Promise.race([
      participantJoinedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Notification timeout")), 3000)),
    ]);

    expect(notification.type).toBe("room:participant-joined");
    expect(notification.participant.displayName).toBe("Bob");

    ws1.close();
    ws2.close();
  });

  test("disconnect broadcasts participant-left to remaining clients", async () => {
    const result = roomManager.createRoom(testSource);

    // First client joins
    const ws1 = new WebSocket(`ws://localhost:${testPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws1.onopen = () => resolve();
      ws1.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const statePromise1 = new Promise<any>((resolve) => {
      ws1.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "room:state") resolve(data);
      };
    });

    ws1.send(JSON.stringify({
      type: "join",
      roomCode: result.roomCode,
      displayName: "Alice",
    }));
    await statePromise1;

    // Second client joins
    const ws2 = new WebSocket(`ws://localhost:${testPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws2.onopen = () => resolve();
      ws2.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const statePromise2 = new Promise<any>((resolve) => {
      ws2.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "room:state") resolve(data);
      };
    });

    ws2.send(JSON.stringify({
      type: "join",
      roomCode: result.roomCode,
      displayName: "Bob",
    }));

    // Wait for ws1 to receive participant-joined for Bob
    await new Promise<void>((resolve) => {
      ws1.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "room:participant-joined") resolve();
      };
    });

    await statePromise2;

    // Set up listener for participant-left on ws1
    const leftPromise = new Promise<any>((resolve) => {
      ws1.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "room:participant-left") resolve(data);
      };
    });

    // Close ws2
    ws2.close();

    const leftMsg = await Promise.race([
      leftPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Left notification timeout")), 3000)),
    ]);

    expect(leftMsg.type).toBe("room:participant-left");
    expect(typeof leftMsg.participantId).toBe("string");

    ws1.close();
  });

  test("room full returns error when max participants reached", async () => {
    const result = roomManager.createRoom(testSource);

    // Join 3 clients (max)
    const clients: WebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
        setTimeout(() => reject(new Error("Connection timeout")), 2000);
      });

      const stateP = new Promise<void>((resolve) => {
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data as string);
          if (data.type === "room:state") resolve();
        };
      });

      ws.send(JSON.stringify({
        type: "join",
        roomCode: result.roomCode,
        displayName: `User${i}`,
      }));

      await stateP;
      clients.push(ws);
    }

    // 4th client should be rejected
    const ws4 = new WebSocket(`ws://localhost:${testPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws4.onopen = () => resolve();
      ws4.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const errorPromise = new Promise<any>((resolve) => {
      ws4.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "error") resolve(data);
      };
    });

    ws4.send(JSON.stringify({
      type: "join",
      roomCode: result.roomCode,
      displayName: "Rejected",
    }));

    const error = await Promise.race([
      errorPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Error timeout")), 3000)),
    ]);

    expect(error.type).toBe("error");
    expect(error.code).toBe("ROOM_FULL");

    // Cleanup
    clients.forEach((c) => c.close());
    ws4.close();
  });

  test("first participant becomes host", async () => {
    const result = roomManager.createRoom(testSource);

    const ws = new WebSocket(`ws://localhost:${testPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
      setTimeout(() => reject(new Error("Connection timeout")), 2000);
    });

    const statePromise = new Promise<any>((resolve) => {
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data as string);
        if (data.type === "room:state") resolve(data);
      };
    });

    ws.send(JSON.stringify({
      type: "join",
      roomCode: result.roomCode,
      displayName: "Alice",
    }));

    const state = await statePromise;
    // The host should be set to the first participant
    expect(state.room.hostId).not.toBeNull();

    ws.close();
  });
});
