import { describe, test, expect, beforeEach } from "bun:test";
import { roomManager } from "../src/rooms/manager";
import { registerQueueHandlers } from "../src/queue/commands";
import { routeMessage } from "../src/ws/router";
import type { VideoSource } from "../src/rooms/room";

registerQueueHandlers();

const SRC: VideoSource = { type: "youtube", url: "https://youtu.be/aaaaaaaaaaa" };

function clearRooms(): void {
  const rooms = (roomManager as any).rooms as Map<string, unknown>;
  for (const code of Array.from(rooms.keys())) roomManager.deleteRoom(code as string);
}

function mockWs(roomCode: string) {
  const sent: any[] = [];
  return {
    data: {
      connectionId: "conn_1",
      clientId: "client_1",
      roomCode,
      displayName: "Aman",
      missedPongs: 0,
      lastPongTime: Date.now(),
      pingInterval: null,
    },
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
    get sent() {
      return sent;
    },
  } as any;
}

describe("Queue", () => {
  let roomCode: string;

  beforeEach(() => {
    clearRooms();
    roomCode = roomManager.createRoom(SRC, undefined, [], "Aman", "First Song").roomCode;
  });

  test("room is seeded with one queue item carrying the resolved title", () => {
    const room = roomManager.getRoom(roomCode)!;
    expect(room.data.queue).toHaveLength(1);
    expect(room.data.queue[0].title).toBe("First Song");
    expect(room.data.currentIndex).toBe(0);
  });

  test("queue:add appends an item with the adder's connection id", () => {
    const ws = mockWs(roomCode);
    routeMessage(ws, {
      type: "queue:add",
      source: { type: "youtube", url: "https://youtu.be/bbbbbbbbbbb" },
      title: "Song B",
    });
    const room = roomManager.getRoom(roomCode)!;
    expect(room.data.queue).toHaveLength(2);
    expect(room.data.queue[1].title).toBe("Song B");
    expect(room.data.queue[1].addedById).toBe("conn_1");
  });

  test("queue:jump changes the current track and resets playback", () => {
    const ws = mockWs(roomCode);
    routeMessage(ws, { type: "queue:add", source: SRC, title: "B" });
    routeMessage(ws, { type: "queue:jump", index: 1 });
    const room = roomManager.getRoom(roomCode)!;
    expect(room.data.currentIndex).toBe(1);
    expect(room.data.playbackState.isPlaying).toBe(true);
    expect(room.data.playbackState.position).toBe(0);
    expect(room.data.playbackState.duration).toBe(0);
  });

  test("queue:remove drops the item and keeps currentIndex valid", () => {
    const ws = mockWs(roomCode);
    routeMessage(ws, { type: "queue:add", source: SRC, title: "B" });
    const room = roomManager.getRoom(roomCode)!;
    const idToRemove = room.data.queue[1].id;
    routeMessage(ws, { type: "queue:remove", id: idToRemove });
    expect(room.data.queue).toHaveLength(1);
    expect(room.data.currentIndex).toBe(0);
  });

  test("queue is capped and rejects further adds with QUEUE_FULL", () => {
    const room = roomManager.getRoom(roomCode)!;
    // Fill to the cap (200) directly
    while (room.data.queue.length < 200) {
      room.data.queue.push({
        id: `id_${room.data.queue.length}`,
        source: SRC,
        title: "x",
        addedBy: "Aman",
        addedById: "conn_1",
      });
    }
    const ws = mockWs(roomCode);
    routeMessage(ws, { type: "queue:add", source: SRC, title: "overflow" });
    expect(room.data.queue).toHaveLength(200);
    expect(ws.sent.some((m: any) => m.type === "error" && m.code === "QUEUE_FULL")).toBe(true);
  });

  test("queue:next at the last track pauses instead of running the clock forever", () => {
    const room = roomManager.getRoom(roomCode)!;
    room.data.playbackState.isPlaying = true;
    room.data.playbackState.lastUpdated = Date.now();
    // single seeded item -> currentIndex 0 is the last track
    const ws = mockWs(roomCode);
    routeMessage(ws, { type: "queue:next" });
    expect(room.data.playbackState.isPlaying).toBe(false);
  });
});
