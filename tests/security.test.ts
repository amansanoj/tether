import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { safeStaticPath } from "../src/utils/paths";
import { isValidEmoji } from "../src/chat/reactions";
import { roomManager } from "../src/rooms/manager";
import { websocketHandlers } from "../src/ws/handler";
import type { VideoSource } from "../src/rooms/room";

const SRC: VideoSource = { type: "hls", url: "https://example.com/v.m3u8" };

// ==============================
// Path traversal guard
// ==============================

describe("safeStaticPath", () => {
  const DIST = "/app/dist";

  test("allows normal asset paths", () => {
    expect(safeStaticPath(DIST, "/assets/index-abc.js")).toBe(
      join(DIST, "/assets/index-abc.js")
    );
  });

  test("allows the root (stays inside dist)", () => {
    const result = safeStaticPath(DIST, "/");
    expect(result).not.toBeNull();
    expect(result!.startsWith(DIST)).toBe(true);
  });

  test("rejects parent-directory traversal", () => {
    expect(safeStaticPath(DIST, "/../../etc/passwd")).toBeNull();
    expect(safeStaticPath(DIST, "/../package.json")).toBeNull();
  });

  test("rejects a sibling directory with a shared prefix", () => {
    // /app/dist-secret should NOT be treated as inside /app/dist
    expect(safeStaticPath("/app/dist", "/../dist-secret/x")).toBeNull();
  });
});

// ==============================
// Reaction emoji validation
// ==============================

describe("isValidEmoji", () => {
  test("accepts real emoji (incl. multi-codepoint)", () => {
    expect(isValidEmoji("❤️")).toBe(true);
    expect(isValidEmoji("👍")).toBe(true);
  });

  test("rejects empty", () => {
    expect(isValidEmoji("")).toBe(false);
  });

  test("rejects abusively long payloads", () => {
    expect(isValidEmoji("x".repeat(17))).toBe(false);
    expect(isValidEmoji("<script>alert(1)</script>")).toBe(false);
  });
});

// ==============================
// Rooms created but never joined are cleaned up
// ==============================

describe("Never-joined room cleanup", () => {
  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, unknown>;
    for (const code of Array.from(rooms.keys())) roomManager.deleteRoom(code as string);
  });

  test("createRoom starts a grace-period cleanup timer", () => {
    const { roomCode } = roomManager.createRoom(SRC);
    const room = roomManager.getRoom(roomCode)!;
    expect(room.data.cleanupTimer).not.toBeNull();
  });

  test("joining cancels the grace-period timer", () => {
    const { roomCode } = roomManager.createRoom(SRC);
    const room = roomManager.getRoom(roomCode)!;
    room.addParticipant("conn-1", "Alice");
    expect(room.data.cleanupTimer).toBeNull();
  });
});

// ==============================
// Server-side display name clamping (integration)
// ==============================

describe("displayName is clamped server-side", () => {
  let server: any;
  let port: number;

  beforeEach(() => {
    process.env.HEARTBEAT_INTERVAL_MS = "60000";
    const rooms = (roomManager as any).rooms as Map<string, unknown>;
    for (const code of Array.from(rooms.keys())) roomManager.deleteRoom(code as string);
    port = 6000 + Math.floor(Math.random() * 1500);
    server = Bun.serve({
      port,
      fetch(req, srv) {
        if (new URL(req.url).pathname === "/ws") {
          return srv.upgrade(req) ? (undefined as any) : new Response("no", { status: 400 });
        }
        return new Response("ok");
      },
      websocket: websocketHandlers,
    });
  });

  afterEach(() => {
    server?.stop(true);
    process.env.HEARTBEAT_INTERVAL_MS = "5000";
  });

  test("a 100-char display name is truncated to 32", async () => {
    const { roomCode } = roomManager.createRoom(SRC);
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = (e) => rej(e);
      setTimeout(() => rej(new Error("timeout")), 2000);
    });

    const state = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m.type === "room:state") resolve(m);
      };
      ws.send(
        JSON.stringify({
          type: "join",
          roomCode,
          displayName: "a".repeat(100),
          clientId: "c1",
        })
      );
    });

    const me = state.participants.find((p: any) => p.id === state.connectionId);
    expect(me.displayName.length).toBe(32);
    ws.close();
  });
});
