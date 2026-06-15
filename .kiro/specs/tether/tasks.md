# Tether - Implementation Tasks

## Task Overview

Tasks are ordered by dependency. Each task produces a working increment that can be tested independently. Later tasks build on earlier ones.

---

## Task 1: Project Scaffolding and Server Skeleton

**Scope:** Initialize the project structure, configure Bun, set up the build pipeline, and create a minimal HTTP server.

**Steps:**

1. Initialize `package.json` with Bun as the runtime. Add dependencies:
   - `hls.js` (frontend HLS playback)
   - `solid-js` and `solid-js/web` (frontend framework)
   - `vite` and `vite-plugin-solid` (frontend build)
   - No backend dependencies beyond Bun's built-in APIs
2. Create `bunfig.toml` with any needed Bun configuration.
3. Create `.env.example` with all environment variables documented.
4. Create the directory structure:
   - `src/` for backend
   - `client/` for frontend
   - `tests/` for test files
5. Implement `src/server.ts`:
   - Bun HTTP server listening on `PORT`
   - Serve static files from `dist/` directory
   - Route `/api/health` returns `{ status: "ok", uptime, roomCount: 0 }`
   - WebSocket upgrade handling (stub, no logic yet)
6. Create `client/index.html` as the SPA shell.
7. Create `client/vite.config.ts` with Solid.js plugin and proxy config for dev mode.
8. Add `package.json` scripts:
   - `dev`: Start Vite dev server + Bun backend with watch
   - `build`: Vite production build
   - `start`: Run production server
9. Verify: `bun run build` succeeds, `bun run start` serves the health endpoint.

**Acceptance Criteria:**
- `bun install` resolves all dependencies
- `bun run build` produces `dist/index.html`
- `bun run start` starts a server; `GET /api/health` returns 200 with JSON body
- Frontend loads in browser (even if blank)

---

## Task 2: Room Management and REST API

**Scope:** Implement room creation, lookup, lifecycle management, and the REST API.

**Steps:**

1. Implement `src/utils/id.ts`:
   - `generateRoomCode()`: produces a 6-character alphanumeric string (A-Z, 0-9)
   - Collision check against active rooms
2. Implement `src/rooms/room.ts`:
   - `Room` class/interface matching the data model in design.md
   - Methods: `addParticipant()`, `removeParticipant()`, `getParticipantCount()`
   - Playback state initialization
3. Implement `src/rooms/manager.ts`:
   - In-memory `Map<string, Room>` storage
   - `createRoom(videoSource, linkedVideoSource?)`: creates one or two linked rooms
   - `getRoom(code)`: lookup by code
   - `deleteRoom(code)`: cleanup
   - Grace period timer: 5 minutes after last participant leaves, delete the room
   - Participant slot hold: 60 seconds for reconnection
4. Implement `src/routes/api.ts`:
   - `POST /api/rooms`: Validates body, calls `createRoom()`, returns room code(s)
   - `GET /api/rooms/:code`: Returns participant count, video source type, room status
5. Wire API routes into `src/server.ts`.
6. Write tests in `tests/rooms.test.ts`:
   - Room creation and code generation
   - Max participants enforcement
   - Grace period timer behavior
   - Linked room creation

**Acceptance Criteria:**
- `POST /api/rooms` with `{ "videoSource": { "type": "hls", "url": "..." } }` returns a 6-char room code
- `GET /api/rooms/:code` returns room info for valid codes, 404 for invalid
- Room codes are unique across concurrent rooms
- Max participant limit is enforced
- `bun test tests/rooms.test.ts` passes

---

## Task 3: WebSocket Infrastructure and Protocol

**Scope:** Implement the WebSocket connection lifecycle, message protocol, and basic routing.

**Steps:**

1. Implement `src/ws/protocol.ts`:
   - Define TypeScript types for all client-to-server and server-to-client message types (as specified in design.md)
   - `parseMessage(raw: string)`: validates and parses incoming JSON messages
   - `serializeMessage(msg)`: serializes outgoing messages
   - Validation: reject messages with missing/invalid `type` field
2. Implement `src/ws/handler.ts`:
   - WebSocket upgrade handling integrated with Bun's server
   - Connection lifecycle: open, message, close, error
   - Associate connections with a unique `connectionId`
   - Handle `join` message: validate room code, add participant to room, send `room:state`
   - Handle disconnect: start 60-second slot hold, mark participant as disconnected
3. Implement `src/ws/router.ts`:
   - Route incoming messages by `type` prefix to appropriate handlers
   - `playback:*` -> sync handlers (Task 4)
   - `chat:*` -> chat handlers (Task 6)
   - `host:*` -> host handlers (Task 5)
   - Unknown types -> send `error` message back
