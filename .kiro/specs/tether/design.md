# Tether - Design

## Architecture Overview

Tether is a monolithic Bun application that serves both the Solid.js frontend (static assets) and the backend (WebSocket server + REST API) from a single process. All state is held in-memory.

```
+------------------+       +------------------+       +------------------+
|   Client A       |       |   Tether Server  |       |   Cloudflare R2  |
|   (Browser)      |<----->|   (Bun Process)  |       |   (HLS Segments) |
+------------------+  WS   +------------------+       +------------------+
                            |  - Room State    |              ^
+------------------+        |  - Sync Engine   |              |
|   Client B       |<------>|  - Chat Broker   |              |
|   (Browser)      |  WS   |  - Static Files  |--------------+
+------------------+        +------------------+   HLS manifest
                                    |                 & segments
+------------------+                |
|   Client C       |<-------------->|
|   (Browser)      |       WS
+------------------+
```

### Request Flow

1. Client loads the frontend (static HTML/JS/CSS served by Bun).
2. Client joins a room by entering a room code and display name.
3. A WebSocket connection is established for real-time communication.
4. The HLS video player fetches the `.m3u8` manifest and `.ts` segments directly from a Cloudflare R2 presigned URL (or public bucket).
5. All sync, chat, and reaction messages flow over the single WebSocket connection.

---

## Component Architecture

### Backend Components

```
src/
  server.ts              # Bun HTTP + WebSocket server entry point
  routes/
    api.ts               # REST endpoints (create room, room info)
    static.ts            # Static file serving for frontend assets
  ws/
    handler.ts           # WebSocket upgrade, connection lifecycle
    protocol.ts          # Message type definitions and validation
    router.ts            # Routes incoming WS messages to handlers
  rooms/
    manager.ts           # Room CRUD, lifecycle, cleanup timers
    room.ts              # Single room state (participants, playback)
    linked-rooms.ts      # Multi-room linking logic
  sync/
    engine.ts            # Authoritative clock, drift detection
    commands.ts          # Play/pause/seek command processing
  chat/
    broker.ts            # Message fan-out, rate limiting
    reactions.ts         # Emoji reaction broadcasting
  utils/
    id.ts                # Room code generation
    time.ts              # High-resolution timing utilities
```

### Frontend Components

```
client/
  index.html             # Entry HTML shell
  src/
    index.tsx            # Solid.js app entry point
    App.tsx              # Root component, route handling
    components/
      Player.tsx         # HLS video player (hls.js integration)
      EmbeddedPlayer.tsx # YouTube/Vimeo iframe player
      Chat.tsx           # Chat message list + input
      Reactions.tsx      # Floating emoji reaction layer
      Dashboard.tsx      # Host dashboard panel
      RoomJoin.tsx       # Join room form
      StatusBar.tsx      # Connection status indicator
    lib/
      ws.ts              # WebSocket client with reconnect logic
      sync.ts            # Client-side drift detection + rate adjust
      hls.ts             # hls.js wrapper and config
    stores/
      room.ts            # Reactive room state (Solid.js store)
      chat.ts            # Chat message history store
      connection.ts      # Connection status store
```

---

## Data Models

### Room

```typescript
interface Room {
  id: string;                    // 6-char alphanumeric code
  hostId: string;                // Connection ID of the creator
  videoSource: VideoSource;
  participants: Map<string, Participant>;
  playbackState: PlaybackState;
  linkedRoomId: string | null;   // ID of linked room (if multi-room)
  chatHistory: ChatMessage[];
  createdAt: number;
  cleanupTimer: Timer | null;    // 5-min grace period timer
}

interface VideoSource {
  type: 'hls' | 'youtube' | 'vimeo';
  url: string;                   // HLS manifest URL or embed URL
}

interface Participant {
  id: string;                    // Unique connection ID
  displayName: string;
  joinedAt: number;
  lastHeartbeat: number;
  reportedPosition: number;      // Last reported playback position (seconds)
  drift: number;                 // Computed drift from authoritative position
  latency: number;               // Round-trip WebSocket latency (ms)
  isBuffering: boolean;
  isKicked: boolean;
}

interface PlaybackState {
  isPlaying: boolean;
  position: number;              // Authoritative position in seconds
  lastUpdated: number;           // Timestamp when position was last set
  playbackRate: number;          // Always 1.0 on server; clients adjust locally
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}
```

---

## WebSocket Protocol

All messages are JSON-encoded with a `type` field for routing.

### Client -> Server Messages

