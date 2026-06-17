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
import { createQueue } from "./components/Queue";
import { WsClient } from "./lib/ws";
import { SyncEngine } from "./lib/sync";
import { roomStore } from "./stores/room";
import { chatStore } from "./stores/chat";
import { queueStore } from "./stores/queue";

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

  // Short invite link: #/CODE
  const bareMatch = path.match(/^\/([A-Za-z0-9]{6})$/);
  if (bareMatch) {
    return { view: "room", roomCode: bareMatch[1].toUpperCase(), params };
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
  let activeQueueDestroy: (() => void) | null = null;

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
    if (activeQueueDestroy) {
      activeQueueDestroy();
      activeQueueDestroy = null;
    }
    // Clear stores on room leave
    chatStore.clear();
    queueStore.clear();
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

  /**
   * Shown when someone opens an invite link (#/CODE) without a name —
   * prompts for a display name, then enters the room.
   */
  function renderJoinPrompt(roomCode: string): void {
    container.className = "app app--home";
    container.innerHTML = `
      <header class="topbar">
        <div class="topbar__brand"><span class="topbar__brand-name">Tether</span></div>
      </header>
      <main class="home-main">
        <div class="home">
          <div class="bento home__form-card">
            <h2 class="join-prompt__title">Join Room</h2>
            <p class="join-prompt__code">${roomCode}</p>
            <form class="room-join__form" id="jp-form">
              <div class="room-join__field">
                <label for="jp-name">Your Display Name</label>
                <input type="text" id="jp-name" placeholder="Your name" maxlength="32" required autocomplete="off" />
              </div>
              <div class="room-join__error" id="jp-error" style="display:none"></div>
              <button type="submit" class="room-join__submit">Join Room</button>
            </form>
          </div>
        </div>
      </main>
    `;

    const form = container.querySelector("#jp-form") as HTMLFormElement | null;
    const input = container.querySelector("#jp-name") as HTMLInputElement | null;
    const errorEl = container.querySelector("#jp-error") as HTMLElement | null;
    input?.focus();

    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = (input?.value || "").trim();
      if (!name) return;

      // Verify the room exists before entering
      try {
        const res = await fetch(`/api/rooms/${roomCode}`);
        if (!res.ok && errorEl) {
          errorEl.textContent =
            res.status === 404
              ? "Room not found. Check the link and try again."
              : "Could not join room. Try again.";
          errorEl.style.display = "block";
          return;
        }
      } catch {
        if (errorEl) {
          errorEl.textContent = "Network error. Try again.";
          errorEl.style.display = "block";
        }
        return;
      }

      window.location.hash = `#/room/${roomCode}?name=${encodeURIComponent(name)}`;
    });
  }

  function renderRoom(roomCode: string, params?: URLSearchParams): void {
    const providedName = params?.get("name");
    if (!providedName || !providedName.trim()) {
      // No name yet (e.g. opened via an invite link) — ask for one first.
      renderJoinPrompt(roomCode);
      return;
    }
    container.className = "app app--room";
    const displayName = providedName.trim();

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

    // Chat sidebar wrapper
    const chatSidebar = document.createElement("div");
    chatSidebar.className = "room-layout__chat";

    // Floating button to reopen the chat once collapsed (hidden by default)
    const reopenBtn = document.createElement("button");
    reopenBtn.className = "chat-reopen";
    reopenBtn.setAttribute("aria-label", "Open chat");
    reopenBtn.title = "Open chat";
    reopenBtn.innerHTML = `<i class="ph-duotone ph-chat-circle-text"></i>`;
    reopenBtn.style.display = "none";

    function setChatCollapsed(collapsed: boolean): void {
      chatSidebar.style.display = collapsed ? "none" : "flex";
      reopenBtn.style.display = collapsed ? "flex" : "none";
    }
    reopenBtn.addEventListener("click", () => setChatCollapsed(false));

    // Create chat sidebar
    const chat = createChat({
      wsClient,
      roomCode,
      onCollapse: () => setChatCollapsed(true),
    });
    activeChatDestroy = chat.destroy;
    chatSidebar.appendChild(chat.element);

    // Create reactions overlay
    const reactions = createReactions({ wsClient });
    activeReactionsDestroy = reactions.destroy;

    // Create dashboard
    const dashboard = createDashboard({ wsClient });
    activeDashboardDestroy = dashboard.destroy;

    // Create queue
    const queue = createQueue({ wsClient });
    activeQueueDestroy = queue.destroy;

    // Status bar
    const statusBar = createStatusBar();

    // Assemble layout
    layout.appendChild(videoArea);
    layout.appendChild(chatSidebar);
    container.appendChild(layout);
    container.appendChild(reopenBtn);
    container.appendChild(reactions.element);
    container.appendChild(dashboard.element);
    container.appendChild(queue.element);
    container.appendChild(statusBar);

    // Active source tracking + reusable mount
    let getVideoElement: () => HTMLVideoElement | null = () => null;
    let loadedUrl: string | null = null;

    const switchRoom = (code: string) => {
      window.location.hash = `#/room/${code}?name=${encodeURIComponent(displayName)}`;
    };

    function getLinkedRoom(): { code: string; label: string } | null {
      const s = roomStore.getState();
      return s?.linkedRoomId
        ? { code: s.linkedRoomId, label: s.linkedRoomLabel || "Other track" }
        : null;
    }

    function mountSource(
      source: { type: string; url: string; label?: string },
      opts: {
        audioTracks?: Array<{ label: string; url: string }>;
        linkedRoom?: { code: string; label: string } | null;
        initialPlaying: boolean;
        initialTime: number;
      }
    ): void {
      videoArea.innerHTML = "";
      const onEnded = () => wsClient.send({ type: "queue:next" });

      if (isEmbeddedSource(source.url)) {
        const embedded = createEmbeddedPlayer({
          videoSource: source,
          wsClient,
          initialPlaying: opts.initialPlaying,
          initialTime: opts.initialTime,
          linkedRoom: opts.linkedRoom ?? null,
          onSwitchRoom: switchRoom,
          onEnded,
        });
        videoArea.appendChild(embedded.element);
        getVideoElement = embedded.getVideoElement;
        activePlayerDestroy = embedded.destroy;
      } else {
        const player = createPlayer({
          videoSource: source,
          wsClient,
          initialPlaying: opts.initialPlaying,
          initialTime: opts.initialTime,
          audioTracks: opts.audioTracks ?? [],
          linkedRoom: opts.linkedRoom ?? null,
          onSwitchRoom: switchRoom,
          onEnded,
        });
        videoArea.appendChild(player.element);
        getVideoElement = player.getVideoElement;
        activePlayerDestroy = player.destroy;
      }

      loadedUrl = source.url;

      if (activeSyncEngine) activeSyncEngine.stop();
      activeSyncEngine = new SyncEngine({
        wsClient,
        getVideoElement: () => getVideoElement(),
      });
      activeSyncEngine.start();
    }

    // Initialize on room:state
    wsClient.on("room:state", (msg) => {
      const state = roomStore.getState();
      const mainVideo = msg.room?.videoSource || state?.videoSource;

      if (msg.chatHistory && Array.isArray(msg.chatHistory)) {
        chatStore.initialize(msg.chatHistory);
      }
      if (msg.room?.hostId && msg.connectionId) {
        roomStore.updateState({
          isHost: msg.connectionId === msg.room.hostId,
          myId: msg.connectionId,
        });
      }

      const audioTracks = msg.room?.audioTracks || [];
      roomStore.updateState({
        audioTracks,
        linkedRoomId: msg.room?.linkedRoomId || null,
        linkedRoomLabel: msg.room?.linkedRoomLabel || null,
      });

      // Initialize the shared queue
      queueStore.set(msg.room?.queue || [], msg.room?.currentIndex ?? 0);

      const playbackState = msg.playbackState || { isPlaying: false, position: 0 };
      const active = queueStore.currentSource() || mainVideo;

      if (active && active.url) {
        const isMain = !!mainVideo && active.url === mainVideo.url;
        mountSource(active, {
          audioTracks: isMain ? audioTracks : [],
          linkedRoom: isMain ? getLinkedRoom() : null,
          initialPlaying: playbackState.isPlaying,
          initialTime: playbackState.position,
        });
      }
    });

    // React to queue changes — load the new current source when it changes
    wsClient.on("queue:update", (msg) => {
      queueStore.set(msg.queue || [], msg.currentIndex ?? 0);
      const active = queueStore.currentSource();
      if (active && active.url && active.url !== loadedUrl) {
        const mainVideo = roomStore.getState()?.videoSource;
        const isMain = !!mainVideo && active.url === mainVideo.url;
        mountSource(active, {
          audioTracks: isMain ? roomStore.getState()?.audioTracks || [] : [],
          linkedRoom: isMain ? getLinkedRoom() : null,
          initialPlaying: true,
          initialTime: 0,
        });
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