4. Implement ping/pong heartbeat:
   - Server sends `ping` with `serverTime` every 5 seconds per connection
   - Track `pong` responses; compute latency
   - Mark connection as dead after 3 missed pongs (15 seconds)
5. Wire WebSocket handling into `src/server.ts`.
6. Write tests in `tests/ws.test.ts`:
   - Message parsing and validation
   - Connection lifecycle (join, disconnect)
   - Heartbeat timeout detection

**Acceptance Criteria:**
- Client can establish WebSocket connection to the server
- Sending a valid `join` message returns `room:state` with current room data
- Invalid messages receive an `error` response
- Connections are cleaned up after heartbeat timeout
- `bun test tests/ws.test.ts` passes

---

## Task 4: Sync Engine

**Scope:** Implement the authoritative playback clock, drift detection, and rate-adjustment sync protocol.

**Steps:**

1. Implement `src/sync/engine.ts`:
   - `SyncEngine` class per room
   - `getCurrentPosition()`: computes real-time authoritative position using `position + (now - lastUpdated)` when playing
   - `processHeartbeat(connectionId, reportedPosition, isBuffering)`:
     - Compute drift: `reportedPosition - getCurrentPosition()`
     - If `|drift| > 3.0s` and not buffering: compute suggested rate (linear scale 0.8 - 1.2)
     - If `|drift| <= 0.5s`: suggest rate 1.0
     - Between 0.5 and 3.0: no adjustment (dead zone)
     - Send `sync:adjust` to the specific client
   - `updateParticipantState()`: update the participant's drift and latency values
2. Implement `src/sync/commands.ts`:
   - `handlePlay(room)`: set `isPlaying = true`, update `lastUpdated`, broadcast `playback:update`
   - `handlePause(room)`: set `isPlaying = false`, snapshot current position, broadcast
   - `handleSeek(room, position)`: set new position, broadcast
   - For linked rooms: propagate command to linked room after processing
3. Implement late-joiner logic:
   - On `join`, compute current position and include in `room:state`
   - Client calculates additional offset from message transit time
4. Write tests in `tests/sync.test.ts`:
   - Authoritative clock computation
   - Drift detection thresholds (below 0.5, between 0.5-3.0, above 3.0)
   - Rate suggestion calculation
   - Play/pause/seek command processing
   - Buffering exemption from drift penalty
   - Linked room command propagation

**Acceptance Criteria:**
- Authoritative clock correctly tracks position over time
- Drift > 3s triggers rate adjustment message
- Drift < 0.5s resets rate to 1.0
- Buffering clients are not penalized
- Play/pause/seek commands propagate to linked rooms
- `bun test tests/sync.test.ts` passes

---

## Task 5: Host Dashboard and Controls

**Scope:** Implement host-specific functionality: dashboard data, force-resync, and kick.

**Steps:**

1. Implement host validation in message handlers:
   - Check `connectionId === room.hostId` for `host:*` messages
   - Return `error` with code `UNAUTHORIZED` if non-host sends host commands
2. Implement `host:force-resync` handler:
   - Compute current authoritative position
   - Broadcast `playback:force-resync` with the position to ALL participants
   - Clients must hard-seek (not rate-adjust) to this position
3. Implement `host:kick` handler:
   - Validate target participant exists in room
   - Mark participant as `isKicked = true`
   - Send `kicked` message to target with reason
   - Close target's WebSocket connection
   - On rejoin attempts, check `isKicked` flag and reject with `KICKED` error
4. Implement dashboard data broadcast:
   - Every 2 seconds, send `host:dashboard` to the host connection
   - Payload: array of participants with `{ id, displayName, latency, drift, isBuffering }`
5. Wire host commands into the WebSocket router.
6. Write tests:
   - Non-host cannot send host commands
   - Force-resync broadcasts to all participants
   - Kicked user cannot rejoin
   - Dashboard data includes accurate latency/drift

**Acceptance Criteria:**
- Only the host can issue `host:*` commands
- Force-resync causes all clients to receive hard-seek instruction
- Kicked users receive a `kicked` message and cannot rejoin the same room
- Dashboard data refreshes every 2 seconds with current participant stats
- Tests pass

---

## Task 6: Chat and Reactions

**Scope:** Implement real-time text chat with rate limiting and floating emoji reactions.

**Steps:**

1. Implement `src/chat/broker.ts`:
   - `handleChatMessage(room, senderId, content)`:
     - Rate limit check: sliding window, max 5 messages per second per user
     - If rate limited: send `error` with code `RATE_LIMITED`
     - Create `ChatMessage` object with generated ID, sender name, timestamp
     - Append to room's `chatHistory` (cap at 200 messages, FIFO)
     - Broadcast `chat:new-message` to all room participants
