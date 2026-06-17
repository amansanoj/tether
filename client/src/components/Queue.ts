/**
 * Queue component.
 * A toggleable panel to view and manage the shared song queue: add YouTube /
 * YouTube Music links, jump to a track, remove tracks, and skip prev/next.
 */

import { WsClient } from "../lib/ws";
import { queueStore, type QueueState } from "../stores/queue";
import { roomStore } from "../stores/room";

interface QueueOptions {
  wsClient: WsClient;
}

function detectType(url: string): "file" | "hls" | "youtube" | "vimeo" {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  if (/\.m3u8(\?|$)/i.test(url)) return "hls";
  return "file";
}

/** Best-effort title lookup via YouTube oEmbed (falls back to the URL). */
async function resolveTitle(url: string): Promise<string> {
  if (/youtube\.com|youtu\.be/i.test(url)) {
    try {
      const r = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
      );
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j.title === "string" && j.title.length > 0) return j.title;
      }
    } catch {
      // CORS or network failure — fall back below
    }
  }
  return url;
}

function escapeHtml(text: string): string {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

export function createQueue(options: QueueOptions): {
  element: HTMLElement;
  destroy: () => void;
} {
  const { wsClient } = options;
  let open = false;
  let draft = "";

  const container = document.createElement("div");
  container.className = "queue";

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "queue__toggle";

  const panel = document.createElement("div");
  panel.className = "queue__panel";
  panel.style.display = "none";

  container.appendChild(toggleBtn);
  container.appendChild(panel);

  function renderToggle(state: QueueState): void {
    toggleBtn.innerHTML = `<i class="ph-duotone ph-queue"></i> Queue (${state.queue.length})`;
  }

  function renderPanel(state: QueueState): void {
    panel.style.display = open ? "block" : "none";
    if (!open) return;

    const { queue, currentIndex } = state;
    let html = `
      <div class="queue__header">
        <h4>Queue</h4>
        <div class="queue__nav">
          <button class="queue__prev" title="Previous"><i class="ph-duotone ph-skip-back"></i></button>
          <button class="queue__next" title="Next"><i class="ph-duotone ph-skip-forward"></i></button>
        </div>
      </div>
      <div class="queue__add">
        <input class="queue__input" type="url" placeholder="Paste a YouTube / YouTube Music link" />
        <button class="queue__add-btn" title="Add"><i class="ph-duotone ph-plus"></i></button>
      </div>
      <div class="queue__list">
    `;

    if (queue.length === 0) {
      html += `<div class="queue__empty">Queue is empty. Add a song above.</div>`;
    } else {
      const myName = roomStore.getState()?.displayName;
      queue.forEach((item, i) => {
        const isYou = !!myName && item.addedBy === myName;
        const by = `${escapeHtml(item.addedBy)}${isYou ? " (you)" : ""}`;
        html += `
          <div class="queue__item ${i === currentIndex ? "queue__item--current" : ""}">
            <span class="queue__num">${i === currentIndex ? "▶" : i + 1}</span>
            <div class="queue__meta">
              <span class="queue__title">${escapeHtml(item.title)}</span>
              <span class="queue__by">${by}</span>
            </div>
            <div class="queue__item-actions">
              <button class="queue__play" data-index="${i}" title="Play"><i class="ph-duotone ph-play"></i></button>
              <button class="queue__remove" data-id="${item.id}" title="Remove"><i class="ph-duotone ph-x"></i></button>
            </div>
          </div>
        `;
      });
    }
    html += `</div>`;
    panel.innerHTML = html;

    // Restore in-progress input text
    const input = panel.querySelector(".queue__input") as HTMLInputElement | null;
    if (input) {
      input.value = draft;
      input.addEventListener("input", () => {
        draft = input.value;
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addCurrent();
        }
      });
    }

    panel.querySelector(".queue__add-btn")?.addEventListener("click", addCurrent);
    panel.querySelector(".queue__prev")?.addEventListener("click", () => {
      wsClient.send({ type: "queue:prev" });
    });
    panel.querySelector(".queue__next")?.addEventListener("click", () => {
      wsClient.send({ type: "queue:next" });
    });
    panel.querySelectorAll(".queue__play").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = parseInt((btn as HTMLElement).dataset.index!, 10);
        wsClient.send({ type: "queue:jump", index });
      });
    });
    panel.querySelectorAll(".queue__remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = (btn as HTMLElement).dataset.id!;
        wsClient.send({ type: "queue:remove", id });
      });
    });
  }

  async function addCurrent(): Promise<void> {
    const url = draft.trim();
    if (!url) return;
    draft = "";
    const input = panel.querySelector(".queue__input") as HTMLInputElement | null;
    if (input) input.value = "";

    const title = await resolveTitle(url);
    wsClient.send({
      type: "queue:add",
      source: { type: detectType(url), url },
      title,
    });
  }

  toggleBtn.addEventListener("click", () => {
    open = !open;
    renderPanel(queueStore.getState());
  });

  const unsubscribe = queueStore.subscribe((state) => {
    renderToggle(state);
    renderPanel(state);
  });

  function destroy(): void {
    unsubscribe();
  }

  return { element: container, destroy };
}
