/**
 * App component.
 * Handles hash-based routing and renders the appropriate view.
 * When navigating to a room, connects WebSocket, initializes sync, and mounts the player.
 * Integrates chat, reactions overlay, and host dashboard.
 */

import { createRoomJoin } from "./components/RoomJoin";
import { createStatusBar } from "./components/StatusBar";
import { createPlayer } from "./components/Player";
import { createEmbeddedPlayer, isEmbeddedSource } from "./components/EmbeddedPlayer";
import { createChat } from "./components/Chat";
import { createReactions } from "./components/Reactions";
import { createDashboard } from "./components/Dashboard";
import { WsClient } from "./lib/ws";
import { SyncEngine } from "./lib/sync";
import { roomStore } from "./stores/room";
import { chatStore } from "./stores/chat";

interface Route {
  view: "home" | "room";
  roomCode?: string;
  params?: URLSearchParams;
}

function parseHash(): Route {
  const hash = window.location.hash.slice(1) || "/";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query || "");

  const roomMatch = path.match(/^\/room\/([A-Za-z0-9]{6})$/);
  if (roomMatch) {
    return { view: "room", roomCode: roomMatch[1].toUpperCase(), params };
  }

  return { view: "home" };
}

export function createApp(): HTMLElement {
  const container = document.createElement("div");
  container.className = "app";

  // Active room resources (cleaned up on navigation away)
  let activeWsClient: WsClient | null = null;
  let activeSyncEngine: SyncEngine | null = null;
  let activePlayerDestroy: (() => void) | null = null;
  let activeChatDestroy: (() => void) | null = null;
  let activeReactionsDestroy: (() => void) | null = null;
  let activeDashboardDestroy: (() => void) | null = null;

  function cleanupRoom(): void {
    if (activeSyncEngine) {
      activeSyncEngine.stop();
      activeSyncEngine = null;
    }
    if (activeWsClient) {
      activeWsClient.disconnect();
      activeWsClient = null;
    }
    if (activePlayerDestroy) {
      activePlayerDestroy();
      activePlayerDestroy = null;
    }
    if (activeChatDestroy) {
      activeChatDestroy();
      activeChatDestroy = null;
    }
    if (activeReactionsDestroy) {
      activeReactionsDestroy();
      activeReactionsDestroy = null;
    }
    if (activeDashboardDestroy) {
      activeDashboardDestroy();
      activeDashboardDestroy = null;
    }
    // Clear chat store on room leave
    chatStore.clear();
  }

  function renderRoute(): void {
    const route = parseHash();

    // Clean up previous room resources
    cleanupRoom();

    // Clear current content
    container.innerHTML = "";

    switch (route.view) {
      case "home":
        renderHome();
        break;
      case "room":
        renderRoom(route.roomCode!, route.params);
        break;
    }
  }

  function renderHome(): void {
    container.className = "app app--home";
    const joinComponent = createRoomJoin();
    container.appendChild(joinComponent);
  }

  function renderRoom(roomCode: string, params?: URLSearchParams): void {
    container.className = "app app--room";
    const displayName = params?.get("name") || "Guest";

    // Ensure room store is initialized for this room
    const currentState = roomStore.getState();
    if (!currentState || currentState.code !== roomCode) {
      roomStore.setState({
        code: roomCode,
        videoSource: null,
        linkedVideoSource: null,
        participants: [],
        isHost: false,
        displayName,
        playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
      });
    }

    // Room layout
    const layout = document.createElement("div");
    layout.className = "room-layout";

    // Video player area
    const videoArea = document.createElement("div");
    videoArea.className = "room-layout__video";

    // --- WebSocket connection ---
    const wsClient = new WsClient({ roomCode, displayName });
    activeWsClient = wsClient;

    // Create chat sidebar
    const chat = createChat({ wsClient, roomCode });
    activeChatDestroy = chat.destroy;

    // Chat sidebar wrapper
    const chatSidebar = document.createElement("div");
    chatSidebar.className = "room-layout__chat";
    chatSidebar.appendChild(chat.element);

    // Create reactions overlay
    const reactions = createReactions({ wsClient });
    activeReactionsDestroy = reactions.destroy;

    // Create dashboard
    const dashboard = createDashboard({ wsClient });
    activeDashboardDestroy = dashboard.destroy;

    // Status bar
    const statusBar = createStatusBar();

    // Assemble layout
    layout.appendChild(videoArea);
    layout.appendChild(chatSidebar);
    container.appendChild(layout);
    container.appendChild(reactions.element);
    container.appendChild(dashboard.element);
    container.appendChild(statusBar);

    // Variable to hold video element accessor
    let getVideoElement: () => HTMLVideoElement | null = () => null;

    // Initialize player once we receive room:state with video source
    wsClient.on("room:state", (msg) => {
      const state = roomStore.getState();
      const videoSource = msg.room?.videoSource || state?.videoSource;

      // Initialize chat history from room:state
      if (msg.chatHistory && Array.isArray(msg.chatHistory)) {
        chatStore.initialize(msg.chatHistory);
      }

      // Determine host status
      if (msg.room?.hostId && msg.connectionId) {
        const isHost = msg.connectionId === msg.room.hostId;
        roomStore.updateState({ isHost });
      }

      if (videoSource && videoSource.url) {
        // Clear the video area
        videoArea.innerHTML = "";

        const playbackState = msg.playbackState || {
          isPlaying: false,
          position: 0,
        };

        if (isEmbeddedSource(videoSource.url)) {
          // Use embedded player for YouTube/Vimeo
          const embedded = createEmbeddedPlayer({
            videoSource,
            wsClient,
            initialPlaying: playbackState.isPlaying,
            initialTime: playbackState.position,
          });
          videoArea.appendChild(embedded.element);
          getVideoElement = embedded.getVideoElement;
          activePlayerDestroy = embedded.destroy;
        } else {
          // Use native video player for direct URLs and HLS
          const player = createPlayer({
            videoSource,
            wsClient,
            initialPlaying: playbackState.isPlaying,
            initialTime: playbackState.position,
          });
          videoArea.appendChild(player.element);
          getVideoElement = player.getVideoElement;
          activePlayerDestroy = player.destroy;
        }

        // Start sync engine
        if (activeSyncEngine) {
          activeSyncEngine.stop();
        }
        activeSyncEngine = new SyncEngine({
          wsClient,
          getVideoElement: () => getVideoElement(),
        });
        activeSyncEngine.start();
      }
    });

    // Show placeholder until video source is received
    videoArea.innerHTML = `
      <div class="video-player">
        <div class="video-player__placeholder">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <p>Connecting to room...</p>
          <p class="video-player__room-code">Room: <strong>${roomCode}</strong></p>
        </div>
      </div>
    `;

    // Handle kicked event
    wsClient.on("kicked", (msg) => {
      cleanupRoom();
      window.location.hash = "#/";
      alert(msg.reason || "You have been kicked from the room.");
    });

    // Connect
    wsClient.connect();
  }

  // Listen for hash changes
  window.addEventListener("hashchange", renderRoute);

  // Initial render
  renderRoute();

  return container;
}
