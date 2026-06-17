/**
 * Queue store: holds the shared playback queue and the current index.
 */

export interface QueueItem {
  id: string;
  source: { type: string; url: string; label?: string };
  title: string;
  addedBy: string;
}

export interface QueueState {
  queue: QueueItem[];
  currentIndex: number;
}

type Listener = (state: QueueState) => void;

class QueueStore {
  private queue: QueueItem[] = [];
  private currentIndex = 0;
  private listeners = new Set<Listener>();

  set(queue: QueueItem[], currentIndex: number): void {
    this.queue = queue;
    this.currentIndex = currentIndex;
    this.notify();
  }

  getState(): QueueState {
    return { queue: this.queue, currentIndex: this.currentIndex };
  }

  /** The source that should currently be playing, if any. */
  currentSource(): { type: string; url: string; label?: string } | null {
    return this.queue[this.currentIndex]?.source ?? null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.queue = [];
    this.currentIndex = 0;
    this.notify();
  }

  private notify(): void {
    const state = this.getState();
    for (const l of this.listeners) l(state);
  }
}

export const queueStore = new QueueStore();
