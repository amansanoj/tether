/**
 * RoomJoin component.
 * Provides forms for creating or joining a room, plus a "rooms ready" screen
 * that surfaces both codes when a linked (two-video) room is created.
 */

import { roomStore } from "../stores/room";
import { navigate } from "../lib/router";
import { topbarHTML } from "../lib/ui";

const NAME_KEY = "tether:displayName";

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
      ${topbarHTML()}
      <main class="home-main">
        <div class="home">
          <div class="bento home__form-card">
            ${formCard}
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
          sessionStorage.setItem(NAME_KEY, created!.displayName);
          navigate(`/room/${code}`);
        });
      });
      container.querySelectorAll(".created__copy").forEach((btn) => {
        btn.addEventListener("click", () => {
          const code = (btn as HTMLElement).dataset.code!;
          const link = `${window.location.origin}/room/${code}`;
          navigator.clipboard?.writeText(link).catch(() => {});
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

    // Capture input values BEFORE re-rendering — render() rebuilds the form's
    // DOM and would otherwise wipe everything the user just typed.
    const createData = mode === "create" ? readCreateForm(form) : null;
    const joinData = mode === "join" ? readJoinForm(form) : null;

    loading = true;
    error = "";
    render();

    try {
      if (createData) {
        await handleCreate(createData);
      } else if (joinData) {
        await handleJoin(joinData);
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

  interface CreateData {
    videoUrl: string;
    linkedUrl: string;
    linkedLabel: string;
    displayName: string;
    audioTracks: Array<{ label: string; url: string }>;
  }

  function readCreateForm(form: HTMLElement): CreateData {
    const audioTracks: Array<{ label: string; url: string }> = [];
    form.querySelectorAll(".audio-row").forEach((row, i) => {
      const url = (row.querySelector(".audio-row__url") as HTMLInputElement)?.value.trim() || "";
      const label =
        (row.querySelector(".audio-row__label") as HTMLInputElement)?.value.trim() ||
        `Track ${i + 1}`;
      if (url) audioTracks.push({ label, url });
    });
    return {
      videoUrl: inputValue(form, "#video-url"),
      linkedUrl: inputValue(form, "#linked-url"),
      linkedLabel: inputValue(form, "#linked-label"),
      displayName: inputValue(form, "#host-name"),
      audioTracks,
    };
  }

  function readJoinForm(form: HTMLElement): { roomCode: string; displayName: string } {
    return {
      roomCode: inputValue(form, "#room-code").toUpperCase(),
      displayName: inputValue(form, "#display-name"),
    };
  }

  async function handleCreate(data: CreateData): Promise<void> {
    const { videoUrl, linkedUrl, linkedLabel, displayName, audioTracks } = data;

    if (!videoUrl) throw new Error("Video source URL is required");
    if (!displayName) throw new Error("Display name is required");

    const videoType = detectSourceType(videoUrl);
    const body: Record<string, unknown> = {
      videoSource: { type: videoType, url: videoUrl },
    };
    if (audioTracks.length > 0) body.audioTracks = audioTracks;
    if (displayName) body.hostName = displayName;
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
      const resData = await response.json().catch(() => ({}));
      throw new Error(resData.error || `Failed to create room (${response.status})`);
    }

    const resData = await response.json();
    const roomCode = resData.roomCode as string;
    const linkedRoomCode = resData.linkedRoomCode as string | undefined;

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

    sessionStorage.setItem(NAME_KEY, displayName);
    navigate(`/room/${roomCode}`);
    loading = false;
  }

  async function handleJoin(data: { roomCode: string; displayName: string }): Promise<void> {
    const { roomCode, displayName } = data;

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

    const resData = await response.json();

    roomStore.setState({
      code: roomCode,
      videoSource: resData.videoSource || null,
      linkedVideoSource: null,
      audioTracks: resData.audioTracks || [],
      linkedRoomId: resData.linkedRoomId || null,
      linkedRoomLabel: null,
      participants: [],
      isHost: false,
      displayName,
      playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
    });

    sessionStorage.setItem(NAME_KEY, displayName);
    navigate(`/room/${roomCode}`);
    loading = false;
  }

  render();
  return container;
}