2. Implement `src/chat/reactions.ts`:
   - `handleReaction(room, senderId, emoji)`:
     - Validate emoji is from allowed set (or any single emoji character)
     - Broadcast `chat:new-reaction` with emoji and sender name to all participants
     - No history storage for reactions
3. Define the predefined emoji set (in a constants file):
   - Common reactions: heart, laughing, fire, clap, cry, shocked, thumbs up, etc.
   - ~20 emojis total
4. Wire chat handlers into the WebSocket router.
5. Write tests:
   - Message broadcasting to all participants
   - Rate limiting (6th message in 1 second is rejected)
   - Chat history capped at 200 messages
   - Late joiner receives chat history in `room:state`
   - Reaction broadcasting (no history)

**Acceptance Criteria:**
- Chat messages are broadcast to all room participants
- Rate limiting blocks excessive messages with appropriate error
- Chat history is included in `room:state` for late joiners (capped at 200)
- Reactions broadcast to all but are not stored
- Tests pass

---

## Task 7: Frontend - Room Join and Core Layout

**Scope:** Build the frontend shell: room creation/join flow, routing, and the main room layout.

**Steps:**

1. Implement `client/src/index.tsx`:
   - Solid.js app entry, mount to `#app` in `index.html`
   - Simple hash-based router (no library needed for 3 routes)
2. Implement `client/src/stores/room.ts`:
   - Solid.js `createStore` for room state: participants, playback state, video source
   - Actions: join room, leave room, update state from server messages
3. Implement `client/src/stores/connection.ts`:
   - Connection status: `connected`, `reconnecting`, `disconnected`
   - Expose reactive status for UI components
4. Implement `client/src/components/RoomJoin.tsx`:
   - Form with two modes: "Create Room" and "Join Room"
   - Create: video source URL input (HLS URL, YouTube URL, or Vimeo URL), optional linked source URL, submit calls `POST /api/rooms`
   - Join: room code input + display name input
   - On success: navigate to `/room/:code`
5. Implement `client/src/App.tsx`:
   - Route handling: parse hash, render appropriate component
   - Main room view layout: video player (large), chat sidebar, reaction overlay, status bar
6. Implement `client/src/components/StatusBar.tsx`:
   - Shows connection status with colored indicator (green/yellow/red)
   - Shows participant count
7. Apply minimal CSS styling:
   - Dark theme suitable for movie watching
   - Responsive layout (video takes primary space)
   - Chat sidebar (right side, collapsible on mobile)

**Acceptance Criteria:**
- App loads at `/` with the room join form
- Creating a room via the form calls the API and navigates to the room view
- Joining with a room code navigates to the room view
- Status bar shows connection state
- Layout is visually functional (dark theme, video area + chat sidebar)

---

## Task 8: Frontend - Video Player and Sync Client

**Scope:** Implement the HLS video player with client-side sync logic and embedded player support.

**Steps:**

1. Implement `client/src/lib/hls.ts`:
   - Wrapper around hls.js: initialize, attach to video element, handle errors
   - Configure with buffer settings from design.md
   - Handle `Hls.Events.ERROR` for recovery
2. Implement `client/src/lib/sync.ts`:
   - Client-side sync logic:
     - Listen for `playback:update`: apply play/pause/seek
     - Listen for `sync:adjust`: set `video.playbackRate` to suggested rate
     - Listen for `playback:force-resync`: hard seek to position
     - Send `heartbeat` every 2 seconds with current position and buffering state
   - Buffering detection: listen to video element's `waiting` and `playing` events
3. Implement `client/src/components/Player.tsx`:
   - Solid.js component wrapping a `<video>` element
   - Initialize hls.js with the room's video source URL
   - Playback controls: play/pause button, seek bar, volume
   - On user interaction (play/pause/seek): send corresponding WebSocket message
   - Apply sync adjustments from the sync library
   - Show buffering indicator
4. Implement `client/src/components/EmbeddedPlayer.tsx`:
   - Detect source type from `videoSource.type`
   - YouTube: load iframe API, create `YT.Player`, expose play/pause/seek/getCurrentTime
   - Vimeo: load Vimeo Player SDK, create player, expose same interface
   - Same sync protocol: heartbeat reports position, commands apply via API
5. Implement `client/src/lib/ws.ts`:
   - WebSocket client class:
     - Connect to server, handle open/close/error
     - Exponential backoff reconnection (1s, 2s, 4s, 8s, 16s, 30s max)
     - Message send/receive with JSON serialization
     - Respond to `ping` with `pong` (echo `serverTime`)
     - Event emitter pattern for incoming message types
   - Integration with stores: update room/connection stores on messages

