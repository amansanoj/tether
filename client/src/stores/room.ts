/**
 * Room state store.
 * Manages the current room state and notifies listeners on changes.
 */

export interface Participant {
  id: string;
  displayName: string;
  isHost: boolean;
}

export interface RoomState {
  code: string;
  videoSource: { type: string; url: string } | null;
  linkedVideoSource: { type: string; url: string } | null;
  participants: Participant[];
  isHost: boolean;
  displayName: string;
  playbackState: {
    playing: boolean;
    currentTime: number;
    playbackRate: number;
  };
}

type RoomListener = (state: RoomState | null) => void;

class RoomStore {
  private state: RoomState | null = null;
  private listeners: Set<RoomListener> = new Set();

  getState(): RoomState | null {
    return this.state;
  }

  setState(state: RoomState | null): void {
    this.state = state;
    this.notify();
  }

  updateState(partial: Partial<RoomState>): void {
    if (!this.state) return;
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  setParticipants(participants: Participant[]): void {
    if (!this.state) return;
    this.state = { ...this.state, participants };
    this.notify();
  }

  updatePlayback(playbackState: RoomState["playbackState"]): void {
    if (!this.state) return;
    this.state = { ...this.state, playbackState };
    this.notify();
  }

  subscribe(listener: RoomListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

export const roomStore = new RoomStore();
