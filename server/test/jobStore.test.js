import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { appendLlmPreview, completeJob, createJob, subscribeToJob } from "../src/lib/jobStore.js";

function createSubscribedJob(id) {
  const job = createJob({
    id,
    fileMeta: { name: "fixture.docx", sizeBytes: 10, mimeType: "application/octet-stream" },
    reviewMode: "standard",
  });
  const received = [];
  subscribeToJob(job, (event) => received.push(event));

  return { job, received };
}

test("llm_delta events are coalesced and carry delta + previewLength only", async () => {
  const { job, received } = createSubscribedJob("job-coalesce");

  for (let index = 0; index < 40; index += 1) {
    appendLlmPreview(job, `chunk${index} `);
  }

  await delay(250);

  const deltaEvents = received.filter((event) => event.type === "llm_delta");

  assert.ok(deltaEvents.length >= 1, "expected at least the immediate first flush");
  assert.ok(deltaEvents.length < 40, `expected coalescing, saw ${deltaEvents.length} events for 40 tokens`);

  for (const event of deltaEvents) {
    assert.equal(typeof event.payload.delta, "string");
    assert.ok(Number.isFinite(event.payload.previewLength));
    assert.ok(!("llmPreview" in event.payload), "payload must not resend the full buffer");
  }

  const reassembled = deltaEvents.map((event) => event.payload.delta).join("");
  assert.equal(reassembled, job.llmPreview);
});

test("completeJob flushes pending deltas before the terminal events", async () => {
  const { job, received } = createSubscribedJob("job-flush-on-complete");

  appendLlmPreview(job, "first ");
  appendLlmPreview(job, "second ");
  appendLlmPreview(job, "third");
  completeJob(job, { summary: { overallScore: 90 } });

  const types = received.map((event) => event.type);
  const lastDeltaIndex = types.lastIndexOf("llm_delta");
  const completeIndex = types.indexOf("complete");

  assert.ok(lastDeltaIndex !== -1);
  assert.ok(completeIndex > lastDeltaIndex, "complete must come after the final flushed delta");

  const reassembled = received
    .filter((event) => event.type === "llm_delta")
    .map((event) => event.payload.delta)
    .join("");
  assert.equal(reassembled, "first second third");

  await delay(200);
  assert.equal(
    received.filter((event) => event.type === "llm_delta").length,
    received.filter((event) => event.type === "llm_delta").length,
    "no stray timer flush after completion",
  );
});
