import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync } from "node:zlib";

import {
  INTERRUPTED_SNAPSHOT_MESSAGE,
  buildSnapshotFallbackEvents,
  configureJobSnapshotStore,
  isEnabled,
  isTerminalSnapshot,
  loadSnapshot,
  saveSnapshot,
  scheduleSnapshotSave,
} from "../src/lib/jobSnapshotStore.js";
import { completeJob, createJob, serializeJob } from "../src/lib/jobStore.js";

function createFakeDynamo() {
  const state = {
    calls: [],
    items: new Map(),
    failWith: null,
  };

  state.client = {
    async send(command) {
      state.calls.push(command);

      if (state.failWith) {
        throw state.failWith;
      }

      if (command.input?.Item) {
        state.items.set(command.input.Item.jobId, command.input.Item);
        return {};
      }

      if (command.input?.Key) {
        return { Item: state.items.get(command.input.Key.jobId) };
      }

      throw new Error("Unexpected DynamoDB command shape.");
    },
  };

  return state;
}

function createTestJob(id) {
  return createJob({
    id,
    fileMeta: { name: "fixture.docx", sizeBytes: 42, mimeType: "application/octet-stream" },
    reviewMode: "standard",
  });
}

function putCalls(fake) {
  return fake.calls.filter((command) => command.input?.Item);
}

afterEach(() => {
  configureJobSnapshotStore();
});

test("disabled store is a no-op that never touches the client factory", async () => {
  configureJobSnapshotStore({
    tableName: "",
    clientFactory: () => {
      throw new Error("the client factory must not be called while disabled");
    },
  });

  const job = createTestJob("snapshot-disabled");

  assert.equal(isEnabled(), false);
  assert.equal(await saveSnapshot(job), false);
  assert.equal(await loadSnapshot(job.id), null);
  scheduleSnapshotSave(job);
  scheduleSnapshotSave(job, { immediate: true });
  await delay(20);
});

test("small snapshots round-trip through DynamoDB as plain JSON", async () => {
  const fake = createFakeDynamo();
  const ttlMs = 120_000;
  configureJobSnapshotStore({ tableName: "jobs-test", clientFactory: () => fake.client, ttlMs });

  const job = createTestJob("snapshot-roundtrip");
  const before = Date.now();

  assert.equal(isEnabled(), true);
  assert.equal(await saveSnapshot(job), true);

  const [put] = putCalls(fake);
  assert.ok(put, "expected a PutCommand");
  assert.equal(put.input.TableName, "jobs-test");

  const item = put.input.Item;
  assert.equal(item.jobId, job.id);
  assert.equal(item.snapshotEncoding, "json");
  assert.equal(JSON.parse(item.snapshot).jobId, job.id);

  const expectedExpiry = Math.floor((before + ttlMs) / 1000);
  assert.ok(Math.abs(item.expiresAt - expectedExpiry) <= 5, "expiresAt must be now + ttl in epoch seconds");

  const loaded = await loadSnapshot(job.id);
  assert.deepEqual(loaded, JSON.parse(JSON.stringify(serializeJob(job))));
});

test("snapshots over the 300KB threshold are gzipped and base64 encoded", async () => {
  const fake = createFakeDynamo();
  configureJobSnapshotStore({ tableName: "jobs-test", clientFactory: () => fake.client });

  const job = createTestJob("snapshot-gzip");
  job.llmPreview = "The reference list needs a hanging indent. ".repeat(9000); // ~380KB

  assert.equal(await saveSnapshot(job), true);

  const [put] = putCalls(fake);
  const item = put.input.Item;
  const rawJson = JSON.stringify(serializeJob(job));

  assert.equal(item.snapshotEncoding, "gzip-base64");
  assert.ok(item.snapshot.length < rawJson.length, "stored payload must be smaller than the raw JSON");

  const inflated = gunzipSync(Buffer.from(item.snapshot, "base64")).toString("utf8");
  assert.equal(JSON.parse(inflated).llmPreview, job.llmPreview);

  const loaded = await loadSnapshot(job.id);
  assert.equal(loaded.llmPreview, job.llmPreview);
  assert.equal(loaded.jobId, job.id);
});

