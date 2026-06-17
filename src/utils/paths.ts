/**
 * Path helpers for safe static file serving.
 */

import { join } from "path";

/**
 * Resolve a request pathname against the dist directory, returning the absolute
 * file path only if it stays inside distDir. Returns null for any path that
 * would escape the directory (path traversal).
 */
export function safeStaticPath(distDir: string, pathname: string): string | null {
  const filePath = join(distDir, pathname);
  if (filePath !== distDir && !filePath.startsWith(distDir + "/")) {
    return null;
  }
  return filePath;
}
