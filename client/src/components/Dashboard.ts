/**
 * Host Dashboard component.
 * Shows participant stats (latency, drift, buffering) and host controls
 * (Force Resync, Kick). Only visible to the host.
 */

import { WsClient } from "../lib/ws";
import { roomStore } from "../stores/room";

interface DashboardParticipant {
  id: string;
  displayName: string;
  latency: number;
  drift: number;
  isBuffering: boolean;
}

interface DashboardOptions {
  wsClient: WsClient;
}

export function createDashboard(options: DashboardOptions): {
  element: HTMLElement;
  destroy: () => void;
} {
  const { wsClient } = options;
  const unsubscribers: Array<() => void> = [];

  let participants: DashboardParticipant[] = [];
  let isVisible = false;
  let isHost = false;
  let myId = "";

  // Container
  const container = document.createElement("div");
  container.className = "dashboard";

  // Toggle button
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "dashboard__toggle";
  toggleBtn.textContent = "Host Dashboard";

  // Panel
  const panel = document.createElement("div");
  panel.className = "dashboard__panel";
  panel.style.display = "none";

  container.appendChild(toggleBtn);
  container.appendChild(panel);

  function render(): void {
    // Only show if host
    if (!isHost) {
      container.style.display = "none";
      return;
    }
    container.style.display = "block";
    panel.style.display = isVisible ? "block" : "none";
    toggleBtn.textContent = isVisible ? "Hide Dashboard" : "Host Dashboard";

    if (!isVisible) return;

    let html = `
      <div class="dashboard__header">
        <h4>Participants (${participants.length})</h4>
        <button class="dashboard__resync-btn">Force Resync</button>
      </div>
      <div class="dashboard__list">
    `;

    for (const p of participants) {
      const bufferingBadge = p.isBuffering
        ? `<span class="dashboard__badge dashboard__badge--buffering">Buffering</span>`
        : "";
      const kickBtn =
        p.id !== myId
          ? `<button class="dashboard__kick-btn" data-id="${p.id}">Kick</button>`
          : "";

      html += `
        <div class="dashboard__participant">
          <div class="dashboard__participant-info">
            <span class="dashboard__participant-name">${escapeHtml(p.displayName)}</span>
            ${bufferingBadge}
          </div>
          <div class="dashboard__participant-stats">
            <span class="dashboard__stat">Latency: ${p.latency}ms</span>
            <span class="dashboard__stat">Drift: ${p.drift.toFixed(2)}s</span>
            ${kickBtn}
          </div>
        </div>
      `;
    }

    html += "</div>";
    panel.innerHTML = html;

    // Bind resync button
    const resyncBtn = panel.querySelector(".dashboard__resync-btn");
    if (resyncBtn) {
      resyncBtn.addEventListener("click", () => {
        wsClient.send({ type: "host:force-resync" });
      });
    }

    // Bind kick buttons
    const kickBtns = panel.querySelectorAll(".dashboard__kick-btn");
    kickBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = (btn as HTMLElement).dataset.id;
        if (targetId) {
          wsClient.send({ type: "host:kick", targetId });
        }
      });
    });
  }

  function escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Toggle visibility
  toggleBtn.addEventListener("click", () => {
    isVisible = !isVisible;
    render();
  });

  // Listen for host:dashboard updates
  unsubscribers.push(
    wsClient.on("host:dashboard", (msg) => {
      if (msg.participants && Array.isArray(msg.participants)) {
        participants = msg.participants.map((p: any) => ({
          id: p.id,
          displayName: p.displayName,
          latency: p.latency || 0,
          drift: p.drift || 0,
          isBuffering: p.isBuffering || false,
        }));
        render();
      }
    })
  );

  // Listen for room:state to determine if we are host
  unsubscribers.push(
    wsClient.on("room:state", (msg) => {
      if (msg.room?.hostId && msg.connectionId) {
        myId = msg.connectionId;
        isHost = msg.connectionId === msg.room.hostId;
        render();
      }
    })
  );

  // Also check room store
  unsubscribers.push(
    roomStore.subscribe((state) => {
      if (state) {
        isHost = state.isHost;
        render();
      }
    })
  );

  // Initial render
  render();

  function destroy(): void {
    for (const unsub of unsubscribers) {
      unsub();
    }
  }

  return { element: container, destroy };
}
