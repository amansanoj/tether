# Tether - Requirements

## Overview

Tether is a personal watch-party server designed for 2-3 people. The host serves video files from Cloudflare R2 via HLS chunked streaming. All participants watch in sync via a web UI with real-time chat and floating emoji reactions.

---

## User Stories

### US-1: Synced Playback

**As a** watch-party participant,
**I want** everyone in the room to see the same video frame at the same time,
**so that** we share a synchronized viewing experience.

#### Acceptance Criteria

- AC-1.1: Any participant in the room can play, pause, or seek the video. The action is reflected on all connected clients within 1 second of propagation.
- AC-1.2: If a client's playback position drifts more than 3 seconds from the authoritative server timestamp, the client's playback rate adjusts (speed up or slow down) to catch up gradually rather than performing a hard seek.
- AC-1.3: When a user joins an active room, their player starts at the current authoritative playback position (not from the beginning).
- AC-1.4: A periodic heartbeat (every 2 seconds) reports each client's playback position to the server for drift detection.
- AC-1.5: Rate adjustment uses a factor between 0.8x and 1.2x to converge on the target timestamp without jarring the viewer.

---

### US-2: Multi-Room Support

**As a** host,
**I want** to run concurrent rooms linked together (e.g., Hindi + Malayalam audio for the same movie),
**so that** different language viewers stay roughly in sync across rooms.

#### Acceptance Criteria

- AC-2.1: A host can create a linked pair of rooms, each with a different HLS source URL.
- AC-2.2: Either party (in either linked room) can issue playback controls (play/pause/seek) that affect both linked rooms.
- AC-2.3: Rooms start playback together when triggered by any participant in either linked room.
- AC-2.4: Independent drift between linked rooms is acceptable (each room syncs internally but not across rooms frame-perfectly).
- AC-2.5: Single-room mode works when only one video source is provided (no linking required).

---

### US-3: Host Dashboard (Web Control Center)

**As a** room host,
**I want** a dashboard showing connected users with their latency and drift,
**so that** I can monitor the health of the session and take corrective action.

#### Acceptance Criteria

- AC-3.1: The room creator is automatically designated as host.
- AC-3.2: The dashboard displays a list of all connected users with their display name, current latency (round-trip WebSocket), and playback drift from the authoritative timestamp.
- AC-3.3: The host can click a "Force Resync" button that issues a hard seek command to all clients, snapping them to the current authoritative position.
- AC-3.4: The host can kick a user, which disconnects their WebSocket and prevents immediate rejoin (soft ban for the session duration).
- AC-3.5: Latency and drift values update in real-time (at least every 2 seconds).

---

### US-4: Chat and Reactions

**As a** participant,
**I want** to send text messages and emoji reactions during the watch party,
**so that** we can communicate and react together in real time.

#### Acceptance Criteria

- AC-4.1: Text chat messages sent by any participant appear for all participants in the same room within 500ms.
- AC-4.2: Chat messages display the sender's display name and a timestamp.
- AC-4.3: Emoji reactions (selected from a predefined set or typed) appear as floating animations visible to all participants in real-time (Instagram Live / Twitch style).
- AC-4.4: Reactions float upward and fade out over 2-3 seconds.
- AC-4.5: Chat history persists for the duration of the room session (not persisted after room closes).

---

### US-5: Room Management

**As a** user,
**I want** to join a room anonymously using a room code or shareable link,
**so that** I can participate without creating an account.

#### Acceptance Criteria

- AC-5.1: A host can create a room and receives a unique 6-character alphanumeric room code.
- AC-5.2: A shareable link in the format `https://<host>/room/<code>` allows one-click joining.
- AC-5.3: Joining requires only a display name (no auth, no signup).
- AC-5.4: A room supports a maximum of 3 concurrent participants (including the host). Additional join attempts receive a "room full" error.
- AC-5.5: When all participants disconnect, the room is cleaned up after a 5-minute grace period.

---

### US-6: Embedded Source Support

**As a** host,
**I want** to optionally use YouTube or Vimeo URLs as video sources if browser embedding works without extensions,
**so that** I can avoid uploading every video to R2.

#### Acceptance Criteria

- AC-6.1: If a provided URL is a YouTube or Vimeo link and the platform allows iframe embedding for that video, the player uses the embedded iframe player with the platform's JS API for playback control.
- AC-6.2: If embedding is blocked (X-Frame-Options, embed restrictions), the system falls back gracefully with a clear error message instructing the user to use an R2-hosted HLS source.
- AC-6.3: Sync controls (play/pause/seek) work the same way for embedded sources as for HLS sources, using the platform's player API.
- AC-6.4: R2-hosted HLS is the primary and default source type; embedded support is a secondary option.

---

### US-7: Network Resilience

**As a** participant on a poor network,
**I want** the app to handle disconnects gracefully and resume without losing my place,
**so that** I can rejoin seamlessly after a network interruption.

#### Acceptance Criteria

- AC-7.1: WebSocket connections include a heartbeat (ping/pong every 5 seconds). If 3 consecutive heartbeats are missed, the client is marked as disconnected.
- AC-7.2: On disconnect, the client attempts exponential backoff reconnection (1s, 2s, 4s, 8s, max 30s).
- AC-7.3: On successful reconnect, the client receives the current authoritative playback state and resyncs automatically.
- AC-7.4: During rebuffering, the client reports its buffering state to the server. The server does not penalize drift during buffering.
- AC-7.5: The UI displays a visible connection status indicator (connected, reconnecting, disconnected).

---

## Non-Functional Requirements

### NFR-1: Performance

- Sub-3-second sync tolerance with rate adjustment (not hard seek) for drift correction.
- WebSocket message propagation under 100ms on local/LAN networks.
- Frontend bundle size under 200KB gzipped (Solid.js helps here).

### NFR-2: Scale

- Designed for 2-3 concurrent users per room. This is not a scaling problem.
- Single Bun process serves both the API (WebSocket + REST) and the static frontend assets.
- No database required; all state is in-memory for the lifetime of the process.

### NFR-3: Deployment

- Runs on a local machine exposed via Cloudflare Tunnel, or on a remote VPS.
- Single `bun run start` command to launch the server.
- Environment configuration via `.env` file (R2 credentials, tunnel config, port).

### NFR-4: Browser Support

- All modern browsers: Chrome, Firefox, Safari, Edge (latest 2 major versions).
- HLS playback via hls.js for browsers without native HLS support (all except Safari).

### NFR-5: Security

- No authentication required (trusted small group use case).
- Room codes are unguessable (6 alphanumeric characters = 2.1B combinations).
- WebSocket messages are validated server-side; malformed messages are dropped.
- Rate limiting on chat messages (max 5 messages per second per user).
