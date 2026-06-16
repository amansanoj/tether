/**
 * Video Player component.
 * Supports direct video URLs (mp4, webm) and HLS (.m3u8) via native playback.
 * Provides play/pause, seek, volume, time display, buffering indicator, fullscreen.
 *
 * Multi-language support: a single (muted) video can be paired with separate
 * audio tracks. The active audio track plays in a parallel <audio> element kept
 * locked to the video clock, so one video file + small audio files cover every
 * language. Audio selection is per-person (local only, not broadcast).
 *
 * NOTE: HLS (.m3u8) only works natively in Safari without hls.js.
 */

import { WsClient } from "../lib/ws";

interface AudioTrack {
  label: string;
  url: string;
}

interface PlayerOptions {
  videoSource: { type: string; url: string; label?: string };
  wsClient: WsClient;
  initialPlaying: boolean;
  initialTime: number;
  audioTracks?: AudioTrack[];
  linkedRoom?: { code: string; label: string } | null;
  onSwitchRoom?: (code: string) => void;
}

export function createPlayer(options: PlayerOptions): {
  element: HTMLElement;
  getVideoElement: () => HTMLVideoElement | null;
  destroy: () => void;
} {
  const {
    videoSource,
    wsClient,
    initialPlaying,
    initialTime,
    audioTracks = [],
    linkedRoom = null,
    onSwitchRoom,
  } = options;

  const container = document.createElement("div");
  container.className = "video-player video-player--active";

  // Video element
  const video = document.createElement("video");
  video.className = "video-player__video";
  video.preload = "auto";
  video.playsInline = true;
  video.src = videoSource.url;
  if (initialTime > 0) video.currentTime = initialTime;

  // Parallel audio element for language tracks (created when first needed)
  let audioEl: HTMLAudioElement | null = null;
  // -1 = original (video's own audio); 0..n = audioTracks index
  let currentTrackIndex = -1;
  let userVolume = 1;
  let userMuted = false;

  // Buffering overlay
  const bufferingOverlay = document.createElement("div");
  bufferingOverlay.className = "video-player__buffering";
  bufferingOverlay.innerHTML = `<div class="video-player__spinner"></div>`;
  bufferingOverlay.style.display = "none";

  // Controls bar
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

  // Language menu (only when there are audio tracks or a linked room)
  const hasLanguageOptions = audioTracks.length > 0 || !!linkedRoom;
  const langWrap = document.createElement("div");
  langWrap.className = "video-player__lang";
  const langBtn = document.createElement("button");
  langBtn.className = "video-player__lang-btn";
  langBtn.setAttribute("aria-label", "Audio / language");
  langBtn.innerHTML = `<i class="ph-duotone ph-translate"></i>`;
  const langMenu = document.createElement("div");
  langMenu.className = "video-player__lang-menu";
  langMenu.style.display = "none";
  langWrap.appendChild(langBtn);
  langWrap.appendChild(langMenu);

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "video-player__fullscreen-btn";
  fullscreenBtn.setAttribute("aria-label", "Toggle Fullscreen");

  controls.appendChild(playBtn);
  controls.appendChild(seekContainer);
  controls.appendChild(timeDisplay);
  controls.appendChild(volumeContainer);
  if (hasLanguageOptions) controls.appendChild(langWrap);
  controls.appendChild(fullscreenBtn);

  container.appendChild(video);
  container.appendChild(bufferingOverlay);
  container.appendChild(controls);

  // --- State ---
  let isSeeking = false;

  function activeOutput(): HTMLMediaElement {
    return currentTrackIndex >= 0 && audioEl ? audioEl : video;
  }

  // --- Icon helpers ---
  function updatePlayIcon(): void {
    playBtn.innerHTML = !video.paused
      ? `<i class="ph-duotone ph-pause"></i>`
      : `<i class="ph-duotone ph-play"></i>`;
  }

  function updateVolumeIcon(): void {
    if (userMuted || userVolume === 0) {
      volumeBtn.innerHTML = `<i class="ph-duotone ph-speaker-x"></i>`;
    } else if (userVolume < 0.5) {
      volumeBtn.innerHTML = `<i class="ph-duotone ph-speaker-low"></i>`;
    } else {
      volumeBtn.innerHTML = `<i class="ph-duotone ph-speaker-high"></i>`;
    }
  }

  function updateFullscreenIcon(): void {
    fullscreenBtn.innerHTML =
      document.fullscreenElement === container
        ? `<i class="ph-duotone ph-arrows-in"></i>`
        : `<i class="ph-duotone ph-arrows-out"></i>`;
  }

  function formatTime(seconds: number): string {
    if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function updateTimeDisplay(): void {
    timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  }

  function updateSeekBar(): void {
    if (isSeeking) return;
    if (video.duration && isFinite(video.duration)) {
      seekBar.value = ((video.currentTime / video.duration) * 100).toString();
    }
  }

  // --- Volume routing (applies to whichever output is active) ---
  function applyVolume(): void {
    const out = activeOutput();
    // When a separate audio track is active, the video stays muted.
    if (currentTrackIndex >= 0 && audioEl) {
      video.muted = true;
      audioEl.volume = userVolume;
      audioEl.muted = userMuted;
    } else {
      video.volume = userVolume;
      video.muted = userMuted;
    }
    void out;
    updateVolumeIcon();
  }

  // --- Audio track sync ---
  function ensureAudioEl(): HTMLAudioElement {
    if (audioEl) return audioEl;
    const el = document.createElement("audio");
    el.preload = "auto";
    audioEl = el;

    // Keep the audio element locked to the video clock.
    const resync = () => {
      if (currentTrackIndex < 0 || !audioEl) return;
      if (Math.abs(audioEl.currentTime - video.currentTime) > 0.25) {
        audioEl.currentTime = video.currentTime;
      }
    };
    video.addEventListener("timeupdate", () => {
      if (currentTrackIndex < 0 || !audioEl) return;
      resync();
      if (!video.paused && audioEl.paused) audioEl.play().catch(() => {});
    });
    video.addEventListener("seeking", () => {
      if (currentTrackIndex < 0 || !audioEl) return;
      audioEl.currentTime = video.currentTime;
    });
    video.addEventListener("seeked", () => {
      if (currentTrackIndex < 0 || !audioEl) return;
      audioEl.currentTime = video.currentTime;
      if (!video.paused) audioEl.play().catch(() => {});
    });
    video.addEventListener("ratechange", () => {
      if (audioEl) audioEl.playbackRate = video.playbackRate;
    });
    return el;
  }

  function selectTrack(index: number): void {
    currentTrackIndex = index;
    if (index >= 0) {
      const track = audioTracks[index];
      const el = ensureAudioEl();
      if (el.src !== track.url) el.src = track.url;
      video.muted = true;
      el.currentTime = video.currentTime;
      el.playbackRate = video.playbackRate;
      if (!video.paused) el.play().catch(() => {});
    } else {
      // Original audio: stop the parallel track, unmute the video
      if (audioEl) {
        audioEl.pause();
      }
    }
    applyVolume();
    renderLangMenu();
  }

  // --- Language menu ---
  function renderLangMenu(): void {
    let html = "";
    if (audioTracks.length > 0) {
      html += `<div class="lang-menu__section">Audio</div>`;
      html += `<button type="button" class="lang-menu__item ${currentTrackIndex === -1 ? "lang-menu__item--active" : ""}" data-track="-1">Original</button>`;
      audioTracks.forEach((t, i) => {
        html += `<button type="button" class="lang-menu__item ${currentTrackIndex === i ? "lang-menu__item--active" : ""}" data-track="${i}">${escapeHtml(t.label)}</button>`;
      });
    }
    if (linkedRoom) {
      html += `<div class="lang-menu__section">Other video</div>`;
      html += `<button type="button" class="lang-menu__item lang-menu__item--link" data-switch="${linkedRoom.code}">${escapeHtml(linkedRoom.label)} →</button>`;
    }
    langMenu.innerHTML = html;
  }

  function escapeHtml(text: string): string {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }

  langBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    langMenu.style.display = langMenu.style.display === "none" ? "block" : "none";
  });
  langMenu.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".lang-menu__item") as HTMLElement | null;
    if (!item) return;
    if (item.dataset.switch) {
      onSwitchRoom?.(item.dataset.switch);
    } else if (item.dataset.track !== undefined) {
      selectTrack(parseInt(item.dataset.track, 10));
    }
    langMenu.style.display = "none";
  });
  const closeLangMenu = (e: MouseEvent) => {
    if (!langWrap.contains(e.target as Node)) langMenu.style.display = "none";
  };
  document.addEventListener("click", closeLangMenu);

  // --- Playback controls ---
  function togglePlay(): void {
    if (video.paused) {
      video.play().catch(() => {});
      wsClient.send({ type: "playback:play" });
    } else {
      video.pause();
      wsClient.send({ type: "playback:pause" });
    }
  }

  playBtn.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);

  seekBar.addEventListener("input", () => {
    isSeeking = true;
    if (video.duration && isFinite(video.duration)) {
      const time = (parseFloat(seekBar.value) / 100) * video.duration;
      timeDisplay.textContent = `${formatTime(time)} / ${formatTime(video.duration)}`;
    }
  });
  seekBar.addEventListener("change", () => {
    if (video.duration && isFinite(video.duration)) {
      const time = (parseFloat(seekBar.value) / 100) * video.duration;
      video.currentTime = time;
      wsClient.send({ type: "playback:seek", position: time });
    }
    isSeeking = false;
  });

  volumeBtn.addEventListener("click", () => {
    userMuted = !userMuted;
    applyVolume();
  });
  volumeSlider.addEventListener("input", () => {
    userVolume = parseFloat(volumeSlider.value);
    userMuted = false;
    applyVolume();
  });

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement === container) {
      document.exitFullscreen().catch(() => {});
    } else {
      container.requestFullscreen().catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", updateFullscreenIcon);

  // Video events
  video.addEventListener("play", () => {
    updatePlayIcon();
    if (currentTrackIndex >= 0 && audioEl) audioEl.play().catch(() => {});
  });
  video.addEventListener("pause", () => {
    updatePlayIcon();
    if (currentTrackIndex >= 0 && audioEl) audioEl.pause();
  });
  video.addEventListener("timeupdate", () => {
    updateTimeDisplay();
    updateSeekBar();
  });
  video.addEventListener("loadedmetadata", () => {
    updateTimeDisplay();
    if (initialTime > 0) video.currentTime = initialTime;
  });
  video.addEventListener("waiting", () => {
    bufferingOverlay.style.display = "flex";
    if (currentTrackIndex >= 0 && audioEl) audioEl.pause();
  });
  video.addEventListener("canplay", () => {
    bufferingOverlay.style.display = "none";
  });
  video.addEventListener("playing", () => {
    bufferingOverlay.style.display = "none";
    if (currentTrackIndex >= 0 && audioEl && !video.paused) {
      audioEl.currentTime = video.currentTime;
      audioEl.play().catch(() => {});
    }
  });

  // Initialize
  updatePlayIcon();
  updateVolumeIcon();
  updateFullscreenIcon();
  renderLangMenu();

  // Default to the first audio track if any are provided
  if (audioTracks.length > 0) {
    selectTrack(0);
  }

  if (initialPlaying) {
    video.play().catch(() => {});
  }

  function destroy(): void {
    video.pause();
    video.src = "";
    if (audioEl) {
      audioEl.pause();
      audioEl.src = "";
      audioEl = null;
    }
    document.removeEventListener("fullscreenchange", updateFullscreenIcon);
    document.removeEventListener("click", closeLangMenu);
  }

  return {
    element: container,
    getVideoElement: () => video,
    destroy,
  };
}
