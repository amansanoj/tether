/**
 * RoomJoin component.
 * Provides forms for creating or joining a room, plus a "rooms ready" screen
 * that surfaces both codes when a linked (two-video) room is created.
 */

import { roomStore } from "../stores/room";

type Mode = "create" | "join";

interface CreatedResult {
  primary: { code: string; label: string };
  linked: { code: string; label: string };
  displayName: string;
}

/**
 * Detect the video source type from a URL.
 */
function detectSourceType(url: string): "file" | "hls" | "youtube" | "vimeo" {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  if (/\.m3u8(\?|$)/i.test(url)) return "hls";
  return "file";
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function createRoomJoin(): HTMLElement {
  let mode: Mode = "join";
  let loading = false;
  let error = "";
  let created: CreatedResult | null = null;

  const container = document.createElement("div");
  container.className = "home-wrap";

  function render(): void {
    const formCard = created
      ? renderCreatedResult(created)
      : `
        <div class="room-join__tabs">
          <button class="room-join__tab ${mode === "join" ? "room-join__tab--active" : ""}" data-mode="join">
            Join
          </button>
          <button class="room-join__tab ${mode === "create" ? "room-join__tab--active" : ""}" data-mode="create">
            Create
          </button>
        </div>
        ${error ? `<div class="room-join__error">${error}</div>` : ""}
        ${mode === "join" ? renderJoinForm() : renderCreateForm()}
      `;

    container.innerHTML = `
      <header class="topbar">
        <div class="topbar__brand">
          <i class="ph-duotone ph-television topbar__brand-icon"></i>
          <span class="topbar__brand-name">Tether</span>
        </div>
        <a class="topbar__gh" href="https://github.com/amansanoj/tether" target="_blank" rel="noopener noreferrer" aria-label="Tether on GitHub">
          <svg role="img" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
          <span>GitHub</span>
        </a>
      </header>
      <main class="home-main">
        <div class="home">
          <div class="bento home__form-card">
            ${formCard}
          </div>
          <div class="home__features">
            <span class="feature-chip"><i class="ph-duotone ph-broadcast" style="color: var(--accent)"></i> In-sync playback</span>
            <span class="feature-chip"><i class="ph-duotone ph-chat-teardrop-dots" style="color: var(--secondary)"></i> Live chat</span>
            <span class="feature-chip"><i class="ph-duotone ph-heart" style="color: var(--primary)"></i> Reactions</span>
            <span class="feature-chip"><i class="ph-duotone ph-translate" style="color: var(--accent)"></i> Dual language</span>
          </div>
        </div>
      </main>
    `;

    bindEvents();
  }

  function bindEvents(): void {
    if (created) {
      container.querySelectorAll(".created__enter").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = (btn as HTMLElement).dataset.code!;
          window.location.hash = `#/room/${code}?name=${encodeURIComponent(created!.displayName)}`;
        });
      });
      container.querySelectorAll(".created__copy").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = (btn as HTMLElement).dataset.code!;
          navigator.clipboard?.writeText(code).catch(() => {});
          (btn as HTMLElement).textContent = "Copied";
          setTimeout(() => ((btn as HTMLElement).textContent = "Copy"), 1500);
        });
      });
      const backBtn = container.querySelector(".created__back");
      backBtn?.addEventListener("click", () => {
        created = null;
        render();
      });
      return;
    }

    const tabs = container.querySelectorAll(".room-join__tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const newMode = (tab as HTMLElement).dataset.mode as Mode;
        if (newMode !== mode) {
          mode = newMode;
          error = "";
          render();
        }
      });
    });

    const form = container.querySelector("form");
    if (form) {
      form.addEventListener("submit", handleSubmit);
    }

    // Audio track add/remove (create mode only)
    const addBtn = container.querySelector(".audio-add");
    const list = container.querySelector(".audio-tracks__list");
    if (addBtn && list) {
      addBtn.addEventListener("click", () => {
        list.insertAdjacentHTML("beforeend", audioRowHTML());
      });
      list.addEventListener("click", (e) => {
        const rm = (e.target as HTMLElement).closest(".audio-row__remove");
        if (rm) rm.closest(".audio-row")?.remove();
      });
    }
  }

  function renderJoinForm(): string {
    return `
      <form class="room-join__form">
        <div class="room-join__field">
          <label for="room-code">Room Code</label>
          <input type="text" id="room-code" name="roomCode" placeholder="Enter 6-character code" maxlength="6" required autocomplete="off" />
        </div>
        <div class="room-join__field">
          <label for="display-name">Display Name</label>
          <input type="text" id="display-name" name="displayName" placeholder="Your name" maxlength="32" required autocomplete="off" />
        </div>
        <button type="submit" class="room-join__submit" ${loading ? "disabled" : ""}>
          ${loading ? "Joining..." : "Join Room"}
        </button>
      </form>
    `;
  }

  function audioRowHTML(): string {
    return `
      <div class="audio-row">
        <input type="text" class="audio-row__label" placeholder="Language" maxlength="24" autocomplete="off" />
        <input type="url" class="audio-row__url" placeholder="https://.../audio.mp3" />
        <button type="button" class="audio-row__remove" aria-label="Remove track">
          <i class="ph-duotone ph-x"></i>
        </button>
      </div>
    `;
  }

  function renderCreateForm(): string {
    return `
      <form class="room-join__form">
        <div class="room-join__field">
          <label for="video-url">Video Source URL</label>
          <input type="url" id="video-url" name="videoUrl" placeholder="https://example.com/movie.mp4" required />
          <small class="room-join__hint">MP4/WebM, HLS (.m3u8), YouTube or Vimeo links all work.</small>
        </div>

        <div class="room-join__field">
          <label>Audio Tracks <span class="room-join__label-opt">(optional)</span></label>
          <div class="audio-tracks__list"></div>
          <button type="button" class="audio-add">
            <i class="ph-duotone ph-plus"></i> Add audio track
          </button>
          <small class="room-join__hint">Add language tracks (e.g. Hindi, Malayalam) to switch audio on one video — no second upload.</small>
        </div>

        <details class="room-join__advanced">
          <summary>Or use a second video file</summary>
          <div class="room-join__field">
            <label for="linked-url">Linked Video URL</label>
            <input type="url" id="linked-url" name="linkedUrl" placeholder="https://example.com/alt-cut.mp4" />
          </div>
          <div class="room-join__field">
            <label for="linked-label">Linked Label</label>
            <input type="text" id="linked-label" name="linkedLabel" placeholder="e.g. Malayalam" maxlength="24" autocomplete="off" />
          </div>
          <small class="room-join__hint">A separate video file (e.g. a different cut), synced to the same timeline.</small>
        </details>

        <div class="room-join__field">
          <label for="host-name">Your Display Name</label>
          <input type="text" id="host-name" name="displayName" placeholder="Your name (host)" maxlength="32" required autocomplete="off" />
        </div>

        <button type="submit" class="room-join__submit" ${loading ? "disabled" : ""}>
          ${loading ? "Creating..." : "Create Room"}
        </button>
      </form>
    `;
  }

  function renderCreatedResult(c: CreatedResult): string {
    const roomCard = (label: string, code: string) => `
      <div class="created__room">
        <span class="created__label">${escapeHtml(label)}</span>
        <code class="created__code">${code}</code>
        <div class="created__actions">
          <button type="button" class="created__copy" data-code="${code}">Copy</button>
          <button type="button" class="created__enter" data-code="${code}">Enter</button>
        </div>
      </div>
    `;
    return `
      <div class="created">
        <h2 class="created__title">Rooms ready</h2>
        <p class="created__hint">Two linked rooms — share each code with whoever wants that track. Both stay in sync.</p>
        <div class="created__rooms">
          ${roomCard(c.primary.label, c.primary.code)}
          ${roomCard(c.linked.label, c.linked.code)}
        </div>
        <button type="button" class="created__back">← Create another</button>
      </div>
    `;
  }

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (loading) return;

    const form = e.target as HTMLFormElement;

    loading = true;
    error = "";
    render();

    try {
      if (mode === "create") {
        await handleCreate(container.querySelector("form") as HTMLFormElement);
      } else {
        await handleJoin(new FormData(container.querySelector("form") as HTMLFormElement));
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "An error occurred";
      loading = false;
      render();
    }
  }

  function inputValue(form: HTMLElement, selector: string): string {
    const el = form.querySelector(selector) as HTMLInputElement | null;
    return el ? el.value.trim() : "";
  }

  async function handleCreate(form: HTMLFormElement): Promise<void> {
    const videoUrl = inputValue(form, "#video-url");
    const linkedUrl = inputValue(form, "#linked-url");
    const linkedLabel = inputValue(form, "#linked-label");
    const displayName = inputValue(form, "#host-name");

    if (!videoUrl) throw new Error("Video source URL is required");
    if (!displayName) throw new Error("Display name is required");

    // Collect audio tracks
    const audioTracks: Array<{ label: string; url: string }> = [];
    form.querySelectorAll(".audio-row").forEach((row, i) => {
      const url = (row.querySelector(".audio-row__url") as HTMLInputElement)?.value.trim() || "";
      const label =
        (row.querySelector(".audio-row__label") as HTMLInputElement)?.value.trim() ||
        `Track ${i + 1}`;
      if (url) audioTracks.push({ label, url });
    });

    const videoType = detectSourceType(videoUrl);
    const body: Record<string, unknown> = {
      videoSource: { type: videoType, url: videoUrl },
    };
    if (audioTracks.length > 0) body.audioTracks = audioTracks;
    if (linkedUrl) {
      body.linkedVideoSource = {
        type: detectSourceType(linkedUrl),
        url: linkedUrl,
        ...(linkedLabel ? { label: linkedLabel } : {}),
      };
    }

    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to create room (${response.status})`);
    }

    const data = await response.json();
    const roomCode = data.roomCode as string;
    const linkedRoomCode = data.linkedRoomCode as string | undefined;

    // Linked (two-video) room → show both codes instead of auto-navigating.
    if (linkedRoomCode) {
      created = {
        primary: { code: roomCode, label: "Original" },
        linked: { code: linkedRoomCode, label: linkedLabel || "Alternate" },
        displayName,
      };
      loading = false;
      render();
      return;
    }

    // Single room (with optional audio tracks) → seed store and go.
    roomStore.setState({
      code: roomCode,
      videoSource: { type: videoType, url: videoUrl },
      linkedVideoSource: null,
      audioTracks,
      linkedRoomId: null,
      linkedRoomLabel: null,
      participants: [],
      isHost: true,
      displayName,
      playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
    });

    window.location.hash = `#/room/${roomCode}?name=${encodeURIComponent(displayName)}`;
    loading = false;
  }

  async function handleJoin(formData: FormData): Promise<void> {
    const roomCode = (formData.get("roomCode") as string).trim().toUpperCase();
    const displayName = (formData.get("displayName") as string).trim();

    if (!roomCode || roomCode.length !== 6) {
      throw new Error("Room code must be 6 characters");
    }
    if (!displayName) {
      throw new Error("Display name is required");
    }

    const response = await fetch(`/api/rooms/${roomCode}`);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Room not found. Check the code and try again.");
      }
      throw new Error(`Failed to join room (${response.status})`);
    }

    const data = await response.json();

    roomStore.setState({
      code: roomCode,
      videoSource: data.videoSource || null,
      linkedVideoSource: null,
      audioTracks: data.audioTracks || [],
      linkedRoomId: data.linkedRoomId || null,
      linkedRoomLabel: null,
      participants: [],
      isHost: false,
      displayName,
      playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
    });

    window.location.hash = `#/room/${roomCode}?name=${encodeURIComponent(displayName)}`;
    loading = false;
  }

  render();
  return container;
}
