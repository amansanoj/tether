import { describe, test, expect, beforeEach } from "bun:test";
import { Room, type VideoSource } from "../src/rooms/room";
import { roomManager } from "../src/rooms/manager";
import { handleChatMessage, resetRateLimits } from "../src/chat/broker";
import { handleReaction, ALLOWED_EMOJIS, isValidEmoji } from "../src/chat/reactions";
import { registerChatHandlers } from "../src/chat/commands";

const testVideoSource: VideoSource = {
  type: "hls",
  url: "https://example.com/video.m3u8",
};

// ==============================
// Helper: Mock WebSocket and sendTo/broadcastToRoom
// ==============================

// We mock the handler module's sendTo and broadcastToRoom via module-level interception
// For unit testing, we'll call handleChatMessage/handleReaction directly on Room objects
// and verify the room state changes.

// Since broadcastToRoom/sendTo rely on the global connections map,
// we test the broker logic (rate limiting, history) via direct calls.

// ==============================
// Chat Message Broadcasting Tests
// ==============================

describe("Chat Message Broadcasting", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
    resetRateLimits();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("user1", "Alice");
    room.addParticipant("user2", "Bob");
  });

  test("handleChatMessage adds message to chat history", () => {
    const result = handleChatMessage(room, "user1", "Alice", "Hello everyone!");

    expect(result).toBe(true);
    expect(room.data.chatHistory).toHaveLength(1);
    expect(room.data.chatHistory[0].content).toBe("Hello everyone!");
    expect(room.data.chatHistory[0].senderId).toBe("user1");
    expect(room.data.chatHistory[0].senderName).toBe("Alice");
  });

  test("message has generated ID", () => {
    handleChatMessage(room, "user1", "Alice", "Test message");

    const msg = room.data.chatHistory[0];
    expect(msg.id).toBeDefined();
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.id.startsWith("msg_")).toBe(true);
  });

  test("message has timestamp", () => {
    const before = Date.now();
    handleChatMessage(room, "user1", "Alice", "Test message");
    const after = Date.now();

    const msg = room.data.chatHistory[0];
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  test("multiple messages are stored in order", () => {
    handleChatMessage(room, "user1", "Alice", "First");
    handleChatMessage(room, "user2", "Bob", "Second");
    handleChatMessage(room, "user1", "Alice", "Third");

    expect(room.data.chatHistory).toHaveLength(3);
    expect(room.data.chatHistory[0].content).toBe("First");
    expect(room.data.chatHistory[1].content).toBe("Second");
    expect(room.data.chatHistory[2].content).toBe("Third");
  });

  test("each message gets a unique ID", () => {
    handleChatMessage(room, "user1", "Alice", "First");
    handleChatMessage(room, "user1", "Alice", "Second");

    const ids = room.data.chatHistory.map((m) => m.id);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ==============================
// Rate Limiting Tests
// ==============================

describe("Chat Rate Limiting", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
    resetRateLimits();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("user1", "Alice");
    room.addParticipant("user2", "Bob");
  });

  test("allows up to 5 messages per second", () => {
    for (let i = 0; i < 5; i++) {
      const result = handleChatMessage(room, "user1", "Alice", `Message ${i + 1}`);
      expect(result).toBe(true);
    }

    expect(room.data.chatHistory).toHaveLength(5);
  });

  test("6th message in 1 second is rejected (rate limited)", () => {
    // Send 5 messages (all should succeed)
    for (let i = 0; i < 5; i++) {
      handleChatMessage(room, "user1", "Alice", `Message ${i + 1}`);
    }

    // 6th message should be rejected
    const result = handleChatMessage(room, "user1", "Alice", "Sixth message");
    expect(result).toBe(false);
    expect(room.data.chatHistory).toHaveLength(5);
  });

  test("rate limiting is per-user", () => {
    // Fill Alice's rate limit
    for (let i = 0; i < 5; i++) {
      handleChatMessage(room, "user1", "Alice", `Alice msg ${i + 1}`);
    }

    // Bob should still be able to send
    const result = handleChatMessage(room, "user2", "Bob", "Bob's message");
    expect(result).toBe(true);
    expect(room.data.chatHistory).toHaveLength(6);
  });

  test("rate limit resets after window expires", async () => {
    // Send 5 messages
    for (let i = 0; i < 5; i++) {
      handleChatMessage(room, "user1", "Alice", `Message ${i + 1}`);
    }

    // 6th should fail
    expect(handleChatMessage(room, "user1", "Alice", "Too fast")).toBe(false);

    // Wait for the sliding window to pass (1 second + buffer)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Now should succeed again
    const result = handleChatMessage(room, "user1", "Alice", "After wait");
    expect(result).toBe(true);
  });

  test("rate limited message does not appear in history", () => {
    for (let i = 0; i < 5; i++) {
      handleChatMessage(room, "user1", "Alice", `Message ${i + 1}`);
    }

    // Rate limited
    handleChatMessage(room, "user1", "Alice", "Should not appear");

    expect(room.data.chatHistory).toHaveLength(5);
    const contents = room.data.chatHistory.map((m) => m.content);
    expect(contents).not.toContain("Should not appear");
  });
});

// ==============================
// Chat History Cap Tests
// ==============================

describe("Chat History Cap (200 messages)", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
    resetRateLimits();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("user1", "Alice");
  });

  test("history is capped at 200 messages", () => {
    // Manually fill 200 messages (bypassing rate limiting by resetting each time)
    for (let i = 0; i < 200; i++) {
      room.data.chatHistory.push({
        id: `msg_${i}`,
        senderId: "user1",
        senderName: "Alice",
        content: `Message ${i}`,
        timestamp: Date.now(),
      });
    }

    expect(room.data.chatHistory).toHaveLength(200);

    // Add one more through the handler
    resetRateLimits();
    handleChatMessage(room, "user1", "Alice", "Message 201");

    expect(room.data.chatHistory).toHaveLength(200);
  });

  test("oldest message is removed when cap is exceeded (FIFO)", () => {
    // Fill history to 200
    for (let i = 0; i < 200; i++) {
      room.data.chatHistory.push({
        id: `msg_${i}`,
        senderId: "user1",
        senderName: "Alice",
        content: `Message ${i}`,
        timestamp: Date.now(),
      });
    }

    resetRateLimits();
    handleChatMessage(room, "user1", "Alice", "Newest message");

    // First message should be "Message 1" (original "Message 0" was removed)
    expect(room.data.chatHistory[0].content).toBe("Message 1");
    // Last message should be the newest
    expect(room.data.chatHistory[199].content).toBe("Newest message");
  });

  test("history below cap does not drop messages", () => {
    resetRateLimits();
    for (let i = 0; i < 5; i++) {
      handleChatMessage(room, "user1", "Alice", `Message ${i}`);
    }

    expect(room.data.chatHistory).toHaveLength(5);
    expect(room.data.chatHistory[0].content).toBe("Message 0");
    expect(room.data.chatHistory[4].content).toBe("Message 4");
  });
});

