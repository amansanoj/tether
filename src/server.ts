import { join } from "path";
import { handleCreateRoom, handleGetRoom } from "./routes/api";
import { roomManager } from "./rooms/manager";
import { registerSyncHandlers } from "./sync/commands";
import { registerHostHandlers } from "./host/commands";
import { registerChatHandlers } from "./chat/commands";
import { registerQueueHandlers } from "./queue/commands";
import { removeSyncEngine } from "./sync/engine";
import { stopDashboardBroadcast } from "./host/commands";
import { clearQueueState } from "./queue/commands";
import { websocketHandlers, type ConnectionData } from "./ws/handler";

// Register message handlers
registerSyncHandlers();
registerHostHandlers();
registerChatHandlers();
registerQueueHandlers();

// Release per-room resources when a room is deleted (prevents leaks)
roomManager.onRoomDeleted((roomId) => {
  removeSyncEngine(roomId);
  stopDashboardBroadcast(roomId);
  clearQueueState(roomId);
});

const PORT = parseInt(process.env.PORT || "3000", 10);
const DIST_DIR = join(import.meta.dir, "..", "dist");
const startTime = Date.now();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}

async function serveStaticFile(pathname: string): Promise<Response | null> {
  const filePath = join(DIST_DIR, pathname);

  // Path-traversal guard: never serve anything resolved outside DIST_DIR.
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + "/")) {
    return serveIndexFallback();
  }

  try {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      // Hashed assets (e.g. /assets/index-a1b2c3d4.js) can be cached forever
      // because the filename changes whenever the content changes.
      const isHashedAsset = pathname.startsWith("/assets/");
      return new Response(file, {
        headers: {
          "Content-Type": getMimeType(filePath),
          "Cache-Control": isHashedAsset
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }
  } catch {
    // File doesn't exist, continue
  }

  return serveIndexFallback();
}

/**
 * SPA fallback: serve index.html (always revalidated) for non-file routes.
 */
async function serveIndexFallback(): Promise<Response | null> {
  try {
    const indexFile = Bun.file(join(DIST_DIR, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: {
          "Content-Type": "text/html",
          "Cache-Control": "no-cache",
        },
      });
    }
  } catch {
    // index.html doesn't exist
  }
  return null;
}

/**
 * Matches a URL pattern like /api/rooms/:code and returns extracted params.
 */
function matchRoute(
  pathname: string,
  pattern: string
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // WebSocket upgrade
    if (pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // API routes
    if (pathname === "/api/health") {
      return Response.json({
        status: "ok",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        roomCount: roomManager.getRoomCount(),
      });
    }

    // POST /api/rooms - Create a new room
    if (pathname === "/api/rooms" && req.method === "POST") {
      return handleCreateRoom(req);
    }

    // GET /api/rooms/:code - Get room info
    const roomParams = matchRoute(pathname, "/api/rooms/:code");
    if (roomParams && req.method === "GET") {
      return handleGetRoom(roomParams.code);
    }

    // Static file serving
    const staticResponse = await serveStaticFile(pathname);
    if (staticResponse) return staticResponse;

    return new Response("Not Found", { status: 404 });
  },
  websocket: websocketHandlers,
});

console.log(`Tether server running on http://localhost:${server.port}`);

// Graceful shutdown handler
function handleShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  console.log(`Active rooms: ${roomManager.getRoomCount()}`);

  // Stop accepting new connections and close existing ones
  server.stop(true);

  console.log("Server stopped. Goodbye.");
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
