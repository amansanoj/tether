# Tether

A personal watch-party server with sub-second synchronized playback, live chat, and a host dashboard. Built with [Bun](https://bun.sh) for both the backend runtime and frontend bundler.

## Features

- **Synchronized Playback** - All participants stay in sync with drift detection and automatic rate adjustment
- **Multi-Room Support** - Create linked rooms with different video sources that share the same playback timeline
- **Host Dashboard** - Real-time view of participant latency, drift, and buffering status with kick and force-resync controls
- **Live Chat** - In-room messaging with rate limiting and emoji reactions
- **Reconnection Handling** - 60-second slot hold preserves your seat if you disconnect
- **Embedded Player** - HLS, YouTube, and Vimeo source support via embedded player

## Prerequisites

- [Bun](https://bun.sh) v1.0 or later

## Setup

```bash
# Install dependencies
bun install

# Copy environment config
cp .env.example .env

# Build the frontend
bun run build

# Start the server
bun run start
```

The server starts on port 3000 by default (configurable via `PORT` in `.env`).

## Development

```bash
# Run in watch mode (auto-restarts on changes)
bun run dev

# Run all tests
bun test
```

## Configuration

All configuration is done via environment variables. See `.env.example` for the full list:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server listen port |
| `ROOM_MAX_PARTICIPANTS` | `3` | Maximum participants per room |
| `HEARTBEAT_INTERVAL_MS` | `5000` | Ping interval for connection liveness |
| `DRIFT_THRESHOLD_SECONDS` | `3` | Drift threshold before rate adjustment |
| `CLEANUP_GRACE_PERIOD_MS` | `300000` | How long an empty room survives (5 min) |

### R2 Bucket Configuration

If you want to serve HLS video segments from Cloudflare R2:

1. Create an R2 bucket in your Cloudflare dashboard
2. Generate an API token with R2 read access
3. Set the following in your `.env`:

```
R2_BUCKET_URL=https://your-bucket.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-key
R2_SECRET_ACCESS_KEY=your-secret
```

4. Upload your `.m3u8` manifest and `.ts` segments to the bucket
5. Use the R2 public URL as the `videoSource.url` when creating a room

### Cloudflare Tunnel Setup

To expose your local Tether instance publicly (for friends to join):

1. Install `cloudflared`: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/
2. Create a tunnel:
   ```bash
   cloudflared tunnel create tether
   ```
3. Configure the tunnel to route to your local server:
   ```bash
   cloudflared tunnel route dns tether your-subdomain.your-domain.com
   ```
4. Run the tunnel:
   ```bash
   cloudflared tunnel run --url http://localhost:3000 tether
   ```

Participants can then connect via `https://your-subdomain.your-domain.com`.

## Usage

### Creating a Room

Send a POST request to create a watch room:

```bash
curl -X POST http://localhost:3000/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "videoSource": {
      "type": "hls",
      "url": "https://your-bucket.example.com/movie/manifest.m3u8"
    }
  }'
```

Response:
```json
{ "roomCode": "ABC123" }
```

To create linked rooms (two video sources synced together):

```bash
curl -X POST http://localhost:3000/api/rooms \
  -H "Content-Type: application/json" \
  -d '{
    "videoSource": { "type": "hls", "url": "https://example.com/video1.m3u8" },
    "linkedVideoSource": { "type": "youtube", "url": "https://youtube.com/watch?v=xyz" }
  }'
```

### Joining a Room

Open your browser to `http://localhost:3000` and enter the room code and your display name. Share the room code with friends so they can join the same session.

### Controls

- **Play/Pause** - Any participant can control playback; all viewers stay in sync
- **Seek** - Scrubbing the timeline seeks for everyone
- **Chat** - Send messages and emoji reactions visible to all participants
- **Host Dashboard** - The first person to join becomes the host, with access to:
  - Participant latency and drift stats
  - Kick button to remove disruptive viewers
  - Force Resync to hard-seek all participants to the authoritative position

## Architecture

```
tether/
  src/
    server.ts          - HTTP server, static file serving, WebSocket upgrade
    routes/api.ts      - REST API (POST /api/rooms, GET /api/rooms/:code)
    rooms/
      room.ts          - Room data model (participants, playback state, chat)
      manager.ts       - Room lifecycle, slot holds, grace period cleanup
    ws/
      protocol.ts      - Message type definitions, parsing, serialization
      handler.ts       - WebSocket open/close/message, connection registry
      router.ts        - Routes messages by type prefix to handlers
    sync/
      engine.ts        - Authoritative clock, drift detection, rate adjustment
      commands.ts      - Play/pause/seek handlers with linked room propagation
    host/
      commands.ts      - Host validation, kick, force-resync, dashboard broadcast
    chat/
      broker.ts        - Chat message handling with rate limiting and history
      reactions.ts     - Ephemeral emoji reaction broadcast
  client/
    src/
      index.ts         - Entry point
      App.ts           - Main application component
      components/      - UI components (Player, Chat, Dashboard, etc.)
      lib/             - WebSocket client, sync logic
      stores/          - Application state management
  tests/
    rooms.test.ts      - Room model and manager tests
    ws.test.ts         - Protocol parsing, routing, connection lifecycle
    sync.test.ts       - Sync engine, drift detection, rate adjustment
    host.test.ts       - Host commands, dashboard, kick
    chat.test.ts       - Chat messaging, rate limiting, reactions
    integration.test.ts - End-to-end flow tests
```

### Protocol

Communication uses JSON over WebSocket. Client messages include `join`, `playback:play`, `playback:pause`, `playback:seek`, `heartbeat`, `chat:message`, `chat:reaction`, `host:kick`, `host:force-resync`, and `pong`.

Server messages include `room:state`, `room:participant-joined`, `room:participant-left`, `playback:update`, `playback:force-resync`, `sync:adjust`, `chat:new-message`, `chat:new-reaction`, `host:dashboard`, `ping`, `error`, and `kicked`.

### Sync Algorithm

1. Server maintains the authoritative playback clock per room
2. Clients send periodic `heartbeat` messages with their current position
3. Server computes drift (client position minus server position)
4. If drift exceeds the threshold, server sends `sync:adjust` with a suggested playback rate
5. Client adjusts its HTML5 media playbackRate to gradually converge
6. Once drift falls below 0.5s, rate resets to 1.0

## License

MIT
