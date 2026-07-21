import "dotenv/config";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { getAuthSession, loginWithPassword, logoutSession, requireAppAuth } from "./lib/auth.js";
import { DOCX_MIME_TYPES, MAX_UPLOAD_BYTES, PDF_MIME_TYPES, PORT } from "./lib/config.js";
import { warmParsers } from "./lib/docxParser.js";
import {
  buildSnapshotFallbackEvents,
  isEnabled as isJobSnapshotStoreEnabled,
  loadSnapshot,
} from "./lib/jobSnapshotStore.js";
import { createJob, getJob, serializeJob, subscribeToJob } from "./lib/jobStore.js";
import { getRequestMetricsSnapshot, recordReviewRequest } from "./lib/requestMetrics.js";
import { normalizeReviewMode } from "./lib/reviewMode.js";
import { initializeSse, sendSseEvent, startHeartbeat } from "./lib/sse.js";
import { processReviewJob } from "./lib/reviewJob.js";
import { BACKEND_ONLY_HTML } from "./lib/staticFallback.js";

const app = express();
app.set("trust proxy", 1);

warmParsers();

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
});

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDirectory, "..", "..");
const clientDist = resolve(projectRoot, "client", "dist");
const hasBuiltClient = existsSync(clientDist);

function validateUploadFile(file) {
  if (!file) {
    return "A .docx or .pdf file is required.";
  }

  const extension = extname(file.originalname ?? "").toLowerCase();

  if (extension === ".docx") {
    if (!DOCX_MIME_TYPES.has(file.mimetype)) {
      return "The uploaded file does not look like a valid DOCX document.";
    }

    return null;
  }

  if (extension === ".pdf") {
    if (!PDF_MIME_TYPES.has(file.mimetype)) {
      return "The uploaded file does not look like a valid PDF document.";
    }

    return null;
  }

  return "Only .docx and .pdf uploads are supported.";
}

function isApiPath(req) {
  return req.path.startsWith("/api/");
}

app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/auth/session", getAuthSession);
app.post("/api/auth/login", authLimiter, loginWithPassword);
app.post("/api/auth/logout", logoutSession);
app.get("/api/metrics/requests", requireAppAuth, (_req, res) => {
  res.json(getRequestMetricsSnapshot());
});

function logReviewRequest(job, file, requestMetrics) {
  const sourceExtension = extname(file.originalname ?? "").toLowerCase() || "unknown";

  console.log(
    JSON.stringify({
      event: "review_request",
      jobId: job.id,
      reviewMode: job.reviewMode,
      sourceFormat: sourceExtension,
      sizeBytes: file.size,
      requestsToday: requestMetrics.today,
      timestamp: new Date().toISOString(),
    }),
  );
}

function createReviewJobFromRequest(req) {
  const fileError = validateUploadFile(req.file);
  const reviewMode = normalizeReviewMode(req.body?.reviewMode);

  if (fileError) {
    return {
      error: fileError,
    };
  }

  if (!reviewMode) {
    return {
      error: "Invalid review mode.",
    };
  }

  const job = createJob({
    id: crypto.randomUUID(),
    fileMeta: {
      name: req.file.originalname,
      sizeBytes: req.file.size,
      mimeType: req.file.mimetype,
    },
    reviewMode,
  });
  const requestMetrics = recordReviewRequest();

  logReviewRequest(job, req.file, requestMetrics);

  return {
    job,
    requestMetrics,
  };
}

app.post("/api/review", requireAppAuth, apiLimiter, upload.single("file"), (req, res) => {
  const reviewRequest = createReviewJobFromRequest(req);

  if (reviewRequest.error) {
    res.status(400).json({
      error: reviewRequest.error,
    });
    return;
  }

  const { job, requestMetrics } = reviewRequest;
  res.status(202).json({
    jobId: job.id,
    reviewMode: job.reviewMode,
    requestsToday: requestMetrics.today,
  });

  void processReviewJob(job, req.file.buffer);
});

app.post("/api/review/stream", requireAppAuth, apiLimiter, upload.single("file"), async (req, res) => {
  const reviewRequest = createReviewJobFromRequest(req);

  if (reviewRequest.error) {
    res.status(400).json({
      error: reviewRequest.error,
    });
    return;
  }

  const { job } = reviewRequest;
  initializeSse(res);
  sendSseEvent(res, {
    id: `snapshot-${job.id}`,
    type: "snapshot",
    payload: serializeJob(job),
  });

  const stopHeartbeat = startHeartbeat(res);
  const unsubscribe = subscribeToJob(job, (event) => {
    if (!res.destroyed && !res.writableEnded) {
      sendSseEvent(res, event);
    }
  });

  try {
    await processReviewJob(job, req.file.buffer);
  } finally {
    unsubscribe();
    stopHeartbeat();

    if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  }
});

app.get("/api/review/stream/:jobId", requireAppAuth, async (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    // Each Lambda invocation is its own container, so a rejoin usually lands
    // where the in-memory job never existed. When the snapshot store is
    // enabled, replay the latest saved state instead of a 404.
    if (isJobSnapshotStoreEnabled()) {
      const snapshot = await loadSnapshot(req.params.jobId);

      if (snapshot) {
        initializeSse(res);

        for (const event of buildSnapshotFallbackEvents(snapshot)) {
          sendSseEvent(res, event);
        }

        res.end();
        return;
      }
    }

    res.status(404).json({
      error: "Review job not found.",
    });
    return;
  }

  initializeSse(res);
  sendSseEvent(res, {
    id: `snapshot-${job.id}`,
    type: "snapshot",
    payload: serializeJob(job),
  });

  if (job.status === "completed" || job.status === "failed") {
    res.end();
    return;
  }

  const stopHeartbeat = startHeartbeat(res);
  const unsubscribe = subscribeToJob(job, (event) => {
    if (!res.destroyed && !res.writableEnded) {
      sendSseEvent(res, event);
    }

    // The live job just reached a terminal event; end the stream so one-shot
    // fetch readers (the client resume path) resolve instead of hanging on
    // heartbeats.
    if (event.type === "complete" || event.type === "review_error") {
      unsubscribe();
      stopHeartbeat();

      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    }
  });

  req.on("close", () => {
    unsubscribe();
    stopHeartbeat();
  });
});

if (hasBuiltClient) {
  // Vite emits content-hashed filenames under /assets, so they can be cached
  // forever; index.html must stay revalidated so deploys roll out immediately.
  app.use(
    "/assets",
    express.static(resolve(clientDist, "assets"), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
    }),
  );
  app.use(
    express.static(clientDist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );

  app.get("*", (req, res, next) => {
    if (isApiPath(req)) {
      next();
      return;
    }

    res.sendFile(resolve(clientDist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("html").send(BACKEND_ONLY_HTML);
  });
}

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({
      error: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit.`,
    });
    return;
  }

  res.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
  });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`APA review server listening on http://0.0.0.0:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down HTTP server...`);

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
