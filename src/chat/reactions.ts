/**
 * Chat reactions: handles emoji reactions broadcast to room participants.
 * Reactions are ephemeral - not stored in history.
 */

import type { Room } from "../rooms/room";
import { broadcastToRoom } from "../ws/handler";
import type { ServerMessage } from "../ws/protocol";

/**
 * Predefined set of allowed emojis for reactions.
 */
export const ALLOWED_EMOJIS: ReadonlySet<string> = new Set([
  "\u2764\uFE0F",      // heart
  "\uD83D\uDE02",      // laughing (face with tears of joy)
  "\uD83D\uDD25",      // fire
  "\uD83D\uDC4F",      // clap
  "\uD83D\uDE22",      // cry
  "\uD83D\uDE31",      // shocked (face screaming)
  "\uD83D\uDC4D",      // thumbs up
  "\uD83D\uDC4E",      // thumbs down
  "\uD83C\uDF89",      // party popper
  "\uD83D\uDE0D",      // heart eyes
  "\uD83E\uDD14",      // thinking
  "\uD83D\uDE44",      // eye roll
  "\uD83D\uDE4C",      // raised hands
  "\uD83D\uDCA1",      // light bulb
  "\uD83D\uDE0E",      // cool (sunglasses)
  "\uD83D\uDE21",      // angry
  "\uD83D\uDE34",      // sleeping
  "\uD83D\uDE4A",      // see-no-evil monkey
  "\uD83C\uDF7F",      // popcorn
  "\uD83D\uDC80",      // skull
]);

/**
 * Validate a reaction emoji. Accepts any short non-empty string (covers all
 * emoji, including multi-codepoint sequences) while rejecting abusive payloads.
 */
export function isValidEmoji(emoji: string): boolean {
  return emoji.length > 0 && emoji.length <= 16;
}

/**
 * Handle an emoji reaction.
 * - Validates emoji (any non-empty string is accepted)
 * - Broadcasts chat:new-reaction to all room participants
 * - No history storage (reactions are ephemeral)
 */
export function handleReaction(
  room: Room,
  senderId: string,
  senderName: string,
  emoji: string
): boolean {
  if (!isValidEmoji(emoji)) {
    return false;
  }

  // Broadcast reaction to all room participants
  const reactionMsg: ServerMessage = {
    type: "chat:new-reaction",
    emoji,
    senderName,
  };
  broadcastToRoom(room.data.id, reactionMsg);

  return true;
}
