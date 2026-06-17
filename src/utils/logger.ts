/**
 * Minimal structured logger — emits one JSON object per line so logs are
 * machine-parseable (ship to any log aggregator) instead of free-form strings.
 */

type Level = "info" | "warn" | "error";

function write(level: Level, event: string, data?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data || {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data),
};
