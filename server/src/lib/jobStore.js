import { JOB_TTL_MS } from "./config.js";

const jobs = new Map();
const TERMINAL_STATES = new Set(["completed", "failed"]);
const HISTORY_LIMIT = 200;

let eventSequence = 0;

function nextEventId() {
  eventSequence += 1;
  return `${Date.now()}-${eventSequence}`;
}

function nowIso() {
  return new Date().toISOString();
}

function publish(job, type, payload, { persist = true } = {}) {
  const event = {
    id: nextEventId(),
    type,
    payload,
    createdAt: nowIso(),
  };

  job.updatedAt = event.createdAt;

  if (persist) {
    job.history.push(event);
    if (job.history.length > HISTORY_LIMIT) {
      job.history.shift();
    }
  }

  for (const listener of job.subscribers) {
    listener(event);
  }

  return event;
}

export function createJob({ id, fileMeta, reviewMode }) {
  const job = {
    id,
    status: "queued",
    currentStage: "queued",
    fileMeta,
    reviewMode,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [],
    sections: {},
    llmPreview: "",
    report: null,
    error: null,
    subscribers: new Set(),
  };

  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function serializeJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    currentStage: job.currentStage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    fileMeta: job.fileMeta,
    reviewMode: job.reviewMode,
    history: job.history,
    sections: Object.values(job.sections),
    llmPreview: job.llmPreview,
    report: job.report,
    error: job.error,
  };
}

export function subscribeToJob(job, listener) {
  job.subscribers.add(listener);
  return () => {
    job.subscribers.delete(listener);
  };
}

export function setJobStage(job, stage, message, progress, level = "info") {
  job.status = "processing";
  job.currentStage = stage;

  publish(
    job,
    "status",
    {
      stage,
      message,
      progress,
      level,
      timestamp: nowIso(),
    },
    { persist: true },
  );
}

export function upsertJobSection(job, section) {
  job.sections[section.id] = section;

  publish(
    job,
    "section",
    {
      section,
      timestamp: nowIso(),
    },
    { persist: true },
  );
}

export function appendLlmPreview(job, delta) {
  if (!delta) {
    return;
  }

  job.llmPreview += delta;

  publish(
    job,
    "llm_delta",
    {
      delta,
      llmPreview: job.llmPreview,
      timestamp: nowIso(),
    },
    { persist: false },
  );
}

export function completeJob(job, report) {
  job.status = "completed";
  job.currentStage = "completed";
  job.report = report;

  publish(
    job,
    "status",
    {
      stage: "completed",
      message: "APA report complete.",
      progress: 100,
      level: "success",
      timestamp: nowIso(),
    },
    { persist: true },
  );

  publish(
    job,
    "complete",
    {
      report,
      timestamp: nowIso(),
    },
    { persist: false },
  );
}

export function failJob(job, error) {
  job.status = "failed";
  job.currentStage = "failed";
  job.error = {
    message: error instanceof Error ? error.message : "Review failed.",
  };

  publish(
    job,
    "review_error",
    {
      error: job.error,
      timestamp: nowIso(),
    },
    { persist: false },
  );
}

function cleanupExpiredJobs() {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    const updatedAt = Date.parse(job.updatedAt);
    const isExpired = Number.isFinite(updatedAt) && now - updatedAt > JOB_TTL_MS;

    if (isExpired && TERMINAL_STATES.has(job.status)) {
      jobs.delete(jobId);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpiredJobs, 5 * 60 * 1000);
cleanupTimer.unref?.();
