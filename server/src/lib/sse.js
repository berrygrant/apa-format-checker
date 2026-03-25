import { SSE_HEADERS } from "./config.js";

export function initializeSse(res) {
  Object.entries(SSE_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.flushHeaders?.();
  res.write("retry: 2000\n");
  res.write(": connected\n\n");
}

export function sendSseEvent(res, event) {
  if (event.id) {
    res.write(`id: ${event.id}\n`);
  }

  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}

export function startHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": heartbeat\n\n");
    }
  }, intervalMs);

  timer.unref?.();

  return () => clearInterval(timer);
}

