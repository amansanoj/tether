/**
 * Chat message broker: handles incoming chat messages with rate limiting,
 * history management, and broadcast.
 */

import type { ServerWebSocket } from "bun";
import type { Room, ChatMessage } from "../rooms/room";
import { broadcastToRoom, sendTo, type ConnectionData } from "../ws/handler";
import type { ServerMessage } from "../ws/protocol";

/** Maximum messages stored in chat history (FIFO). */
const MAX_CHAT_HISTORY = 200;

/** Rate limit: max messages per sliding window. */
const RATE_LIMIT_MAX = 5;

/** Rate limit sliding window in milliseconds (1 second). */
const RATE_LIMIT_WINDOW_MS = 1000;

/**
 * Per-user message timestamp tracking for rate limiting.
 * Key: senderId, Value: array of timestamps (ms) of recent messages.
 */
const rateLimitMap = new Map<string, number[]>();

/**
 * Check if a user is rate-limited.
 * Uses a sliding window approach: count messages within the last RATE_LIMIT_WINDOW_MS.
 */
function isRateLimited(senderId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(senderId) || [];

  // Remove timestamps outside the window
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitMap.set(senderId, recent);

  return recent.length >= RATE_LIMIT_MAX;
}

/**
 * Record a message timestamp for rate limiting.
 */
function recordMessage(senderId: string): void {
  const now = Date.now();
  const timestamps = rateLimitMap.get(senderId) || [];
  timestamps.push(now);
  rateLimitMap.set(senderId, timestamps);
}

/**
 * Generate a unique message ID.
 */
let messageCounter = 0;
function generateMessageId(): string {
  messageCounter++;
  return `msg_${Date.now()}_${messageCounter}`;
}

/**
 * Handle an incoming chat message.
 * - Rate limits: max 5 messages per second per user (sliding window)
 * - Creates a ChatMessage with generated ID, sender info, and timestamp
 * - Appends to room.data.chatHistory (capped at 200 messages, FIFO)
 * - Broadcasts chat:new-message to all room participants
 */
export function handleChatMessage(
  room: Room,
  senderId: string,
  senderName: string,
  content: string
): boolean {
  // Rate limit check
  if (isRateLimited(senderId)) {
    sendTo(senderId, {
      type: "error",
      code: "RATE_LIMITED",
      message: "You are sending messages too fast",
    });
    return false;
  }

  // Record this message for rate limiting
  recordMessage(senderId);

  // Create chat message
  const chatMessage: ChatMessage = {
    id: generateMessageId(),
    senderId,
    senderName,
    content,
    timestamp: Date.now(),
  };

  // Append to history with FIFO cap
  room.data.chatHistory.push(chatMessage);
  if (room.data.chatHistory.length > MAX_CHAT_HISTORY) {
    room.data.chatHistory.shift();
  }

  // Broadcast to all room participants
  const broadcastMsg: ServerMessage = {
    type: "chat:new-message",
    message: {
      id: chatMessage.id,
      senderId: chatMessage.senderId,
      senderName: chatMessage.senderName,
      content: chatMessage.content,
      timestamp: chatMessage.timestamp,
    },
  };
  broadcastToRoom(room.data.id, broadcastMsg);

  return true;
}

/**
 * Reset rate limit tracking (for testing purposes).
 */
export function resetRateLimits(): void {
  rateLimitMap.clear();
  messageCounter = 0;
}
