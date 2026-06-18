/**
 * Chat component.
 * Displays messages, handles send via enter key or button, shows emoji picker
 * for reactions, and displays rate-limit warnings.
 */

import { WsClient } from "../lib/ws";
import { chatStore, type ChatMessage } from "../stores/chat";
import { roomStore } from "../stores/room";
import { generateQRCodeSVG } from "../lib/qr";

const EMOJI_OPTIONS = ["😘", "😚", "🫂", "🙃", "🤣", "😭", "😉", "😏"];

interface ChatOptions {
  wsClient: WsClient;
  roomCode: string;
  onCollapse?: () => void;
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
    <div class="chat__header-actions">
      <button class="chat__invite-btn" aria-label="Copy invite link" title="Copy invite link">
        <i class="ph-duotone ph-link"></i>
      </button>
      <button class="chat__qr-btn" aria-label="Detach chat to another device" title="Open chat on another device">
        <i class="ph-duotone ph-qr-code"></i>
      </button>
      <span class="chat__room-code">${roomCode}</span>
      <button class="chat__collapse-btn" aria-label="Collapse chat" title="Collapse chat">
        <i class="ph-duotone ph-caret-right"></i>
      </button>
    </div>
  `;

  const collapseBtn = header.querySelector(".chat__collapse-btn");
  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      options.onCollapse?.();
    });
  }

  const inviteBtn = header.querySelector(".chat__invite-btn") as HTMLElement | null;
  if (inviteBtn) {
    inviteBtn.addEventListener("click", () => {
      const link = `${window.location.origin}/room/${roomCode}`;
      navigator.clipboard?.writeText(link).catch(() => {});
      inviteBtn.classList.add("chat__invite-btn--copied");
      inviteBtn.setAttribute("title", "Link copied!");
      setTimeout(() => {
        inviteBtn.classList.remove("chat__invite-btn--copied");
        inviteBtn.setAttribute("title", "Copy invite link");
      }, 1500);
    });
  }

  // QR code modal for detaching chat to another device
  const qrBtn = header.querySelector(".chat__qr-btn") as HTMLElement | null;
  let qrModal: HTMLElement | null = null;

  function showQRModal(): void {
    if (qrModal) {
      qrModal.remove();
      qrModal = null;
      return;
    }
    const chatUrl = `${window.location.origin}/room/${roomCode}/chat`;
    const svg = generateQRCodeSVG(chatUrl, 3, 3);

    qrModal = document.createElement("div");
    qrModal.className = "chat__qr-modal";
    qrModal.innerHTML = `
      <div class="chat__qr-modal-content">
        <div class="chat__qr-modal-header">
          <span>Scan to open chat on another device</span>
          <button class="chat__qr-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="chat__qr-svg">${svg}</div>
        <div class="chat__qr-url">${chatUrl}</div>
      </div>
    `;

    qrModal.querySelector(".chat__qr-modal-close")?.addEventListener("click", () => {
      qrModal?.remove();
      qrModal = null;
    });
    qrModal.addEventListener("click", (e) => {
      if (e.target === qrModal) {
        qrModal?.remove();
        qrModal = null;
      }
    });

    container.appendChild(qrModal);
  }

  if (qrBtn) {
    qrBtn.addEventListener("click", showQRModal);
  }

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
  emojiBtn.innerHTML = `<i class="ph-duotone ph-smiley" style="font-size: 1.1rem;"></i>`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "chat__input";
  input.placeholder = "Type a message...";
  input.maxLength = 500;

  const sendBtn = document.createElement("button");
  sendBtn.className = "chat__send";
  sendBtn.setAttribute("aria-label", "Send");
  sendBtn.innerHTML = `<i class="ph-duotone ph-paper-plane-tilt"></i>`;

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

    const myId = roomStore.getState()?.myId;

    // Group consecutive messages from the same sender into one block.
    const groups: { senderId: string; senderName: string; messages: ChatMessage[] }[] = [];
    for (const msg of messages) {
      const last = groups[groups.length - 1];
      if (last && last.senderId === msg.senderId) {
        last.messages.push(msg);
      } else {
        groups.push({ senderId: msg.senderId, senderName: msg.senderName, messages: [msg] });
      }
    }

    messagesContainer.innerHTML = "";
    for (const group of groups) {
      const isYou = !!myId && group.senderId === myId;
      const name = `${escapeHtml(group.senderName)}${isYou ? " (you)" : ""}`;
      const lastMsg = group.messages[group.messages.length - 1];
      const bodies = group.messages
        .map((m) => `<div class="chat__message-content">${escapeHtml(m.content)}</div>`)
        .join("");

      const msgEl = document.createElement("div");
      msgEl.className = "chat__message";
      msgEl.innerHTML = `
        <div class="chat__message-header">
          <span class="chat__message-sender">${name}</span>
          <span class="chat__message-time">${formatTimestamp(lastMsg.timestamp)}</span>
        </div>
        ${bodies}
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
  const onDocumentClick = (e: MouseEvent) => {
    if (!container.contains(e.target as Node)) {
      emojiPicker.style.display = "none";
    }
  };
  document.addEventListener("click", onDocumentClick);

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
    document.removeEventListener("click", onDocumentClick);
  }

  return { element: container, destroy };
}