test("DynamoDB errors are swallowed and logged once per error type", async (t) => {
  const fake = createFakeDynamo();
  fake.failWith = Object.assign(new Error("Requested resource not found"), {
    name: "ResourceNotFoundException",
  });
  configureJobSnapshotStore({ tableName: "jobs-test", clientFactory: () => fake.client });

  const errorLog = t.mock.method(console, "error", () => {});
  const job = createTestJob("snapshot-errors");

  assert.equal(await saveSnapshot(job), false);
  assert.equal(await saveSnapshot(job), false);
  assert.equal(await loadSnapshot(job.id), null);
  assert.equal(errorLog.mock.callCount(), 1, "same error type must only be logged once");

  const logged = JSON.parse(errorLog.mock.calls[0].arguments[0]);
  assert.equal(logged.event, "job_snapshot_store_error");
  assert.equal(logged.errorType, "ResourceNotFoundException");

  fake.failWith = Object.assign(new Error("Throughput exceeded"), {
    name: "ProvisionedThroughputExceededException",
  });

  assert.equal(await saveSnapshot(job), false);
  assert.equal(errorLog.mock.callCount(), 2, "a new error type must be logged");
});

test("scheduleSnapshotSave debounces per job and saves immediately on terminal states", async () => {
  const fake = createFakeDynamo();
  configureJobSnapshotStore({ tableName: "jobs-test", clientFactory: () => fake.client, debounceMs: 25 });

  const job = createTestJob("snapshot-debounce");

  scheduleSnapshotSave(job);
  scheduleSnapshotSave(job);
  scheduleSnapshotSave(job);
  assert.equal(putCalls(fake).length, 0, "the trailing timer must not have fired yet");

  await delay(80);
  assert.equal(putCalls(fake).length, 1, "burst updates coalesce into one save");

  scheduleSnapshotSave(job);
  scheduleSnapshotSave(job, { immediate: true });
  await delay(20);
  assert.equal(putCalls(fake).length, 2, "terminal saves run immediately");

  await delay(80);
  assert.equal(putCalls(fake).length, 2, "the pending debounce timer is cancelled by an immediate save");
});

test("completeJob persists an immediate terminal snapshot through the store", async () => {
  const fake = createFakeDynamo();
  configureJobSnapshotStore({ tableName: "jobs-test", clientFactory: () => fake.client, debounceMs: 25 });

  const job = createTestJob("snapshot-complete-hook");
  completeJob(job, { summary: { overallScore: 91 } });
  await delay(20);

  const saved = fake.items.get(job.id);
  assert.ok(saved, "completeJob must write a snapshot without waiting for the debounce");

  const snapshot = JSON.parse(saved.snapshot);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.report.summary.overallScore, 91);
});

test("buildSnapshotFallbackEvents replays terminal snapshots as-is", () => {
  const completed = { jobId: "job-1", status: "completed", report: { summary: {} } };
  const failed = { jobId: "job-2", status: "failed", error: { message: "boom" } };

  assert.equal(isTerminalSnapshot(completed), true);
  assert.equal(isTerminalSnapshot(failed), true);

  for (const snapshot of [completed, failed]) {
    const events = buildSnapshotFallbackEvents(snapshot);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "snapshot");
    assert.equal(events[0].payload, snapshot);
  }
});

test("buildSnapshotFallbackEvents appends an interrupted review_error for non-terminal snapshots", () => {
  const snapshot = { jobId: "job-3", status: "processing", currentStage: "llm_review" };

  assert.equal(isTerminalSnapshot(snapshot), false);

  const events = buildSnapshotFallbackEvents(snapshot);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "snapshot");
  assert.equal(events[1].type, "review_error");
  assert.equal(events[1].payload.error.message, INTERRUPTED_SNAPSHOT_MESSAGE);
  assert.equal(events[1].payload.interrupted, true);
});
