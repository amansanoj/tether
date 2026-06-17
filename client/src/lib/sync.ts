/**
 * Client-side sync engine.
 * Listens to playback:update, sync:adjust, and playback:force-resync from the server.
 * Sends heartbeat messages every 2 seconds with current playback position.
 */

import { WsClient } from "./ws";

interface SyncOptions {
  wsClient: WsClient;
  getVideoElement: () => HTMLVideoElement | null;
}

export class SyncEngine {
  private wsClient: WsClient;
  private getVideoElement: () => HTMLVideoElement | null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribers: Array<() => void> = [];
  private lastAppliedRate = 1;

  constructor(options: SyncOptions) {
    this.wsClient = options.wsClient;
    this.getVideoElement = options.getVideoElement;
  }

  /** Start the sync engine: subscribe to messages and start heartbeat */
  start(): void {
    // Listen for playback:update
    this.unsubscribers.push(
      this.wsClient.on("playback:update", (msg) => {
        this.handlePlaybackUpdate(msg);
      })
    );

    // Listen for sync:adjust
    this.unsubscribers.push(
      this.wsClient.on("sync:adjust", (msg) => {
        this.handleSyncAdjust(msg);
      })
    );

    // Listen for playback:force-resync
    this.unsubscribers.push(
      this.wsClient.on("playback:force-resync", (msg) => {
        this.handleForceResync(msg);
      })
    );

    // Start heartbeat every 2 seconds
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 2000);
  }

  /** Stop the sync engine: unsubscribe and stop heartbeat */
  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private handlePlaybackUpdate(msg: any): void {
    const video = this.getVideoElement();
    if (!video) return;

    if (msg.isPlaying) {
      // Seek to the correct position if we're too far off
      const drift = Math.abs(video.currentTime - msg.position);
      if (drift > 2) {
        video.currentTime = msg.position;
      }
      if (video.paused) {
        video.play().catch(() => {});
      }
    } else {
      if (!video.paused) {
        video.pause();
      }
      video.currentTime = msg.position;
    }
  }

  private handleSyncAdjust(msg: any): void {
    const video = this.getVideoElement();
    if (!video) return;

    const rate = msg.suggestedRate;
    if (typeof rate === "number" && rate >= 0.5 && rate <= 2.0) {
      video.playbackRate = rate;
      this.lastAppliedRate = rate;
    }
  }

  private handleForceResync(msg: any): void {
    const video = this.getVideoElement();
    if (!video) return;

    // Hard seek to the specified position
    video.currentTime = msg.position;
    // Reset playback rate to 1
    video.playbackRate = 1;
    this.lastAppliedRate = 1;
  }

  private sendHeartbeat(): void {
    const video = this.getVideoElement();
    if (!video) return;

    this.wsClient.send({
      type: "heartbeat",
      position: video.currentTime,
      isBuffering: video.readyState < 3,
      clientTime: Date.now(),
      duration: isFinite(video.duration) ? video.duration : 0,
    });
  }
}
