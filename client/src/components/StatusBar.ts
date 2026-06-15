/**
 * StatusBar component.
 * Shows connection status indicator and participant count.
 */

import { connectionStore, type ConnectionStatus } from "../stores/connection";
import { roomStore } from "../stores/room";

export function createStatusBar(): HTMLElement {
  const container = document.createElement("div");
  container.className = "status-bar";

  let currentStatus: ConnectionStatus = "disconnected";
  let participantCount = 0;

  function render(): void {
    const statusColor = getStatusColor(currentStatus);
    const statusLabel = getStatusLabel(currentStatus);

    container.innerHTML = `
      <div class="status-bar__connection">
        <span class="status-bar__dot" style="background-color: ${statusColor};"></span>
        <span class="status-bar__label">${statusLabel}</span>
      </div>
      <div class="status-bar__info">
        <span class="status-bar__participants">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          ${participantCount}
        </span>
      </div>
    `;
  }

  function getStatusColor(status: ConnectionStatus): string {
    switch (status) {
      case "connected":
        return "#4caf50";
      case "reconnecting":
        return "#ff9800";
      case "disconnected":
        return "#f44336";
    }
  }

  function getStatusLabel(status: ConnectionStatus): string {
    switch (status) {
      case "connected":
        return "Connected";
      case "reconnecting":
        return "Reconnecting...";
      case "disconnected":
        return "Disconnected";
    }
  }

  // Subscribe to connection store
  connectionStore.subscribe((status) => {
    currentStatus = status;
    render();
  });

  // Subscribe to room store for participant count
  roomStore.subscribe((state) => {
    const count = state?.participants?.length ?? 0;
    if (count !== participantCount) {
      participantCount = count;
      render();
    }
  });

  render();
  return container;
}
