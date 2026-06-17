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
  linkedRoom?: { code: string; label: string } | null;
  onSwitchRoom?: (code: string) => void;
  onEnded?: () => void;
}

type EmbedType = "youtube" | "vimeo" | "unknown";

function detectEmbedType(url: string): EmbedType {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  return "unknown";
}

function extractYouTubeId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
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
  const { videoSource, wsClient, initialPlaying, initialTime, linkedRoom = null, onSwitchRoom, onEnded } =
    options;
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
  let endedFired = false;

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

  const rewindBtn = document.createElement("button");
  rewindBtn.className = "video-player__skip-btn";
  rewindBtn.setAttribute("aria-label", "Rewind 10 seconds");
  rewindBtn.innerHTML = `<i class="ph-duotone ph-arrow-counter-clockwise"></i>`;

  const forwardBtn = document.createElement("button");
  forwardBtn.className = "video-player__skip-btn";
  forwardBtn.setAttribute("aria-label", "Forward 10 seconds");
  forwardBtn.innerHTML = `<i class="ph-duotone ph-arrow-clockwise"></i>`;

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

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "video-player__fullscreen-btn";
  fullscreenBtn.setAttribute("aria-label", "Toggle Fullscreen");

  controls.appendChild(rewindBtn);
  controls.appendChild(playBtn);
  controls.appendChild(forwardBtn);
  controls.appendChild(seekContainer);
  controls.appendChild(timeDisplay);

  // Linked-room (second video) switcher
  let closeLangMenu: ((e: MouseEvent) => void) | null = null;
  if (linkedRoom) {
    const langWrap = document.createElement("div");
    langWrap.className = "video-player__lang";
    const langBtn = document.createElement("button");
    langBtn.className = "video-player__lang-btn";
    langBtn.setAttribute("aria-label", "Switch video");
    langBtn.innerHTML = `<i class="ph-duotone ph-translate"></i>`;
    const langMenu = document.createElement("div");
    langMenu.className = "video-player__lang-menu";
    langMenu.style.display = "none";
    const safeLabel = (() => {
      const d = document.createElement("div");
      d.textContent = linkedRoom.label;
      return d.innerHTML;
    })();
    langMenu.innerHTML = `
      <div class="lang-menu__section">Other video</div>
      <button type="button" class="lang-menu__item lang-menu__item--link" data-switch="${linkedRoom.code}">${safeLabel} →</button>
    `;
    langWrap.appendChild(langBtn);
    langWrap.appendChild(langMenu);
    langBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      langMenu.style.display = langMenu.style.display === "none" ? "block" : "none";
    });
    langMenu.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest(".lang-menu__item") as HTMLElement | null;
      if (item?.dataset.switch) onSwitchRoom?.(item.dataset.switch);
      langMenu.style.display = "none";
    });
    closeLangMenu = (e: MouseEvent) => {
      if (!langWrap.contains(e.target as Node)) langMenu.style.display = "none";
    };
    document.addEventListener("click", closeLangMenu);
    controls.appendChild(langWrap);
  }

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
    endedFired = false;
    updateTimeUI();
  }

  // Fire the end-of-track callback exactly once.
  function fireEnded(): void {
    if (endedFired) return;
    endedFired = true;
    isPlaying = false;
    updatePlayIcon();
    onEnded?.();
  }

  function updatePlayIcon(): void {
    playBtn.innerHTML = isPlaying
      ? `<i class="ph-duotone ph-pause"></i>`
      : `<i class="ph-duotone ph-play"></i>`;
  }

  function updateFullscreenIcon(): void {
    const isFs = document.fullscreenElement === container;
    fullscreenBtn.innerHTML = isFs
      ? `<i class="ph-duotone ph-arrows-in"></i>`
      : `<i class="ph-duotone ph-arrows-out"></i>`;
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

  function skip(delta: number): void {
    let t = currentTime + delta;
    if (t < 0) t = 0;
    if (duration > 0 && t > duration) t = duration;
    seekEmbed(t);
    wsClient.send({ type: "playback:seek", position: t });
  }
  rewindBtn.addEventListener("click", () => skip(-10));
  forwardBtn.addEventListener("click", () => skip(10));

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
    const doc = document as any;
    const cont = container as any;
    const fsEl = document.fullscreenElement || doc.webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen || doc.webkitExitFullscreen)?.call(document);
      return;
    }
    if (container.requestFullscreen) {
      container.requestFullscreen().catch(() => {});
    } else if (cont.webkitRequestFullscreen) {
      cont.webkitRequestFullscreen();
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
      vimeoPost("addEventListener", "ended");
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
        endedFired = false;
        updatePlayIcon();
      } else if (state === 2 || state === 0) {
        isPlaying = false;
        updatePlayIcon();
        // state 0 = ended. Also treat a "paused" landing within ~2s of the end
        // as ended, since the reported time often stalls short of the duration.
        if (state === 0 || (duration > 0 && currentTime >= duration - 2)) {
          fireEnded();
        }
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
    if (data.event === "ended" || data.event === "finish") {
      fireEnded();
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
    // Reliable end detection: platforms often stall the reported time ~1s short
    // of the real duration and don't always emit a clean "ended" event, so use
    // a generous tolerance.
    if (isPlaying && duration > 0 && currentTime >= duration - 1.5) {
      fireEnded();
    }
  }, 500);

  updatePlayIcon();
  updateFullscreenIcon();
  updateTimeUI();

  function destroy(): void {
    window.removeEventListener("message", handlePostMessage);
    document.removeEventListener("fullscreenchange", updateFullscreenIcon);
    if (closeLangMenu) document.removeEventListener("click", closeLangMenu);
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
