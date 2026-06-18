/**
 * Chat command registration: wires chat message and reaction handlers into the router.
 */

import type { ServerWebSocket } from "bun";
import { roomManager } from "../rooms/manager";
import type { ConnectionData } from "../ws/handler";
import type { ClientMessage } from "../ws/protocol";
import { registerChatHandler } from "../ws/router";
import { handleChatMessage } from "./broker";
import { handleReaction } from "./reactions";

/**
 * Register all chat command handlers with the router.
 */
export function registerChatHandlers(): void {
  // chat:message handler
  registerChatHandler(
    "chat:message",
    (ws: ServerWebSocket<ConnectionData>, message: ClientMessage) => {
      if (message.type !== "chat:message") return;

      const room = roomManager.getRoom(ws.data.roomCode!);
      if (!room) return;

      handleChatMessage(
        room,
        ws.data.connectionId,
        ws.data.displayName!,
        message.content,
        ws.data.clientId
      );
    }
  );

  // chat:reaction handler
  registerChatHandler(
    "chat:reaction",
    (ws: ServerWebSocket<ConnectionData>, message: ClientMessage) => {
      if (message.type !== "chat:reaction") return;

      const room = roomManager.getRoom(ws.data.roomCode!);
      if (!room) return;

      handleReaction(
        room,
        ws.data.connectionId,
        ws.data.displayName!,
        message.emoji
      );
    }
  );
}
