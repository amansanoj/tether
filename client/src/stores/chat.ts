/**
 * Chat store.
 * Manages chat messages and notifies listeners on changes.
 */

export interface ChatMessage {
  id: string;
  senderId: string;
  senderClientId?: string | null;
  senderName: string;
  content: string;
  timestamp: number;
}

type ChatListener = (messages: ChatMessage[]) => void;

class ChatStore {
  private messages: ChatMessage[] = [];
  private listeners: Set<ChatListener> = new Set();

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /** Initialize with messages from room:state */
  initialize(messages: ChatMessage[]): void {
    this.messages = [...messages];
    this.notify();
  }

  /** Add a new message and notify listeners */
  addMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.notify();
  }

  /** Clear all messages (e.g., on room leave) */
  clear(): void {
    this.messages = [];
    this.notify();
  }

  subscribe(listener: ChatListener): () => void {
    this.listeners.add(listener);
    listener(this.messages);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.messages);
    }
  }
}

export const chatStore = new ChatStore();
