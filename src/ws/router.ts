/**
 * WebSocket message router: routes messages by type prefix to appropriate handlers.
 */

import type { ServerWebSocket } from "bun";
import type { ConnectionData } from "./handler";
import { serializeMessage, type ClientMessage, type ServerMessage } from "./protocol";

/**
 * Handler function type for routed messages.
 */
export type MessageHandler = (
  ws: ServerWebSocket<ConnectionData>,
  message: ClientMessage
) => void;

// Handler registries for each category
const playbackHandlers: Map<string, MessageHandler> = new Map();
const chatHandlers: Map<string, MessageHandler> = new Map();
const hostHandlers: Map<string, MessageHandler> = new Map();
const heartbeatHandlers: Map<string, MessageHandler> = new Map();

/**
 * Register a handler for playback messages (playback:*).
 */
export function registerPlaybackHandler(
  type: string,
  handler: MessageHandler
): void {
  playbackHandlers.set(type, handler);
}

/**
 * Register a handler for chat messages (chat:*).
 */
export function registerChatHandler(
  type: string,
  handler: MessageHandler
): void {
  chatHandlers.set(type, handler);
}

/**
 * Register a handler for host messages (host:*).
 */
export function registerHostHandler(
  type: string,
  handler: MessageHandler
): void {
  hostHandlers.set(type, handler);
}

/**
 * Register a handler for heartbeat messages.
 */
export function registerHeartbeatHandler(
  type: string,
  handler: MessageHandler
): void {
  heartbeatHandlers.set(type, handler);
}

/**
 * Route an incoming message to the appropriate handler based on type prefix.
 * Messages are routed as follows:
 *   - playback:* -> playback handlers
 *   - chat:* -> chat handlers
 *   - host:* -> host handlers
 *   - heartbeat -> heartbeat handlers
 *   - Unknown types -> send error back to client
 */
export function routeMessage(
  ws: ServerWebSocket<ConnectionData>,
  message: ClientMessage
): void {
  const { type } = message;

  // Route by prefix
  if (type.startsWith("playback:")) {
    const handler = playbackHandlers.get(type);
    if (handler) {
      handler(ws, message);
      return;
    }
  } else if (type.startsWith("chat:")) {
    const handler = chatHandlers.get(type);
    if (handler) {
      handler(ws, message);
      return;
    }
  } else if (type.startsWith("host:")) {
    const handler = hostHandlers.get(type);
    if (handler) {
      handler(ws, message);
      return;
    }
  } else if (type === "heartbeat") {
    const handler = heartbeatHandlers.get(type);
    if (handler) {
      handler(ws, message);
      return;
    }
  }

  // No handler found - send error
  const errorMsg: ServerMessage = {
    type: "error",
    code: "INVALID_MESSAGE",
    message: `No handler registered for message type: ${type}`,
  };
  ws.send(serializeMessage(errorMsg));
}
