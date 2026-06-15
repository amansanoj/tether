/**
 * Connection status store.
 * Tracks the WebSocket connection state and notifies listeners.
 */

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

type ConnectionListener = (status: ConnectionStatus) => void;

class ConnectionStore {
  private status: ConnectionStatus = "disconnected";
  private listeners: Set<ConnectionListener> = new Set();

  getStatus(): ConnectionStatus {
    return this.status;
  }

  setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.notify();
  }

  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    // Immediately call with current state
    listener(this.status);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.status);
    }
  }
}

export const connectionStore = new ConnectionStore();
