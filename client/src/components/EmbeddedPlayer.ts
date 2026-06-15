/**
 * Embedded Player component for YouTube and Vimeo.
 * Uses iframe with postMessage API for playback control and sync.
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

  const iframe = document.createElement("iframe");
  iframe.className = "video-player__iframe";
  iframe.setAttribute("allowfullscreen", "true");
  iframe.setAttribute("allow", "autoplay; encrypted-media; fullscreen");
  iframe.frameBorder = "0";

  // Internal time tracking (approximate, based on postMessage responses)
  let currentTime = initialTime;
  let isPlaying = initialPlaying;
  let duration = 0;

  // Virtual video element for sync engine compatibility
  // The sync engine uses getVideoElement(), but for embeds we need a proxy.
  // We create a hidden video element that mirrors the embed state for heartbeat reporting.
  const virtualVideo = document.createElement("video");
  virtualVideo.preload = "none";
  // Keep virtual video in sync
  Object.defineProperty(virtualVideo, "currentTime", {
    get: () => currentTime,
    set: (val: number) => {
      currentTime = val;
      seekEmbed(val);
    },
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
    set: () => {}, // Embeds don't support playback rate changes
    configurable: true,
  });
  virtualVideo.play = async () => {
    playEmbed();
  };
  virtualVideo.pause = () => {
    pauseEmbed();
  };

  // Setup embed URL
  if (embedType === "youtube") {
    const videoId = extractYouTubeId(videoSource.url);
    if (videoId) {
      iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=${initialPlaying ? 1 : 0}&start=${Math.floor(initialTime)}&origin=${window.location.origin}`;
    }
  } else if (embedType === "vimeo") {
    const videoId = extractVimeoId(videoSource.url);
    if (videoId) {
      iframe.src = `https://player.vimeo.com/video/${videoId}?autoplay=${initialPlaying ? 1 : 0}#t=${Math.floor(initialTime)}s`;
    }
  } else {
    // Fallback: just embed the URL directly
    iframe.src = videoSource.url;
  }

  // Controls bar for embedded player
  const controls = document.createElement("div");
  controls.className = "video-player__controls video-player__controls--embed";

  const playBtn = document.createElement("button");
  playBtn.className = "video-player__play-btn";
  playBtn.setAttribute("aria-label", "Play/Pause");

  const statusLabel = document.createElement("span");
  statusLabel.className = "video-player__embed-status";
  statusLabel.textContent = embedType === "youtube" ? "YouTube" : embedType === "vimeo" ? "Vimeo" : "Embedded";

  controls.appendChild(playBtn);
  controls.appendChild(statusLabel);

  container.appendChild(iframe);
  container.appendChild(controls);

  // --- PostMessage communication ---
  function playEmbed(): void {
    if (embedType === "youtube") {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "playVideo", args: [] }),
        "*"
      );
    } else if (embedType === "vimeo") {
      iframe.contentWindow?.postMessage(JSON.stringify({ method: "play" }), "*");
    }
    isPlaying = true;
    updatePlayIcon();
  }

  function pauseEmbed(): void {
    if (embedType === "youtube") {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
        "*"
      );
    } else if (embedType === "vimeo") {
      iframe.contentWindow?.postMessage(JSON.stringify({ method: "pause" }), "*");
    }
    isPlaying = false;
    updatePlayIcon();
  }

  function seekEmbed(time: number): void {
    if (embedType === "youtube") {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func: "seekTo", args: [time, true] }),
        "*"
      );
    } else if (embedType === "vimeo") {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ method: "setCurrentTime", value: time }),
        "*"
      );
    }
    currentTime = time;
  }

  function updatePlayIcon(): void {
    playBtn.innerHTML = isPlaying
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }

  // Play/pause button
  playBtn.addEventListener("click", () => {
    if (isPlaying) {
      pauseEmbed();
      wsClient.send({ type: "playback:pause" });
    } else {
      playEmbed();
      wsClient.send({ type: "playback:play" });
    }
  });

  // Listen for postMessage events from embeds
  function handlePostMessage(event: MessageEvent): void {
    let data: any;
    try {
      data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }

    // YouTube events
    if (data?.event === "onStateChange") {
      // YouTube states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering
      if (data.info === 1) {
        isPlaying = true;
        updatePlayIcon();
      } else if (data.info === 2 || data.info === 0) {
        isPlaying = false;
        updatePlayIcon();
      }
    }

    if (data?.event === "infoDelivery" && data.info?.currentTime !== undefined) {
      currentTime = data.info.currentTime;
    }

    // Vimeo events
    if (data?.event === "playProgress" || data?.method === "getCurrentTime") {
      if (data?.data?.seconds !== undefined) {
        currentTime = data.data.seconds;
      }
    }
  }

  window.addEventListener("message", handlePostMessage);

  // Time tracking interval for heartbeat
  const timeTracker = setInterval(() => {
    if (isPlaying) {
      currentTime += 1;
    }
  }, 1000);

  // Initialize
  updatePlayIcon();

  function destroy(): void {
    window.removeEventListener("message", handlePostMessage);
    clearInterval(timeTracker);
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
