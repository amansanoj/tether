/**
 * Embedded Player component for YouTube and Vimeo.
 * Uses iframe with the platform postMessage APIs for playback control and sync.
 *
 * YouTube: requires a "listening" handshake after load before it emits
 * infoDelivery events (currentTime/duration) or reliably accepts commands.
 * Vimeo: requires addEventListener registration for timeupdate events.
 */

import { WsClient } from "../lib/ws";

interface EmbeddedPlayerOptions {
  videoSource: { type: string; url: string };
  wsClient: WsClient;
  initialPlaying: boolean;
  initialTime: number;
}

type EmbedType = "youtube" | "vimeo" | "unknown";

function detectEmbedType(url: string): EmbedType {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  return "unknown";
}

function extractYouTubeId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function extractVimeoId(url: string): string | null {
  const match = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  return match ? match[1] : null;
}

export function createEmbeddedPlayer(options: EmbeddedPlayerOptions): {
  element: HTMLElement;
  getVideoElement: () => HTMLVideoElement | null;
  destroy: () => void;
} {
  const { videoSource, wsClient, initialPlaying, initialTime } = options;
  const embedType = detectEmbedType(videoSource.url);

  const container = document.createElement("div");
  container.className = "video-player video-player--embedded";

  // Wrapper keeps a 16:9 frame so the iframe fills cleanly without collapsing.
  const frame = document.createElement("div");
  frame.className = "video-player__embed-frame";

  const iframe = document.createElement("iframe");
  iframe.className = "video-player__iframe";
  iframe.setAttribute("allowfullscreen", "true");
  iframe.setAttribute(
    "allow",
    "autoplay; encrypted-media; fullscreen; picture-in-picture"
  );
  iframe.frameBorder = "0";

  // Internal playback state (driven by platform events where possible)
  let currentTime = initialTime;
  let duration = 0;
  let isPlaying = initialPlaying;
  let lastInfoAt = 0; // when we last got a real timestamp from the platform

  // Virtual <video> proxy so the sync engine can read/drive the embed.
  const virtualVideo = document.createElement("video");
  virtualVideo.preload = "none";
  Object.defineProperty(virtualVideo, "currentTime", {
    get: () => currentTime,
    set: (val: number) => {
      currentTime = val;
      seekEmbed(val);
    },
    configurable: true,
  });
  Object.defineProperty(virtualVideo, "duration", {
    get: () => duration || NaN,
    configurable: true,
  });
  Object.defineProperty(virtualVideo, "paused", {
    get: () => !isPlaying,
    configurable: true,
  });
  Object.defineProperty(virtualVideo, "readyState", {
    get: () => 4, // HAVE_ENOUGH_DATA
    configurable: true,
  });
  Object.defineProperty(virtualVideo, "playbackRate", {
    get: () => 1,
    set: () => {}, // Embeds don't support rate-based drift correction
    configurable: true,
  });
  virtualVideo.play = async () => {
    playEmbed();
  };
  virtualVideo.pause = () => {
    pauseEmbed();
  };

  // --- Build iframe src ---
  if (embedType === "youtube") {
    const videoId = extractYouTubeId(videoSource.url);
    if (videoId) {
      const params = new URLSearchParams({
        enablejsapi: "1",
        autoplay: initialPlaying ? "1" : "0",
        start: String(Math.floor(initialTime)),
        controls: "0",
        modestbranding: "1",
        rel: "0",
        playsinline: "1",
        origin: window.location.origin,
      });
      iframe.src = `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
    }
  } else if (embedType === "vimeo") {
    const videoId = extractVimeoId(videoSource.url);
    if (videoId) {
      iframe.src = `https://player.vimeo.com/video/${videoId}?autoplay=${
        initialPlaying ? 1 : 0
      }&controls=0#t=${Math.floor(initialTime)}s`;
    }
  } else {
    iframe.src = videoSource.url;
  }

  frame.appendChild(iframe);

  // --- Controls bar (play / seek / time / status / fullscreen) ---
  const controls = document.createElement("div");
  controls.className = "video-player__controls";

  const playBtn = document.createElement("button");
  playBtn.className = "video-player__play-btn";
  playBtn.setAttribute("aria-label", "Play/Pause");

  const seekContainer = document.createElement("div");
  seekContainer.className = "video-player__seek-container";
  const seekBar = document.createElement("input");
  seekBar.type = "range";
  seekBar.className = "video-player__seek";
  seekBar.min = "0";
  seekBar.max = "100";
  seekBar.step = "0.1";
  seekBar.value = "0";
  seekContainer.appendChild(seekBar);

  const timeDisplay = document.createElement("span");
  timeDisplay.className = "video-player__time";
  timeDisplay.textContent = "0:00 / 0:00";

  const statusLabel = document.createElement("span");
  statusLabel.className = "video-player__embed-status";
  statusLabel.textContent =
    embedType === "youtube"
      ? "YouTube"
      : embedType === "vimeo"
      ? "Vimeo"
      : "Embedded";

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "video-player__fullscreen-btn";
  fullscreenBtn.setAttribute("aria-label", "Toggle Fullscreen");

  controls.appendChild(playBtn);
  controls.appendChild(seekContainer);
  controls.appendChild(timeDisplay);
  controls.appendChild(statusLabel);
  controls.appendChild(fullscreenBtn);

  container.appendChild(frame);
  container.appendChild(controls);

  let isSeeking = false;

  // --- Time helpers ---
  function formatTime(seconds: number): string {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${s
        .toString()
        .padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function updateTimeUI(): void {
    timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(
      duration
    )}`;
    if (!isSeeking && duration > 0) {
      seekBar.value = String((currentTime / duration) * 100);
    }
  }

  // --- Platform command senders ---
  function ytPost(func: string, args: unknown[] = []): void {
    iframe.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func, args }),
      "*"
    );
  }
  function vimeoPost(method: string, value?: unknown): void {
    iframe.contentWindow?.postMessage(
      JSON.stringify(value === undefined ? { method } : { method, value }),
      "*"
    );
  }

  function playEmbed(): void {
    if (embedType === "youtube") ytPost("playVideo");
    else if (embedType === "vimeo") vimeoPost("play");
    isPlaying = true;
    updatePlayIcon();
  }

  function pauseEmbed(): void {
    if (embedType === "youtube") ytPost("pauseVideo");
    else if (embedType === "vimeo") vimeoPost("pause");
    isPlaying = false;
    updatePlayIcon();
  }

  function seekEmbed(time: number): void {
    if (embedType === "youtube") ytPost("seekTo", [time, true]);
    else if (embedType === "vimeo") vimeoPost("setCurrentTime", time);
    currentTime = time;
    updateTimeUI();
  }

  function updatePlayIcon(): void {
    playBtn.innerHTML = isPlaying
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }

  function updateFullscreenIcon(): void {
    const isFs = document.fullscreenElement === container;
    fullscreenBtn.innerHTML = isFs
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
  }

  // --- Control interactions ---
  playBtn.addEventListener("click", () => {
    if (isPlaying) {
      pauseEmbed();
      wsClient.send({ type: "playback:pause" });
    } else {
      playEmbed();
      wsClient.send({ type: "playback:play" });
    }
  });

  seekBar.addEventListener("input", () => {
    isSeeking = true;
    if (duration > 0) {
      const t = (parseFloat(seekBar.value) / 100) * duration;
      timeDisplay.textContent = `${formatTime(t)} / ${formatTime(duration)}`;
    }
  });

  seekBar.addEventListener("change", () => {
    if (duration > 0) {
      const t = (parseFloat(seekBar.value) / 100) * duration;
      seekEmbed(t);
      wsClient.send({ type: "playback:seek", position: t });
    }
    isSeeking = false;
  });

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement === container) {
      document.exitFullscreen().catch(() => {});
    } else {
      container.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", updateFullscreenIcon);

  // --- Handshake so platforms send us timestamps & accept commands ---
  function startHandshake(): void {
    if (embedType === "youtube") {
      // Tell the YT player we are listening; it then streams infoDelivery events.
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
        "*"
      );
    } else if (embedType === "vimeo") {
      vimeoPost("addEventListener", "timeupdate");
      vimeoPost("addEventListener", "play");
      vimeoPost("addEventListener", "pause");
      vimeoPost("getDuration");
    }
  }

  iframe.addEventListener("load", () => {
    // A couple of nudges; YT occasionally misses the first handshake.
    startHandshake();
    setTimeout(startHandshake, 500);
    setTimeout(startHandshake, 1500);
  });

  // --- Inbound platform events ---
  function handlePostMessage(event: MessageEvent): void {
    let data: any;
    try {
      data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data) return;

    // YouTube
    if (data.event === "onStateChange" || data.info?.playerState !== undefined) {
      const state =
        typeof data.info === "number" ? data.info : data.info?.playerState;
      if (state === 1) {
        isPlaying = true;
        updatePlayIcon();
      } else if (state === 2 || state === 0) {
        isPlaying = false;
        updatePlayIcon();
      }
    }
    if (data.event === "infoDelivery" && data.info) {
      if (typeof data.info.currentTime === "number") {
        currentTime = data.info.currentTime;
        lastInfoAt = Date.now();
      }
      if (typeof data.info.duration === "number" && data.info.duration > 0) {
        duration = data.info.duration;
      }
      updateTimeUI();
    }

    // Vimeo
    if (data.event === "timeupdate" && data.data) {
      if (typeof data.data.seconds === "number") {
        currentTime = data.data.seconds;
        lastInfoAt = Date.now();
      }
      if (typeof data.data.duration === "number") {
        duration = data.data.duration;
      }
      updateTimeUI();
    }
    if (data.event === "play") {
      isPlaying = true;
      updatePlayIcon();
    }
    if (data.event === "pause") {
      isPlaying = false;
      updatePlayIcon();
    }
    if (data.method === "getDuration" && typeof data.value === "number") {
      duration = data.value;
      updateTimeUI();
    }
  }
  window.addEventListener("message", handlePostMessage);

  // Coarse fallback: if the platform hasn't reported a timestamp recently,
  // advance our own clock so heartbeats/seek bar still move while playing.
  const ticker = setInterval(() => {
    if (isPlaying && Date.now() - lastInfoAt > 1500) {
      currentTime += 0.5;
      updateTimeUI();
    }
  }, 500);

  updatePlayIcon();
  updateFullscreenIcon();
  updateTimeUI();

  function destroy(): void {
    window.removeEventListener("message", handlePostMessage);
    document.removeEventListener("fullscreenchange", updateFullscreenIcon);
    clearInterval(ticker);
    iframe.src = "";
  }

  return {
    element: container,
    getVideoElement: () => virtualVideo,
    destroy,
  };
}

/**
 * Determine if a URL should use the embedded player.
 */
export function isEmbeddedSource(url: string): boolean {
  return /youtube\.com|youtu\.be|vimeo\.com/i.test(url);
}
