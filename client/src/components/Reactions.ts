/**
 * Reactions component.
 * Full-screen overlay that displays floating emoji reactions.
 * Emoji elements rise from the bottom with random X offset and fade out.
 */

import { WsClient } from "../lib/ws";

interface ReactionsOptions {
  wsClient: WsClient;
}

export function createReactions(options: ReactionsOptions): {
  element: HTMLElement;
  destroy: () => void;
} {
  const { wsClient } = options;
  const unsubscribers: Array<() => void> = [];

  // Overlay container
  const overlay = document.createElement("div");
  overlay.className = "reaction-overlay";

  function spawnReaction(emoji: string): void {
    const el = document.createElement("span");
    el.className = "reaction-overlay__emoji";
    el.textContent = emoji;

    // Random horizontal position (10% to 90% of viewport width)
    const xPos = 10 + Math.random() * 80;
    el.style.left = `${xPos}%`;
    el.style.bottom = "10%";

    // Slightly randomize animation duration (2-3.5s)
    const duration = 2 + Math.random() * 1.5;
    el.style.animationDuration = `${duration}s`;

    overlay.appendChild(el);

    // Remove element after animation completes
    setTimeout(() => {
      if (el.parentNode === overlay) {
        overlay.removeChild(el);
      }
    }, duration * 1000 + 100);
  }

  // Listen for reaction events
  unsubscribers.push(
    wsClient.on("chat:new-reaction", (msg) => {
      if (msg.emoji) {
        spawnReaction(msg.emoji);
      }
    })
  );

  function destroy(): void {
    for (const unsub of unsubscribers) {
      unsub();
    }
    overlay.innerHTML = "";
  }

  return { element: overlay, destroy };
}
