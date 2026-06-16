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
          <i class="ph-duotone ph-users" style="font-size: 0.9rem;"></i>
          ${participantCount}
        </span>
      </div>
    `;
  }

  function getStatusColor(status: ConnectionStatus): string {
    switch (status) {
      case "connected":
        return "#3fd555";
      case "reconnecting":
        return "#fdeca0";
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
