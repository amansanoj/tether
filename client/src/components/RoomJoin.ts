/**
 * RoomJoin component.
 * Provides forms for creating or joining a room.
 */

import { roomStore } from "../stores/room";

type Mode = "create" | "join";

/**
 * Detect the video source type from a URL.
 * - YouTube / Vimeo links -> embedded players
 * - .m3u8 -> HLS
 * - everything else (.mp4, .webm, etc.) -> direct file
 */
function detectSourceType(url: string): "file" | "hls" | "youtube" | "vimeo" {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  if (/\.m3u8(\?|$)/i.test(url)) return "hls";
  return "file";
}

export function createRoomJoin(): HTMLElement {
  let mode: Mode = "join";
  let loading = false;
  let error = "";

  const container = document.createElement("div");
  container.className = "home";

  function render(): void {
    container.innerHTML = `
        <div class="home__left">
          <div class="bento home__brand">
            <i class="ph-duotone ph-television home__brand-icon"></i>
            <div class="home__brand-text">
              <h1 class="home__title">Tether</h1>
              <p class="home__tagline">Watch together, stay in sync.</p>
            </div>
          </div>
          <div class="home__features">
            <div class="bento feature-tile">
              <i class="ph-duotone ph-broadcast" style="color: var(--accent)"></i>
              <span>In-sync playback</span>
            </div>
            <div class="bento feature-tile">
              <i class="ph-duotone ph-chat-teardrop-dots" style="color: var(--secondary)"></i>
              <span>Live chat</span>
            </div>
            <div class="bento feature-tile">
              <i class="ph-duotone ph-heart" style="color: var(--primary)"></i>
              <span>Reactions</span>
            </div>
            <div class="bento feature-tile">
              <i class="ph-duotone ph-translate" style="color: var(--accent)"></i>
              <span>Dual language</span>
            </div>
          </div>
        </div>

        <div class="bento home__form-card">
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
        </div>
    `;

    // Bind events
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
  }

  function renderJoinForm(): string {
    return `
      <form class="room-join__form">
        <div class="room-join__field">
          <label for="room-code">Room Code</label>
          <input
            type="text"
            id="room-code"
            name="roomCode"
            placeholder="Enter 6-character code"
            maxlength="6"
            required
            autocomplete="off"
          />
        </div>
        <div class="room-join__field">
          <label for="display-name">Display Name</label>
          <input
            type="text"
            id="display-name"
            name="displayName"
            placeholder="Your name"
            maxlength="32"
            required
            autocomplete="off"
          />
        </div>
        <button type="submit" class="room-join__submit" ${loading ? "disabled" : ""}>
          ${loading ? "Joining..." : "Join Room"}
        </button>
      </form>
    `;
  }

  function renderCreateForm(): string {
    return `
      <form class="room-join__form">
        <div class="room-join__field">
          <label for="video-url">Video Source URL</label>
          <input
            type="url"
            id="video-url"
            name="videoUrl"
            placeholder="https://example.com/movie.mp4"
            required
          />
          <small class="room-join__hint">MP4/WebM, HLS (.m3u8), YouTube or Vimeo links all work.</small>
        </div>
        <div class="room-join__field">
          <label for="linked-url">Linked Source URL (optional)</label>
          <input
            type="url"
            id="linked-url"
            name="linkedUrl"
            placeholder="https://example.com/alt-language.mp4"
          />
          <small class="room-join__hint">For a second language track, synced to the same timeline.</small>
        </div>
        <div class="room-join__field">
          <label for="host-name">Your Display Name</label>
          <input
            type="text"
            id="host-name"
            name="displayName"
            placeholder="Your name (host)"
            maxlength="32"
            required
            autocomplete="off"
          />
        </div>
        <button type="submit" class="room-join__submit" ${loading ? "disabled" : ""}>
          ${loading ? "Creating..." : "Create Room"}
        </button>
      </form>
    `;
  }

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    if (loading) return;

    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);

    loading = true;
    error = "";
    render();

    try {
      if (mode === "create") {
        await handleCreate(formData);
      } else {
        await handleJoin(formData);
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : "An error occurred";
      loading = false;
      render();
    }
  }

  async function handleCreate(formData: FormData): Promise<void> {
    const videoUrl = (formData.get("videoUrl") as string).trim();
    const linkedUrl = (formData.get("linkedUrl") as string)?.trim() || "";
    const displayName = (formData.get("displayName") as string).trim();

    if (!videoUrl) {
      throw new Error("Video source URL is required");
    }
    if (!displayName) {
      throw new Error("Display name is required");
    }

    const videoType = detectSourceType(videoUrl);
    const body: Record<string, unknown> = {
      videoSource: { type: videoType, url: videoUrl },
    };

    if (linkedUrl) {
      body.linkedVideoSource = { type: detectSourceType(linkedUrl), url: linkedUrl };
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

    // Set initial room state
    roomStore.setState({
      code: roomCode,
      videoSource: { type: videoType, url: videoUrl },
      linkedVideoSource: linkedUrl
        ? { type: detectSourceType(linkedUrl), url: linkedUrl }
        : null,
      participants: [],
      isHost: true,
      displayName,
      playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
    });

    // Navigate to room
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

    // Verify room exists
    const response = await fetch(`/api/rooms/${roomCode}`);
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("Room not found. Check the code and try again.");
      }
      throw new Error(`Failed to join room (${response.status})`);
    }

    const data = await response.json();

    // Set room state
    roomStore.setState({
      code: roomCode,
      videoSource: data.videoSource || null,
      linkedVideoSource: data.linkedVideoSource || null,
      participants: [],
      isHost: false,
      displayName,
      playbackState: { playing: false, currentTime: 0, playbackRate: 1 },
    });

    // Navigate to room
    window.location.hash = `#/room/${roomCode}?name=${encodeURIComponent(displayName)}`;
    loading = false;
  }

  render();
  return container;
}
