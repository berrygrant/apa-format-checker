import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import { JOB_SNAPSHOT_TABLE, JOB_TTL_MS } from "./config.js";
import { serializeJob } from "./jobStore.js";

// Optional cross-invocation snapshot store. Each Lambda invocation is its own
// container, so the in-memory job store cannot serve a refresh or rejoin after
// the streaming connection drops. When JOB_SNAPSHOT_TABLE is set, the latest
// serialized job state is written to DynamoDB so GET /api/review/stream/:jobId
// can replay it from any container. When unset, every export is a no-op and
// local development keeps the existing in-memory behavior.

const COMPRESSION_THRESHOLD_BYTES = 300 * 1024;
const DEFAULT_DEBOUNCE_MS = 500;
const JSON_ENCODING = "json";
const GZIP_BASE64_ENCODING = "gzip-base64";
const TERMINAL_SNAPSHOT_STATUSES = new Set(["completed", "failed"]);

export const INTERRUPTED_SNAPSHOT_MESSAGE =
  "This review is still running in another connection or was interrupted; its latest saved state is shown.";

function createStore({ tableName, clientFactory = null, ttlMs = JOB_TTL_MS, debounceMs = DEFAULT_DEBOUNCE_MS }) {
  return {
    tableName: (tableName ?? "").trim(),
    clientFactory,
    ttlMs,
    debounceMs,
    clientPromise: null,
    commandsPromise: null,
    pendingSaves: new Map(),
    loggedErrorTypes: new Set(),
  };
}

let store = createStore({ tableName: JOB_SNAPSHOT_TABLE });

/**
 * Re-initializes the store. Called without options it re-reads the env-derived
 * default; tests inject a table name, a fake DynamoDB client factory, and
 * shorter ttl/debounce windows.
 */
export function configureJobSnapshotStore(options = {}) {
  for (const timer of store.pendingSaves.values()) {
    clearTimeout(timer);
  }

  store = createStore({ tableName: JOB_SNAPSHOT_TABLE, ...options });
}

export function isEnabled() {
  return store.tableName.length > 0;
}

function logStoreError(activeStore, operation, error) {
  const errorType = (error && (error.name || error.code)) || "UnknownError";

  if (activeStore.loggedErrorTypes.has(errorType)) {
    return;
  }

  activeStore.loggedErrorTypes.add(errorType);
  console.error(
    JSON.stringify({
      event: "job_snapshot_store_error",
      operation,
      errorType,
      message: error instanceof Error ? error.message : String(error),
      table: activeStore.tableName,
      timestamp: new Date().toISOString(),
    }),
  );
}

function getCommands(activeStore) {
  if (!activeStore.commandsPromise) {
    activeStore.commandsPromise = import("@aws-sdk/lib-dynamodb").then(({ GetCommand, PutCommand }) => ({
      GetCommand,
      PutCommand,
    }));
  }

  return activeStore.commandsPromise;
}

async function createDefaultDocumentClient() {
  const [{ DynamoDBClient }, { DynamoDBDocumentClient }] = await Promise.all([
    import("@aws-sdk/client-dynamodb"),
    import("@aws-sdk/lib-dynamodb"),
  ]);

  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function getClient(activeStore) {
  if (!activeStore.clientPromise) {
    activeStore.clientPromise = activeStore.clientFactory
      ? Promise.resolve().then(() => activeStore.clientFactory())
      : createDefaultDocumentClient();
  }

  return activeStore.clientPromise;
}

function encodeSnapshot(snapshot) {
  const json = JSON.stringify(snapshot);

  if (Buffer.byteLength(json, "utf8") <= COMPRESSION_THRESHOLD_BYTES) {
    return { snapshot: json, snapshotEncoding: JSON_ENCODING };
  }

  return {
    snapshot: gzipSync(Buffer.from(json, "utf8")).toString("base64"),
    snapshotEncoding: GZIP_BASE64_ENCODING,
  };
}

function decodeSnapshot(item) {
  if (!item || typeof item.snapshot !== "string") {
    return null;
  }

  const json =
    item.snapshotEncoding === GZIP_BASE64_ENCODING
      ? gunzipSync(Buffer.from(item.snapshot, "base64")).toString("utf8")
      : item.snapshot;

  return JSON.parse(json);
}

/**
 * Persists the job's serialized snapshot. Fire-and-forget: the returned
 * promise resolves true/false and never rejects, and every DynamoDB failure is
 * swallowed after being logged once per error type.
 */
export async function saveSnapshot(job) {
  if (!isEnabled()) {
    return false;
  }

  const activeStore = store;

  try {
    const snapshot = serializeJob(job);
    const [client, { PutCommand }] = await Promise.all([getClient(activeStore), getCommands(activeStore)]);

    await client.send(
      new PutCommand({
        TableName: activeStore.tableName,
        Item: {
          jobId: snapshot.jobId,
          ...encodeSnapshot(snapshot),
          expiresAt: Math.floor((Date.now() + activeStore.ttlMs) / 1000),
        },
      }),
    );

    return true;
  } catch (error) {
    logStoreError(activeStore, "save", error);
    return false;
  }
}

/**
 * Loads a serialized job snapshot, or null when the store is disabled, the
 * item is missing/expired, or DynamoDB errors (logged once per error type).
 */
export async function loadSnapshot(jobId) {
  if (!isEnabled()) {
    return null;
  }

  const activeStore = store;

  try {
    const [client, { GetCommand }] = await Promise.all([getClient(activeStore), getCommands(activeStore)]);
    const result = await client.send(
      new GetCommand({
        TableName: activeStore.tableName,
        Key: { jobId },
      }),
    );

    return decodeSnapshot(result?.Item);
  } catch (error) {
    logStoreError(activeStore, "load", error);
    return null;
  }
}

/**
 * Debounced save hook for jobStore mutations: the first change starts a
 * trailing timer, further changes within the window coalesce into that save.
 * Terminal transitions save immediately and cancel any pending timer.
 */
export function scheduleSnapshotSave(job, { immediate = false } = {}) {
  if (!isEnabled()) {
    return;
  }

  const activeStore = store;

  if (immediate) {
    const pending = activeStore.pendingSaves.get(job.id);

    if (pending) {
      clearTimeout(pending);
      activeStore.pendingSaves.delete(job.id);
    }

    void saveSnapshot(job);
    return;
  }

  if (activeStore.pendingSaves.has(job.id)) {
    return;
  }

  const timer = setTimeout(() => {
    activeStore.pendingSaves.delete(job.id);
    void saveSnapshot(job);
  }, activeStore.debounceMs);

  timer.unref?.();
  activeStore.pendingSaves.set(job.id, timer);
}

export function isTerminalSnapshot(snapshot) {
  return TERMINAL_SNAPSHOT_STATUSES.has(snapshot?.status);
}

/**
 * SSE events GET /api/review/stream/:jobId replays when the job only exists as
 * a stored snapshot. Terminal snapshots stand alone; non-terminal snapshots
 * are followed by a review_error explaining that live cross-container resume
 * is not possible (payload.interrupted lets the client soften the message).
 */
export function buildSnapshotFallbackEvents(snapshot) {
  const events = [
    {
      id: `snapshot-${snapshot.jobId}`,
      type: "snapshot",
      payload: snapshot,
    },
  ];

  if (!isTerminalSnapshot(snapshot)) {
    events.push({
      id: `snapshot-${snapshot.jobId}-interrupted`,
      type: "review_error",
      payload: {
        error: { message: INTERRUPTED_SNAPSHOT_MESSAGE },
        interrupted: true,
      },
    });
  }

  return events;
}
