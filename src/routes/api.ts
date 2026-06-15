/**
 * REST API route handlers for room management.
 */

import { roomManager } from "../rooms/manager";
import type { VideoSource } from "../rooms/room";

/**
 * Validates a video source object from request body.
 */
function validateVideoSource(source: unknown): VideoSource | null {
  if (!source || typeof source !== "object") return null;

  const obj = source as Record<string, unknown>;

  if (!obj.type || !obj.url) return null;
  if (
    obj.type !== "file" &&
    obj.type !== "hls" &&
    obj.type !== "youtube" &&
    obj.type !== "vimeo"
  ) {
    return null;
  }
  if (typeof obj.url !== "string" || obj.url.trim().length === 0) {
    return null;
  }

  return { type: obj.type, url: obj.url };
}

/**
 * Handles POST /api/rooms
 * Creates a new room (and optionally a linked room).
 */
export async function handleCreateRoom(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "Request body must be a JSON object" },
      { status: 400 }
    );
  }

  const obj = body as Record<string, unknown>;

  const videoSource = validateVideoSource(obj.videoSource);
  if (!videoSource) {
    return Response.json(
      {
        error:
          'Invalid videoSource. Must include "type" (file|hls|youtube|vimeo) and "url".',
      },
      { status: 400 }
    );
  }

  let linkedVideoSource: VideoSource | undefined;
  if (obj.linkedVideoSource) {
    const validated = validateVideoSource(obj.linkedVideoSource);
    if (!validated) {
      return Response.json(
        {
          error:
            'Invalid linkedVideoSource. Must include "type" (file|hls|youtube|vimeo) and "url".',
        },
        { status: 400 }
      );
    }
    linkedVideoSource = validated;
  }

  const result = roomManager.createRoom(videoSource, linkedVideoSource);

  return Response.json(
    {
      roomCode: result.roomCode,
      ...(result.linkedRoomCode
        ? { linkedRoomCode: result.linkedRoomCode }
        : {}),
    },
    { status: 201 }
  );
}

/**
 * Handles GET /api/rooms/:code
 * Returns room info for the given code.
 */
export function handleGetRoom(code: string): Response {
  const room = roomManager.getRoom(code);

  if (!room) {
    return Response.json(
      { error: "Room not found", code: "ROOM_NOT_FOUND" },
      { status: 404 }
    );
  }

  return Response.json(room.toPublicInfo());
}