**Acceptance Criteria:**
- HLS video plays from an R2-hosted manifest URL
- Client sends heartbeat every 2 seconds
- Rate adjustment from server changes playback speed
- Force-resync causes immediate seek
- Play/pause/seek controls send messages to server
- WebSocket reconnects with backoff on disconnect
- Embedded player works for YouTube/Vimeo URLs (when embeddable)

---

## Task 9: Frontend - Chat, Reactions, and Dashboard

**Scope:** Implement the chat UI, floating emoji reactions, and host dashboard components.

**Steps:**

1. Implement `client/src/stores/chat.ts`:
   - Store for chat messages (populated from `room:state` and `chat:new-message`)
   - Add message action, scroll-to-bottom trigger
2. Implement `client/src/components/Chat.tsx`:
   - Message list with auto-scroll to newest
   - Input field with enter-to-send
   - Display sender name and relative timestamp
   - Show rate-limit warning if server returns `RATE_LIMITED` error
   - Emoji picker button (shows predefined emoji grid)
3. Implement `client/src/components/Reactions.tsx`:
   - Full-screen overlay layer (pointer-events: none)
   - On `chat:new-reaction`: spawn a floating emoji element
   - CSS animation: rise from bottom, random X offset, fade out over 2-3 seconds
   - Clean up DOM elements after animation completes
4. Implement `client/src/components/Dashboard.tsx`:
   - Only visible to host (check against host ID in room state)
   - Table/list of participants: name, latency (ms), drift (seconds), buffering status
   - "Force Resync" button: sends `host:force-resync`
   - "Kick" button per participant: sends `host:kick` with target ID
   - Updates every 2 seconds from `host:dashboard` messages
5. Style all components consistent with the dark theme.

**Acceptance Criteria:**
- Chat messages appear in real-time for all participants
- Emoji reactions float upward and disappear after 2-3 seconds
- Dashboard shows participant latency and drift (host only)
- Force-resync and kick buttons work from the dashboard
- UI is visually polished with dark theme

---

## Task 10: Integration Testing and Polish

**Scope:** End-to-end verification, edge case handling, and final polish.

**Steps:**

1. Create integration test scenario in `tests/integration.test.ts`:
   - Simulate full flow: create room, two clients join, play/pause/seek, verify sync
   - Test reconnection: disconnect client, verify slot hold, reconnect, verify resync
   - Test chat: send messages, verify delivery and rate limiting
   - Test host controls: kick, force-resync
   - Test multi-room: create linked rooms, verify command propagation
2. Handle edge cases:
   - Room code in URL that doesn't exist: show friendly error
   - WebSocket fails to connect initially: show error with retry button
   - Video source fails to load: show error with HLS error details
   - Browser tab becomes inactive: handle visibility change (don't drift-penalize background tabs)
3. Add graceful shutdown to server:
   - On SIGINT/SIGTERM: close all WebSocket connections with a close frame
   - Log active rooms and participants on shutdown
4. Create production-ready `.env.example` and update README.md with:
   - Setup instructions
   - R2 bucket configuration
   - Cloudflare Tunnel setup
   - Usage guide
5. Final verification:
   - `bun run build` produces optimized frontend bundle
   - `bun run start` serves the complete application
   - `bun test` runs all test suites

**Acceptance Criteria:**
- Integration tests simulate multi-client sync scenarios and pass
- Edge cases are handled with user-friendly error messages
- Server shuts down gracefully
- README documents setup and usage
- Full `bun test` suite passes
- Production build works end-to-end

---

## Dependency Graph

```
Task 1 (Scaffolding)
  |
  +---> Task 2 (Rooms) --+
  |                       |
  +---> Task 3 (WebSocket) --+--> Task 4 (Sync) --+--> Task 5 (Host Dashboard)
                              |                    |
                              +--> Task 6 (Chat)   |
                                                   |
Task 7 (Frontend Shell) -+                        |
                          +--> Task 8 (Player/Sync Client)
                          |
                          +--> Task 9 (Chat/Reactions/Dashboard)
                                        |
                                        v
                              Task 10 (Integration & Polish)
```

Tasks 2 and 3 can be developed in parallel after Task 1.
Tasks 5 and 6 can be developed in parallel after Tasks 3 and 4.
Tasks 7 can start after Task 1 (frontend only, stubs for backend).
Tasks 8 and 9 require their backend counterparts (4, 5, 6) plus Task 7.
Task 10 requires all other tasks.
