/**
 * App component.
 * Handles hash-based routing and renders the appropriate view.
 */

import { createRoomJoin } from "./components/RoomJoin";
import { createStatusBar } from "./components/StatusBar";
import { roomStore } from "./stores/room";

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

  function renderRoute(): void {
    const route = parseHash();

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

    // Room layout
    const layout = document.createElement("div");
    layout.className = "room-layout";

    // Video player area
    const videoArea = document.createElement("div");
    videoArea.className = "room-layout__video";
    videoArea.innerHTML = `
      <div class="video-player">
        <div class="video-player__placeholder">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <p>Video player loading...</p>
          <p class="video-player__room-code">Room: <strong>${roomCode}</strong></p>
        </div>
      </div>
    `;

    // Chat sidebar
    const chatSidebar = document.createElement("div");
    chatSidebar.className = "room-layout__chat";
    chatSidebar.innerHTML = `
      <div class="chat">
        <div class="chat__header">
          <h3>Chat</h3>
          <span class="chat__room-code">${roomCode}</span>
        </div>
        <div class="chat__messages">
          <div class="chat__empty">
            <p>No messages yet. Say hi!</p>
          </div>
        </div>
        <div class="chat__input-area">
          <input type="text" class="chat__input" placeholder="Type a message..." maxlength="500" />
          <button class="chat__send" aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    // Reaction overlay
    const reactionOverlay = document.createElement("div");
    reactionOverlay.className = "reaction-overlay";
    reactionOverlay.id = "reaction-overlay";

    // Status bar
    const statusBar = createStatusBar();

    // Assemble layout
    layout.appendChild(videoArea);
    layout.appendChild(chatSidebar);
    container.appendChild(layout);
    container.appendChild(reactionOverlay);
    container.appendChild(statusBar);

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
  }

  // Listen for hash changes
  window.addEventListener("hashchange", renderRoute);

  // Initial render
  renderRoute();

  return container;
}