// ==============================
// Late Joiner Chat History Tests
// ==============================

describe("Late Joiner Receives Chat History", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
    resetRateLimits();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("user1", "Alice");
  });

  test("chatHistory is available in room data for room:state", () => {
    handleChatMessage(room, "user1", "Alice", "Hello!");
    handleChatMessage(room, "user1", "Alice", "How is everyone?");

    // When building room:state message, chatHistory is directly accessible
    expect(room.data.chatHistory).toHaveLength(2);
    expect(room.data.chatHistory[0].content).toBe("Hello!");
    expect(room.data.chatHistory[1].content).toBe("How is everyone?");
  });

  test("chatHistory includes all message fields for serialization", () => {
    handleChatMessage(room, "user1", "Alice", "Test");

    const msg = room.data.chatHistory[0];
    expect(msg).toHaveProperty("id");
    expect(msg).toHaveProperty("senderId");
    expect(msg).toHaveProperty("senderName");
    expect(msg).toHaveProperty("content");
    expect(msg).toHaveProperty("timestamp");
  });

  test("new participant would receive existing chat history in room:state", () => {
    // Add some messages first
    handleChatMessage(room, "user1", "Alice", "Welcome!");
    handleChatMessage(room, "user1", "Alice", "The video starts soon.");

    // Simulate late joiner - they get room.data.chatHistory in room:state
    room.addParticipant("user2", "Bob");

    // The chatHistory is on the room data and sent as part of room:state
    const chatHistory = room.data.chatHistory;
    expect(chatHistory).toHaveLength(2);
    expect(chatHistory[0].content).toBe("Welcome!");
    expect(chatHistory[1].content).toBe("The video starts soon.");
  });
});

// ==============================
// Reaction Broadcasting Tests
// ==============================

