import crypto from "node:crypto";
import { JOB_TTL_MS, OPENAI_MODEL, REVIEW_CACHE_ENABLED } from "./config.js";
import { REPORT_VERSION } from "./reportBuilder.js";

// A cache hit means the uploaded bytes are identical to a recently reviewed
// document, so the whole pipeline (parse, layout, rule checks, OpenAI) can be
// replayed instantly. The key also carries the review mode, the configured
// OpenAI model, and the report version so a config or schema change never
// serves a stale report shape.
const MAX_REVIEW_CACHE_ENTRIES = 50;

export function buildReviewCacheKey(
  buffer,
  reviewMode,
  { model = OPENAI_MODEL, reportVersion = REPORT_VERSION, aiReview = true } = {},
) {
  const contentDigest = crypto.createHash("sha256").update(buffer).digest("hex");
  const baseKey = `${contentDigest}:${reviewMode}:${model}:${reportVersion}`;

  // An AI-off run must never replay a cached AI-on report (or vice versa).
  return aiReview ? baseKey : `${baseKey}:noai`;
}

export function createReviewCache({
  enabled = true,
  ttlMs = JOB_TTL_MS,
  maxEntries = MAX_REVIEW_CACHE_ENTRIES,
  now = Date.now,
} = {}) {
  const entries = new Map();

  function isExpired(entry) {
    return now() - entry.createdAtMs > ttlMs;
  }

  function evictExpired() {
    for (const [key, entry] of entries.entries()) {
      if (isExpired(entry)) {
        entries.delete(key);
      }
    }
  }

  function get(key) {
    if (!enabled) {
      return null;
    }

    const entry = entries.get(key);

    if (!entry) {
      return null;
    }

    if (isExpired(entry)) {
      entries.delete(key);
      return null;
    }

    // Re-insert on hit so Map insertion order doubles as recency order and
    // frequently re-run documents survive the size cap (LRU-ish).
    entries.delete(key);
    entries.set(key, entry);

    return {
      report: entry.report,
      sections: entry.sections,
      createdAt: entry.createdAt,
    };
  }

  function set(key, { report, sections }) {
    if (!enabled) {
      return;
    }

    entries.delete(key);

    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }

    const createdAtMs = now();

    entries.set(key, {
      report,
      sections,
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
    });
  }

  return {
    enabled,
    get,
    set,
    evictExpired,
    get size() {
      return entries.size;
    },
  };
}

export const reviewCache = createReviewCache({ enabled: REVIEW_CACHE_ENABLED });

const cleanupTimer = setInterval(() => reviewCache.evictExpired(), 5 * 60 * 1000);
cleanupTimer.unref?.();
