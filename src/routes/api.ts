/**
 * REST API route handlers for room management.
 */

import { roomManager } from "../rooms/manager";
import type { VideoSource, AudioTrack } from "../rooms/room";

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

  const result: VideoSource = { type: obj.type, url: obj.url.trim() };
  if (typeof obj.label === "string" && obj.label.trim().length > 0) {
    result.label = obj.label.trim();
  }
  return result;
}

/**
 * Validates and normalizes an array of audio tracks. Invalid entries are
 * dropped; returns an empty array if the input is missing or not an array.
 */
function validateAudioTracks(value: unknown): AudioTrack[] {
  if (!Array.isArray(value)) return [];

  const tracks: AudioTrack[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.url !== "string" || obj.url.trim().length === 0) continue;
    const label =
      typeof obj.label === "string" && obj.label.trim().length > 0
        ? obj.label.trim()
        : `Track ${tracks.length + 1}`;
    tracks.push({ label, url: obj.url.trim() });
  }
  return tracks;
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

  const audioTracks = validateAudioTracks(obj.audioTracks);
  const hostName =
    typeof obj.hostName === "string" && obj.hostName.trim().length > 0
      ? obj.hostName.trim()
      : "host";
  const videoTitle =
    typeof obj.videoTitle === "string" && obj.videoTitle.trim().length > 0
      ? obj.videoTitle.trim()
      : undefined;
  const linkedTitle =
    typeof obj.linkedTitle === "string" && obj.linkedTitle.trim().length > 0
      ? obj.linkedTitle.trim()
      : undefined;

  const result = roomManager.createRoom(
    videoSource,
    linkedVideoSource,
    audioTracks,
    hostName,
    videoTitle,
    linkedTitle
  );

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
 * Handles GET /api/title?url=...
 * Server-side oEmbed proxy so the client can resolve YouTube/Vimeo titles
 * without hitting cross-origin CORS restrictions.
 */
export async function handleResolveTitle(url: string): Promise<Response> {
  if (!url) return Response.json({ title: null });

  let endpoint: string | null = null;
  if (/youtube\.com|youtu\.be/i.test(url)) {
    endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  } else if (/vimeo\.com/i.test(url)) {
    endpoint = `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
  }
  if (!endpoint) return Response.json({ title: null });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(endpoint, { signal: controller.signal });
    if (r.ok) {
      const j = (await r.json()) as { title?: unknown };
      if (typeof j.title === "string" && j.title.length > 0) {
        return Response.json({ title: j.title });
      }
    }
  } catch {
    // network / timeout — fall through
  } finally {
    clearTimeout(timer);
  }
  return Response.json({ title: null });
}
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