| Type | Payload | Description |
|------|---------|-------------|
| `join` | `{ roomCode, displayName }` | Join a room |
| `playback:play` | `{}` | Resume playback |
| `playback:pause` | `{}` | Pause playback |
| `playback:seek` | `{ position }` | Seek to position (seconds) |
| `heartbeat` | `{ position, isBuffering, clientTime }` | Periodic state report |
| `chat:message` | `{ content }` | Send a chat message |
| `chat:reaction` | `{ emoji }` | Send a floating reaction |
| `host:kick` | `{ targetId }` | Kick a user (host only) |
| `host:force-resync` | `{}` | Force all clients to hard seek (host only) |
| `pong` | `{ serverTime }` | Response to server ping for latency measurement |

### Server -> Client Messages

| Type | Payload | Description |
|------|---------|-------------|
| `room:state` | `{ room, participants, playbackState, chatHistory }` | Full state on join |
| `room:participant-joined` | `{ participant }` | New user joined |
| `room:participant-left` | `{ participantId }` | User left or disconnected |
| `playback:update` | `{ isPlaying, position, timestamp }` | Playback state changed |
| `playback:force-resync` | `{ position }` | Hard seek command from host |
| `sync:adjust` | `{ drift, suggestedRate }` | Server-computed drift correction hint |
| `chat:new-message` | `{ message }` | New chat message |
| `chat:new-reaction` | `{ emoji, senderName }` | New floating reaction |
| `host:dashboard` | `{ participants[] with latency, drift }` | Dashboard data update |
| `ping` | `{ serverTime }` | Latency measurement ping |
| `error` | `{ code, message }` | Error (room full, kicked, invalid) |
| `kicked` | `{ reason }` | You have been kicked |

---

## Sync Engine Design

### Authoritative Clock

The server maintains the authoritative playback state for each room:

```
currentPosition = lastKnownPosition + (isPlaying ? (now - lastUpdated) / 1000 : 0)
```

This virtual clock ticks forward when playing and holds still when paused. The server never actually plays the video; it just tracks where playback *should* be.

### Drift Detection and Correction

1. Every 2 seconds, each client sends a `heartbeat` with its current playback position.
2. The server computes `drift = clientPosition - authoritativePosition`.
3. If `|drift| > 3.0 seconds`:
   - Server sends `sync:adjust` with a `suggestedRate`:
     - Client is behind: `suggestedRate = 1.1` to `1.2`
     - Client is ahead: `suggestedRate = 0.8` to `0.9`
   - Rate scales linearly with drift magnitude (capped at 0.8 - 1.2 range).
4. If `|drift| <= 0.5 seconds`: server sends `sync:adjust` with `suggestedRate = 1.0` (normal).
5. If client reports `isBuffering = true`, drift is not penalized.

### Playback Commands

When any participant issues a playback command:

1. Server updates the authoritative `PlaybackState`.
2. Server broadcasts `playback:update` to all participants in the room (and linked room if applicable).
3. All clients apply the new state immediately (hard seek for seek commands, play/pause for toggle).

### Late Joiner Sync

When a client sends `join`:

1. Server responds with `room:state` including the current `playbackState`.
2. Client computes `targetPosition = state.position + (now - state.timestamp) / 1000` and seeks to it.
3. Normal drift correction takes over from there.

---

## Multi-Room Linking

### Architecture

Linked rooms are two independent `Room` objects that reference each other via `linkedRoomId`. They share playback commands but maintain independent sync engines.

### Command Propagation

When a playback command (play/pause/seek) is issued in Room A:

1. Room A processes the command normally.
2. Room A checks `linkedRoomId`. If set, propagates the same command to Room B.
3. Room B processes the command independently (updates its own authoritative clock).
4. Each room's participants receive `playback:update` from their own room.

### Drift Independence

Each room's sync engine runs independently. Room A participants sync to Room A's clock; Room B participants sync to Room B's clock. There is no cross-room drift correction.

---

## Video Delivery

### HLS from Cloudflare R2

```
R2 Bucket Structure:
  /videos/
    movie-title/
      master.m3u8          # Master playlist (multiple quality levels)
      720p/
        stream.m3u8        # Quality-specific playlist
        segment-001.ts     # 4-second segments
        segment-002.ts
        ...
      1080p/
        stream.m3u8
        segment-001.ts
        ...
```

The server does not proxy video segments. Instead:
- The `VideoSource.url` points directly to the R2-hosted `.m3u8` manifest.
- Clients fetch segments directly from R2 (public bucket or presigned URLs).
- The server only manages sync state and control messages.

### hls.js Configuration

```typescript
const hlsConfig = {
  maxBufferLength: 30,           // Buffer 30s ahead
  maxMaxBufferLength: 60,        // Max buffer cap
  liveSyncDurationCount: 3,      // For live-like behavior
  enableWorker: true,            // Offload parsing to Web Worker
  lowLatencyMode: false,         // Not needed for VOD
};
```

