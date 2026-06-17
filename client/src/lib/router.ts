/**
 * Tiny history-based router. Uses real paths (e.g. /room/ABC123) instead of
 * hash routing. navigate() pushes a new path and notifies listeners.
 */

export function navigate(path: string): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event("locationchange"));
}

export function onRouteChange(handler: () => void): void {
  window.addEventListener("popstate", handler);
  window.addEventListener("locationchange", handler);
}
