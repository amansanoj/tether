/**
 * Video Player component.
 * Supports direct video URLs (mp4, webm) and HLS (.m3u8) via native playback.
 * Provides play/pause, seek, volume, time display, buffering indicator, and fullscreen.
 * Emits playback commands over the WebSocket for sync.
 *
 * NOTE: HLS (.m3u8) only works natively in Safari. For Chrome/Firefox, hls.js would
 * be needed but is unavailable (no npm packages). Direct video URLs (mp4, webm) work
 * everywhere. When packages can be installed, add hls.js for cross-browser HLS support.
 */

import { WsClient } from "../lib/ws";

interface PlayerOptions {
  videoSource: { type: string; url: string };
  wsClient: WsClient;
  initialPlaying: boolean;
  initialTime: number;
}

export function createPlayer(options: PlayerOptions): {
  element: HTMLElement;
  getVideoElement: () => HTMLVideoElement | null;
  destroy: () => void;
} {
  const { videoSource, wsClient, initialPlaying, initialTime } = options;

  const container = document.createElement("div");
  container.className = "video-player video-player--active";

  // Video element
  const video = document.createElement("video");
  video.className = "video-player__video";
  video.preload = "auto";
  video.playsInline = true;
  video.src = videoSource.url;

  // Set initial time
  if (initialTime > 0) {
    video.currentTime = initialTime;
  }

  // Buffering overlay
  const bufferingOverlay = document.createElement("div");
  bufferingOverlay.className = "video-player__buffering";
  bufferingOverlay.innerHTML = `
    <div class="video-player__spinner"></div>
  `;
  bufferingOverlay.style.display = "none";

  // Controls bar
  const controls = document.createElement("div");
  controls.className = "video-player__controls";

  // Play/pause button
  const playBtn = document.createElement("button");
  playBtn.className = "video-player__play-btn";
  playBtn.setAttribute("aria-label", "Play/Pause");

  // Seek bar
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

  // Time display
  const timeDisplay = document.createElement("span");
  timeDisplay.className = "video-player__time";
  timeDisplay.textContent = "0:00 / 0:00";

  // Volume controls
  const volumeContainer = document.createElement("div");
  volumeContainer.className = "video-player__volume";
  const volumeBtn = document.createElement("button");
  volumeBtn.className = "video-player__volume-btn";
  volumeBtn.setAttribute("aria-label", "Mute/Unmute");
  const volumeSlider = document.createElement("input");
  volumeSlider.type = "range";
  volumeSlider.className = "video-player__volume-slider";
  volumeSlider.min = "0";
  volumeSlider.max = "1";
  volumeSlider.step = "0.05";
  volumeSlider.value = "1";
  volumeContainer.appendChild(volumeBtn);
  volumeContainer.appendChild(volumeSlider);

  // Fullscreen button
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "video-player__fullscreen-btn";
  fullscreenBtn.setAttribute("aria-label", "Toggle Fullscreen");

  // Assemble controls
  controls.appendChild(playBtn);
  controls.appendChild(seekContainer);
  controls.appendChild(timeDisplay);
  controls.appendChild(volumeContainer);
  controls.appendChild(fullscreenBtn);

  // Assemble container
  container.appendChild(video);
  container.appendChild(bufferingOverlay);
  container.appendChild(controls);

  // --- State ---
  let isSeeking = false;
  let userInitiatedAction = false;

  // --- Icon helpers ---
  function updatePlayIcon(): void {
    const playing = !video.paused;
    playBtn.innerHTML = playing
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
  }

  function updateVolumeIcon(): void {
    const vol = video.volume;
    const muted = video.muted;
    if (muted || vol === 0) {
      volumeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
    } else if (vol < 0.5) {
      volumeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    } else {
      volumeBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
    }
  }

  function updateFullscreenIcon(): void {
    const isFs = document.fullscreenElement === container;
    fullscreenBtn.innerHTML = isFs
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
  }

  // --- Time formatting ---
  function formatTime(seconds: number): string {
    if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }

  function updateTimeDisplay(): void {
    const current = formatTime(video.currentTime);
    const duration = formatTime(video.duration);
    timeDisplay.textContent = `${current} / ${duration}`;
  }

  function updateSeekBar(): void {
    if (isSeeking) return;
    if (video.duration && isFinite(video.duration)) {
      const pct = (video.currentTime / video.duration) * 100;
      seekBar.value = pct.toString();
    }
  }

  // --- Event handlers ---

  // Play/Pause button click
  playBtn.addEventListener("click", () => {
    userInitiatedAction = true;
    if (video.paused) {
      video.play().catch(() => {});
      wsClient.send({ type: "playback:play" });
    } else {
      video.pause();
      wsClient.send({ type: "playback:pause" });
    }
  });

  // Seek bar interaction
  seekBar.addEventListener("input", () => {
    isSeeking = true;
    const pct = parseFloat(seekBar.value);
    if (video.duration && isFinite(video.duration)) {
      const time = (pct / 100) * video.duration;
      timeDisplay.textContent = `${formatTime(time)} / ${formatTime(video.duration)}`;
    }
  });

  seekBar.addEventListener("change", () => {
    const pct = parseFloat(seekBar.value);
    if (video.duration && isFinite(video.duration)) {
      const time = (pct / 100) * video.duration;
      video.currentTime = time;
      userInitiatedAction = true;
      wsClient.send({ type: "playback:seek", position: time });
    }
    isSeeking = false;
  });

  // Volume
  volumeBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    updateVolumeIcon();
  });

  volumeSlider.addEventListener("input", () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = false;
    updateVolumeIcon();
  });

  // Fullscreen
  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement === container) {
      document.exitFullscreen().catch(() => {});
    } else {
      container.requestFullscreen().catch(() => {});
    }
  });

  document.addEventListener("fullscreenchange", updateFullscreenIcon);

  // Video events
  video.addEventListener("play", updatePlayIcon);
  video.addEventListener("pause", updatePlayIcon);
  video.addEventListener("timeupdate", () => {
    updateTimeDisplay();
    updateSeekBar();
  });
  video.addEventListener("loadedmetadata", () => {
    updateTimeDisplay();
    if (initialTime > 0) {
      video.currentTime = initialTime;
    }
  });
  video.addEventListener("waiting", () => {
    bufferingOverlay.style.display = "flex";
  });
  video.addEventListener("canplay", () => {
    bufferingOverlay.style.display = "none";
  });
  video.addEventListener("playing", () => {
    bufferingOverlay.style.display = "none";
  });

  // Click on video to toggle play/pause
  video.addEventListener("click", () => {
    userInitiatedAction = true;
    if (video.paused) {
      video.play().catch(() => {});
      wsClient.send({ type: "playback:play" });
    } else {
      video.pause();
      wsClient.send({ type: "playback:pause" });
    }
  });

  // Initialize icons
  updatePlayIcon();
  updateVolumeIcon();
  updateFullscreenIcon();

  // Auto-play if initial state is playing
  if (initialPlaying) {
    video.play().catch(() => {});
  }

  // Cleanup
  function destroy(): void {
    video.pause();
    video.src = "";
    document.removeEventListener("fullscreenchange", updateFullscreenIcon);
  }

  return {
    element: container,
    getVideoElement: () => video,
    destroy,
  };
}