### Embedded Player (YouTube/Vimeo)

For embedded sources, the client uses:
- YouTube: `YT.Player` iframe API with `playVideo()`, `pauseVideo()`, `seekTo()`, `getCurrentTime()`.
- Vimeo: `@vimeo/player` SDK with `play()`, `pause()`, `setCurrentTime()`, `getCurrentTime()`.

Detection: The server validates the URL format and sets `VideoSource.type` accordingly. The client renders the appropriate player component.

---

## Chat and Reactions

### Chat Architecture

- Messages are broadcast via WebSocket to all room participants.
- Rate limiting: max 5 messages per second per user (sliding window). Excess messages receive an `error` response.
- Chat history is stored in-memory per room (last 200 messages). Sent to late joiners on `room:state`.

### Reaction Architecture

- Reactions are fire-and-forget broadcasts. No history is stored.
- Predefined emoji set: A curated list of ~20 commonly used reaction emojis.
- Client renders reactions as CSS-animated floating elements that rise and fade over 2-3 seconds.
- Each reaction is assigned a random horizontal offset to avoid stacking.

---

## Connection Management

### Heartbeat Protocol

```
Server --[ping {serverTime}]--> Client
Client --[pong {serverTime}]--> Server   (echo back serverTime)

Latency = (now - serverTime) / 2   (approximate one-way)
```

- Server sends `ping` every 5 seconds.
- Client must respond with `pong` within 5 seconds.
- 3 missed pongs = client marked as disconnected and removed from room.

### Reconnection Flow

1. Client detects WebSocket close/error.
2. UI shows "Reconnecting..." status.
3. Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max).
4. On reconnect, client sends `join` with the same room code and display name.
5. Server recognizes the display name (within the grace period) and restores the participant.
6. Server sends full `room:state` to resync the client.

### Grace Period

When a participant disconnects:
- Their slot is held for 60 seconds.
- If they rejoin within 60 seconds, they reclaim their slot.
- After 60 seconds, they are fully removed and must rejoin as a new participant (if slots available).
- When ALL participants disconnect, the room enters a 5-minute cleanup timer.

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/rooms` | Create a new room. Body: `{ videoSource, linkedVideoSource? }`. Returns: `{ roomCode, linkedRoomCode? }` |
| `GET` | `/api/rooms/:code` | Get room info (participant count, video source type). Used for join page preview. |
| `GET` | `/api/health` | Health check. Returns `{ status: "ok", uptime, roomCount }` |

---

## Frontend Routing

The frontend is a single-page app with hash-based routing:

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `RoomJoin` | Create or join a room |
| `/room/:code` | Main room view | Player + Chat + Reactions |
| `/room/:code/dashboard` | `Dashboard` | Host dashboard (only accessible to host) |

---

## Build and Development

### Project Structure

```
tether/
  package.json
  bunfig.toml              # Bun configuration
  .env.example             # Environment variable template
  src/                     # Backend source
    server.ts
    routes/
    ws/
    rooms/
    sync/
    chat/
    utils/
  client/                  # Frontend source
    index.html
    src/
      index.tsx
      App.tsx
      components/
      lib/
      stores/
    vite.config.ts         # Vite for frontend build (Bun-compatible)
  dist/                    # Built frontend (served by Bun in prod)
  tests/                   # Test files
    sync.test.ts
    rooms.test.ts
    ws.test.ts
```

### Build Pipeline

- **Development**: `bun run dev` starts the backend with `--watch` and Vite dev server with HMR for the frontend (proxy API requests to Bun).
- **Production build**: `bun run build` runs Vite to produce `dist/` and the Bun server serves those static files.
- **Start**: `bun run start` runs `src/server.ts` which serves both API and static files from `dist/`.

### Environment Variables

```env
PORT=3000
R2_BUCKET_URL=https://your-bucket.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-key
R2_SECRET_ACCESS_KEY=your-secret
ROOM_MAX_PARTICIPANTS=3
HEARTBEAT_INTERVAL_MS=5000
DRIFT_THRESHOLD_SECONDS=3
CLEANUP_GRACE_PERIOD_MS=300000
```

---

## Error Handling

| Error Code | Meaning | Client Action |
|------------|---------|---------------|
| `ROOM_NOT_FOUND` | Room code doesn't exist | Show error, redirect to join page |
| `ROOM_FULL` | Room at max capacity | Show "room full" message |
| `KICKED` | Host kicked you | Show kicked message, disable rejoin |
| `INVALID_MESSAGE` | Malformed WS message | Log and ignore |
| `RATE_LIMITED` | Too many chat messages | Show throttle warning in UI |
| `SOURCE_UNAVAILABLE` | Video source can't load | Show error with instructions |
