import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// The off-switch must be observed by the module-level singleton, so the env
// var is set before the module (and its config import) is loaded.
process.env.REVIEW_CACHE = "off";

const { buildReviewCacheKey, createReviewCache, reviewCache } = await import("../src/lib/reviewCache.js");
const { OPENAI_MODEL } = await import("../src/lib/config.js");
const { REPORT_VERSION } = await import("../src/lib/reportBuilder.js");

function createClock(startMs = 0) {
  let currentMs = startMs;

  return {
    now: () => currentMs,
    advance: (deltaMs) => {
      currentMs += deltaMs;
    },
  };
}

const SAMPLE_ENTRY = {
  report: { version: REPORT_VERSION, summary: { overallScore: 90 } },
  sections: [{ id: "parser", label: "Parser" }],
};

test("cache key combines content digest, review mode, model, and report version", () => {
  const buffer = Buffer.from("byte-identical thesis upload");
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");

  assert.equal(
    buildReviewCacheKey(buffer, "standard", { model: "model-x", reportVersion: "9.9.9" }),
    `${digest}:standard:model-x:9.9.9`,
  );
  assert.equal(buildReviewCacheKey(buffer, "comprehensive"), `${digest}:comprehensive:${OPENAI_MODEL}:${REPORT_VERSION}`);

  const otherBuffer = Buffer.from("byte-identical thesis upload EDITED");
  assert.notEqual(buildReviewCacheKey(buffer, "standard"), buildReviewCacheKey(otherBuffer, "standard"));
  assert.notEqual(buildReviewCacheKey(buffer, "standard"), buildReviewCacheKey(buffer, "comprehensive"));
  assert.notEqual(
    buildReviewCacheKey(buffer, "standard", { model: "model-a" }),
    buildReviewCacheKey(buffer, "standard", { model: "model-b" }),
  );
});

test("hit and miss round-trip stores report, sections, and createdAt", () => {
  const clock = createClock(1_000);
  const cache = createReviewCache({ ttlMs: 60_000, now: clock.now });

  assert.equal(cache.get("missing-key"), null);

  cache.set("key-1", SAMPLE_ENTRY);
  const hit = cache.get("key-1");

  assert.ok(hit);
  assert.equal(hit.report, SAMPLE_ENTRY.report);
  assert.equal(hit.sections, SAMPLE_ENTRY.sections);
  assert.equal(hit.createdAt, new Date(1_000).toISOString());
  assert.equal(cache.get("other-key"), null);
});

test("entries expire after the TTL", () => {
  const clock = createClock();
  const cache = createReviewCache({ ttlMs: 1_000, now: clock.now });

  cache.set("key-ttl", SAMPLE_ENTRY);
  clock.advance(999);
  assert.ok(cache.get("key-ttl"), "entry should survive inside the TTL window");

  clock.advance(2);
  assert.equal(cache.get("key-ttl"), null, "entry should expire past the TTL");
  assert.equal(cache.size, 0, "expired entry is removed on read");
});

test("evictExpired sweeps stale entries without touching fresh ones", () => {
  const clock = createClock();
  const cache = createReviewCache({ ttlMs: 1_000, now: clock.now });

  cache.set("stale", SAMPLE_ENTRY);
  clock.advance(900);
  cache.set("fresh", SAMPLE_ENTRY);
  clock.advance(200);

  cache.evictExpired();

  assert.equal(cache.size, 1);
  assert.equal(cache.get("stale"), null);
  assert.ok(cache.get("fresh"));
});

test("insertion beyond the cap evicts the least recently used entry", () => {
  const clock = createClock();
  const cache = createReviewCache({ ttlMs: 60_000, maxEntries: 3, now: clock.now });

  cache.set("key-1", SAMPLE_ENTRY);
  cache.set("key-2", SAMPLE_ENTRY);
  cache.set("key-3", SAMPLE_ENTRY);

  // A hit refreshes recency, so key-2 becomes the oldest entry.
  assert.ok(cache.get("key-1"));

  cache.set("key-4", SAMPLE_ENTRY);

  assert.equal(cache.size, 3);
  assert.equal(cache.get("key-2"), null, "least recently used entry is evicted");
  assert.ok(cache.get("key-1"));
  assert.ok(cache.get("key-3"));
  assert.ok(cache.get("key-4"));
});

test("REVIEW_CACHE=off disables the shared cache and the factory off-switch", () => {
  assert.equal(reviewCache.enabled, false, "env off-switch must reach the singleton");

  reviewCache.set("key-off", SAMPLE_ENTRY);
  assert.equal(reviewCache.get("key-off"), null);
  assert.equal(reviewCache.size, 0);

  const disabled = createReviewCache({ enabled: false });
  disabled.set("key-off", SAMPLE_ENTRY);
  assert.equal(disabled.get("key-off"), null);
  assert.equal(disabled.size, 0);
});
