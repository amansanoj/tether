/**
 * WebSocket client for Tether.
 * Handles connection lifecycle, reconnection with exponential backoff,
 * JSON message serialization/deserialization, ping/pong, and event dispatching.
 */

import { connectionStore } from "../stores/connection";
import { roomStore, type Participant } from "../stores/room";

type MessageHandler = (data: any) => void;

interface WsClientOptions {
  roomCode: string;
  displayName: string;
}

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export class WsClient {
  private ws: WebSocket | null = null;
  private options: WsClientOptions;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private joined = false;

  constructor(options: WsClientOptions) {
    this.options = options;
  }

  /** Connect to the WebSocket server */
  connect(): void {
    this.intentionalClose = false;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      connectionStore.setStatus("connected");

      // Send join message
      this.send({
        type: "join",
        roomCode: this.options.roomCode,
        displayName: this.options.displayName,
      });
      this.joined = true;
    });

    this.ws.addEventListener("message", (event) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener("close", () => {
      this.ws = null;
      if (!this.intentionalClose) {
        connectionStore.setStatus("reconnecting");
        this.scheduleReconnect();
      } else {
        connectionStore.setStatus("disconnected");
      }
    });

    this.ws.addEventListener("error", () => {
      // Error events are followed by close events, so reconnect logic is handled in close
    });
  }

  /** Send a message object as JSON */
  send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Register a handler for a specific message type */
  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /** Disconnect intentionally (no reconnection) */
  disconnect(): void {
    this.intentionalClose = true;
    this.joined = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    connectionStore.setStatus("disconnected");
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;

    // Handle ping/pong automatically
    if (msg.type === "ping") {
      this.send({ type: "pong", serverTime: msg.serverTime });
      return;
    }

    // Handle kicked - disconnect without reconnecting
    if (msg.type === "kicked") {
      this.intentionalClose = true;
      this.ws?.close();
      connectionStore.setStatus("disconnected");
      this.emit("kicked", msg);
      return;
    }

    // Handle room:state - update the room store
    if (msg.type === "room:state") {
      this.handleRoomState(msg);
    }

    // Handle participant events
    if (msg.type === "room:participant-joined") {
      this.handleParticipantJoined(msg);
    }
    if (msg.type === "room:participant-left") {
      this.handleParticipantLeft(msg);
    }

    // Handle playback updates - update room store playback
    if (msg.type === "playback:update") {
      roomStore.updatePlayback({
        playing: msg.isPlaying,
        currentTime: msg.position,
        playbackRate: roomStore.getState()?.playbackState.playbackRate ?? 1,
      });
    }

    // Emit to listeners
    this.emit(msg.type, msg);
  }

  private handleRoomState(msg: any): void {
    const state = roomStore.getState();
    if (!state) return;

    const participants: Participant[] = (msg.participants || []).map((p: any) => ({
      id: p.id,
      displayName: p.displayName,
      isHost: p.id === msg.room?.hostId,
    }));

    roomStore.setState({
      ...state,
      videoSource: msg.room?.videoSource || state.videoSource,
      participants,
      playbackState: {
        playing: msg.playbackState?.isPlaying ?? false,
        currentTime: msg.playbackState?.position ?? 0,
        playbackRate: 1,
      },
    });
  }

  private handleParticipantJoined(msg: any): void {
    const state = roomStore.getState();
    if (!state) return;
    const existing = state.participants.find((p) => p.id === msg.participant.id);
    if (!existing) {
      roomStore.setParticipants([
        ...state.participants,
        {
          id: msg.participant.id,
          displayName: msg.participant.displayName,
          isHost: false,
        },
      ]);
    }
  }

  private handleParticipantLeft(msg: any): void {
    const state = roomStore.getState();
    if (!state) return;
    roomStore.setParticipants(
      state.participants.filter((p) => p.id !== msg.participantId)
    );
  }

  private emit(type: string, data: any): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_DELAYS[Math.min(this.reconnectAttempt, BACKOFF_DELAYS.length - 1)];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