describe("Reaction Broadcasting", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("user1", "Alice");
    room.addParticipant("user2", "Bob");
  });

  test("handleReaction returns true for valid emoji", () => {
    const result = handleReaction(room, "user1", "Alice", "\u2764\uFE0F");
    expect(result).toBe(true);
  });

  test("handleReaction returns true for any non-empty string", () => {
    const result = handleReaction(room, "user1", "Alice", "custom-emoji");
    expect(result).toBe(true);
  });

  test("handleReaction returns false for empty emoji", () => {
    const result = handleReaction(room, "user1", "Alice", "");
    expect(result).toBe(false);
  });

  test("reactions are NOT stored in chat history", () => {
    handleReaction(room, "user1", "Alice", "\uD83D\uDD25");
    handleReaction(room, "user2", "Bob", "\uD83D\uDC4F");

    expect(room.data.chatHistory).toHaveLength(0);
  });

  test("multiple reactions do not accumulate in any history", () => {
    for (let i = 0; i < 10; i++) {
      handleReaction(room, "user1", "Alice", "\uD83D\uDE02");
    }
    expect(room.data.chatHistory).toHaveLength(0);
  });
});

// ==============================
// Emoji Validation Tests
// ==============================

describe("Emoji Validation", () => {
  test("predefined emoji set has ~20 emojis", () => {
    expect(ALLOWED_EMOJIS.size).toBeGreaterThanOrEqual(20);
  });

  test("predefined set includes heart emoji", () => {
    expect(ALLOWED_EMOJIS.has("\u2764\uFE0F")).toBe(true);
  });

  test("predefined set includes fire emoji", () => {
    expect(ALLOWED_EMOJIS.has("\uD83D\uDD25")).toBe(true);
  });

  test("predefined set includes thumbs up emoji", () => {
    expect(ALLOWED_EMOJIS.has("\uD83D\uDC4D")).toBe(true);
  });

  test("predefined set includes clap emoji", () => {
    expect(ALLOWED_EMOJIS.has("\uD83D\uDC4F")).toBe(true);
  });

  test("predefined set includes laughing emoji", () => {
    expect(ALLOWED_EMOJIS.has("\uD83D\uDE02")).toBe(true);
  });

  test("isValidEmoji accepts non-empty strings", () => {
    expect(isValidEmoji("\uD83D\uDE02")).toBe(true);
    expect(isValidEmoji("fire")).toBe(true);
    expect(isValidEmoji("a")).toBe(true);
  });

  test("isValidEmoji rejects empty string", () => {
    expect(isValidEmoji("")).toBe(false);
  });
});

// ==============================
// Chat Handler Registration Tests
// ==============================

describe("Chat Handler Registration", () => {
  test("registerChatHandlers does not throw", () => {
    expect(() => registerChatHandlers()).not.toThrow();
  });
});

// ==============================
// Edge Cases
// ==============================

describe("Chat Edge Cases", () => {
  let room: Room;

  beforeEach(() => {
    const rooms = (roomManager as any).rooms as Map<string, Room>;
    rooms.clear();
    resetRateLimits();

    const { roomCode } = roomManager.createRoom(testVideoSource);
    room = roomManager.getRoom(roomCode)!;
    room.addParticipant("user1", "Alice");
  });

  test("empty chat history initially", () => {
    expect(room.data.chatHistory).toHaveLength(0);
  });

  test("messages preserve exact content", () => {
    const content = "Hello! \n Special chars: <>&\"' \t tab";
    handleChatMessage(room, "user1", "Alice", content);
    expect(room.data.chatHistory[0].content).toBe(content);
  });

  test("long messages are stored as-is", () => {
    const longContent = "x".repeat(5000);
    handleChatMessage(room, "user1", "Alice", longContent);
    expect(room.data.chatHistory[0].content).toBe(longContent);
    expect(room.data.chatHistory[0].content.length).toBe(5000);
  });

  test("message from different users track correctly", () => {
    room.addParticipant("user2", "Bob");
    resetRateLimits();

    handleChatMessage(room, "user1", "Alice", "From Alice");
    handleChatMessage(room, "user2", "Bob", "From Bob");

    expect(room.data.chatHistory[0].senderId).toBe("user1");
    expect(room.data.chatHistory[0].senderName).toBe("Alice");
    expect(room.data.chatHistory[1].senderId).toBe("user2");
    expect(room.data.chatHistory[1].senderName).toBe("Bob");
  });
});
