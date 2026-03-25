export const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MAX_UPLOAD_BYTES ?? "", 10) || 3 * 1024 * 1024;
export const JOB_TTL_MS = Number.parseInt(process.env.JOB_TTL_MS ?? "", 10) || 60 * 60 * 1000;
export const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 3001;
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export const DOCX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/octet-stream",
  "",
]);
