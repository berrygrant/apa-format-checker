function readPositiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readString(name, fallback = "") {
  return (process.env[name] ?? fallback).trim();
}

function readOnOffFlag(name, fallback) {
  const value = readString(name, fallback).toLowerCase();
  return !["off", "false", "0", "no"].includes(value);
}

export const MAX_UPLOAD_BYTES = readPositiveInteger("MAX_UPLOAD_BYTES", 3 * 1024 * 1024);
export const JOB_TTL_MS = readPositiveInteger("JOB_TTL_MS", 60 * 60 * 1000);
export const JOB_SNAPSHOT_TABLE = readString("JOB_SNAPSHOT_TABLE");
export const PORT = readPositiveInteger("PORT", 3001);
export const OPENAI_MODEL = readString("OPENAI_MODEL", "gpt-5.6-luna");
export const OPENAI_TIMEOUT_MS = readPositiveInteger("OPENAI_TIMEOUT_MS", 240 * 1000);
export const OPENAI_MAX_RETRIES = readPositiveInteger("OPENAI_MAX_RETRIES", 1);

function readTemperature(name, fallback) {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : fallback;
}

// Applied only when the configured model accepts sampling controls (reasoning
// models like gpt-5-mini reject them); 0 keeps the AI findings as repeatable
// as the API allows.
export const OPENAI_TEMPERATURE = readTemperature("OPENAI_TEMPERATURE", 0);
export const LLM_DELTA_FLUSH_MS = readPositiveInteger("LLM_DELTA_FLUSH_MS", 120);
export const REVIEW_CACHE_ENABLED = readOnOffFlag("REVIEW_CACHE", "on");
export const REFERENCE_VERIFICATION_ENABLED = readOnOffFlag("REFERENCE_VERIFICATION", "on");
export const CROSSREF_MAILTO = readString("CROSSREF_MAILTO", "berry.grant@gmail.com");
export const CROSSREF_TIMEOUT_MS = readPositiveInteger("CROSSREF_TIMEOUT_MS", 5000);
export const CROSSREF_TOTAL_BUDGET_MS = readPositiveInteger("CROSSREF_TOTAL_BUDGET_MS", 20000);
export const APP_PASSWORD = process.env.APP_PASSWORD || "";
export const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || APP_PASSWORD;
export const APP_AUTH_HOST = readString("APP_AUTH_HOST").toLowerCase();
export const AUTH_SESSION_TTL_MS = readPositiveInteger("AUTH_SESSION_TTL_MS", 7 * 24 * 60 * 60 * 1000);

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

export const PDF_MIME_TYPES = new Set([
  "application/pdf",
  "application/octet-stream",
  "",
]);
