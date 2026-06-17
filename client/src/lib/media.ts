/**
 * Media helpers: detect a source type from a URL and resolve a human title
 * (best-effort, via the platform's public oEmbed endpoint).
 */

export function detectSourceType(url: string): "file" | "hls" | "youtube" | "vimeo" {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/vimeo\.com/i.test(url)) return "vimeo";
  if (/\.m3u8(\?|$)/i.test(url)) return "hls";
  return "file";
}

async function fetchJsonWithTimeout(url: string, ms: number): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (r.ok) return await r.json();
  } catch {
    // network / CORS / timeout — caller falls back
  } finally {
    clearTimeout(timer);
  }
  return null;
}

/**
 * Best-effort title lookup via our own server (which proxies oEmbed, avoiding
 * cross-origin CORS issues). Returns the URL itself if no title is found.
 */
export async function resolveTitle(url: string): Promise<string> {
  const type = detectSourceType(url);
  if (type === "youtube" || type === "vimeo") {
    const j = await fetchJsonWithTimeout(
      `/api/title?url=${encodeURIComponent(url)}`,
      5000
    );
    if (j && typeof j.title === "string" && j.title.length > 0) return j.title;
  }
  return url;
}
