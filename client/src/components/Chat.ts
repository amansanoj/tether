/**
 * Chat component.
 * Displays messages, handles send via enter key or button, shows emoji picker
 * for reactions, and displays rate-limit warnings.
 */

import { WsClient } from "../lib/ws";
import { chatStore, type ChatMessage } from "../stores/chat";

const EMOJI_OPTIONS = ["👍", "❤️", "😂", "🎉", "🔥", "👏", "😮", "😢"];

interface ChatOptions {
  wsClient: WsClient;
  roomCode: string;
}

export function createChat(options: ChatOptions): {
  element: HTMLElement;
  destroy: () => void;
} {
  const { wsClient, roomCode } = options;
  const unsubscribers: Array<() => void> = [];

  // Container
  const container = document.createElement("div");
  container.className = "chat";

  // Header
  const header = document.createElement("div");
  header.className = "chat__header";
  header.innerHTML = `
    <h3>Chat</h3>
    <span class="chat__room-code">${roomCode}</span>
  `;

  // Messages container
  const messagesContainer = document.createElement("div");
  messagesContainer.className = "chat__messages";

  // Rate limit warning (hidden by default)
  const rateLimitWarning = document.createElement("div");
  rateLimitWarning.className = "chat__rate-limit";
  rateLimitWarning.textContent = "Slow down! You are sending messages too fast.";
  rateLimitWarning.style.display = "none";

  // Input area
  const inputArea = document.createElement("div");
  inputArea.className = "chat__input-area";

  const emojiBtn = document.createElement("button");
  emojiBtn.className = "chat__emoji-btn";
  emojiBtn.setAttribute("aria-label", "Emoji reactions");
  emojiBtn.innerHTML = `<span class="chat__emoji-icon">😀</span>`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "chat__input";
  input.placeholder = "Type a message...";
  input.maxLength = 500;

  const sendBtn = document.createElement("button");
  sendBtn.className = "chat__send";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="22" y1="2" x2="11" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  `;

  inputArea.appendChild(emojiBtn);
  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);

  // Emoji picker (hidden by default)
  const emojiPicker = document.createElement("div");
  emojiPicker.className = "chat__emoji-picker";
  emojiPicker.style.display = "none";

  for (const emoji of EMOJI_OPTIONS) {
    const btn = document.createElement("button");
    btn.className = "chat__emoji-picker-item";
    btn.textContent = emoji;
    btn.addEventListener("click", () => {
      wsClient.send({ type: "chat:reaction", emoji });
      emojiPicker.style.display = "none";
    });
    emojiPicker.appendChild(btn);
  }

  // Assemble
  container.appendChild(header);
  container.appendChild(messagesContainer);
  container.appendChild(rateLimitWarning);
  container.appendChild(emojiPicker);
  container.appendChild(inputArea);

  // --- Message rendering ---
  function formatTimestamp(ts: number): string {
    const date = new Date(ts);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function renderMessages(messages: ChatMessage[]): void {
    if (messages.length === 0) {
      messagesContainer.innerHTML = `<div class="chat__empty"><p>No messages yet. Say hi!</p></div>`;
      return;
    }

    messagesContainer.innerHTML = "";
    for (const msg of messages) {
      const msgEl = document.createElement("div");
      msgEl.className = "chat__message";
      msgEl.innerHTML = `
        <div class="chat__message-header">
          <span class="chat__message-sender">${escapeHtml(msg.senderName)}</span>
          <span class="chat__message-time">${formatTimestamp(msg.timestamp)}</span>
        </div>
        <div class="chat__message-content">${escapeHtml(msg.content)}</div>
      `;
      messagesContainer.appendChild(msgEl);
    }

    // Auto-scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // --- Send message ---
  function sendMessage(): void {
    const content = input.value.trim();
    if (!content) return;

    wsClient.send({ type: "chat:message", content });
    input.value = "";
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener("click", sendMessage);

  // Emoji picker toggle
  emojiBtn.addEventListener("click", () => {
    const isVisible = emojiPicker.style.display !== "none";
    emojiPicker.style.display = isVisible ? "none" : "grid";
  });

  // Close emoji picker when clicking outside
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target as Node)) {
      emojiPicker.style.display = "none";
    }
  });

  // --- WebSocket event handlers ---
  unsubscribers.push(
    wsClient.on("chat:new-message", (msg) => {
      if (msg.message) {
        chatStore.addMessage(msg.message);
      }
    })
  );

  // Handle rate-limit error
  unsubscribers.push(
    wsClient.on("error", (msg) => {
      if (msg.code === "RATE_LIMITED") {
        rateLimitWarning.style.display = "block";
        setTimeout(() => {
          rateLimitWarning.style.display = "none";
        }, 3000);
      }
    })
  );

  // Subscribe to chat store
  unsubscribers.push(
    chatStore.subscribe((messages) => {
      renderMessages(messages);
    })
  );

  function destroy(): void {
    for (const unsub of unsubscribers) {
      unsub();
    }
  }

  return { element: container, destroy };
}
