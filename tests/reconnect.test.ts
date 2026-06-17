import { describe, test, expect, beforeEach } from "bun:test";
import { roomManager } from "../src/rooms/manager";
import type { VideoSource } from "../src/rooms/room";

const SRC: VideoSource = { type: "hls", url: "https://example.com/v.m3u8" };

function clearRooms(): void {
  const rooms = (roomManager as any).rooms as Map<string, unknown>;
  for (const code of Array.from(rooms.keys())) roomManager.deleteRoom(code as string);
}

describe("Reconnection slot holds (token-based)", () => {
  let roomCode: string;

  beforeEach(() => {
    clearRooms();
    roomCode = roomManager.createRoom(SRC).roomCode;
  });

  test("a held slot is reclaimed by the same clientId", () => {
    roomManager.createSlotHold("client-A", "conn-123", roomCode);
    const reclaimed = roomManager.claimSlotHold("client-A", roomCode);
    expect(reclaimed).toBe("conn-123");
  });

  test("a different clientId does NOT reclaim the slot", () => {
    roomManager.createSlotHold("client-A", "conn-123", roomCode);
    expect(roomManager.claimSlotHold("client-B", roomCode)).toBeNull();
  });

  test("claiming consumes the hold (second claim returns null)", () => {
    roomManager.createSlotHold("client-A", "conn-123", roomCode);
    expect(roomManager.claimSlotHold("client-A", roomCode)).toBe("conn-123");
    expect(roomManager.claimSlotHold("client-A", roomCode)).toBeNull();
  });

  test("holds are scoped per room", () => {
    const other = roomManager.createRoom(SRC).roomCode;
    roomManager.createSlotHold("client-A", "conn-123", roomCode);
    expect(roomManager.claimSlotHold("client-A", other)).toBeNull();
    expect(roomManager.claimSlotHold("client-A", roomCode)).toBe("conn-123");
  });

  test("same display name, different clients, do not collide", () => {
    roomManager.createSlotHold("client-A", "conn-A", roomCode);
    roomManager.createSlotHold("client-B", "conn-B", roomCode);
    expect(roomManager.claimSlotHold("client-B", roomCode)).toBe("conn-B");
    expect(roomManager.claimSlotHold("client-A", roomCode)).toBe("conn-A");
  });
});
