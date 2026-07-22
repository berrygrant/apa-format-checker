import assert from "node:assert/strict";
import test from "node:test";

import { createJob, serializeJob } from "../src/lib/jobStore.js";
import { runOpenAiReview } from "../src/lib/openaiReview.js";
import { buildReviewCacheKey } from "../src/lib/reviewCache.js";

test("runOpenAiReview skips without touching the network when disabled, even with a key configured", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-key-that-must-never-be-used";

  try {
    const result = await runOpenAiReview({
      jobId: "job-ai-off",
      fileMeta: { name: "thesis.docx" },
      parsedDocument: {},
      ruleBasedReport: {},
      reviewMode: "standard",
      enabled: false,
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "disabled_by_user");
    assert.equal(result.failed, false);
    assert.match(result.message, /turned off/i);
    assert.match(result.message, /no document text was sent/i);
  } finally {
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
});

test("keyless skips keep the missing-key reason", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    const result = await runOpenAiReview({
      jobId: "job-no-key",
      fileMeta: { name: "thesis.docx" },
      parsedDocument: {},
      ruleBasedReport: {},
      reviewMode: "standard",
    });

    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "missing_api_key");
  } finally {
    if (previousKey !== undefined) {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
});

test("AI-off runs get their own cache key so replays never cross modes", () => {
  const buffer = Buffer.from("identical document bytes");
  const aiOnKey = buildReviewCacheKey(buffer, "standard");
  const aiOffKey = buildReviewCacheKey(buffer, "standard", { aiReview: false });

  assert.notEqual(aiOnKey, aiOffKey);
  assert.ok(aiOffKey.endsWith(":noai"));
  assert.ok(!aiOnKey.endsWith(":noai"), "the default key format must stay unchanged");
  assert.equal(buildReviewCacheKey(buffer, "standard", { aiReview: true }), aiOnKey);
});

test("jobs default to AI review on and serialize the flag", () => {
  const defaultJob = createJob({ id: "job-default-ai", fileMeta: { name: "a.docx" }, reviewMode: "standard" });
  const optOutJob = createJob({
    id: "job-ai-opt-out",
    fileMeta: { name: "b.docx" },
    reviewMode: "standard",
    aiReviewEnabled: false,
  });

  assert.equal(defaultJob.aiReviewEnabled, true);
  assert.equal(optOutJob.aiReviewEnabled, false);
  assert.equal(serializeJob(defaultJob).aiReviewEnabled, true);
  assert.equal(serializeJob(optOutJob).aiReviewEnabled, false);
});
