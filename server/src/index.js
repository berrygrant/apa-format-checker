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
import { createJob, getJob, serializeJob, subscribeToJob } from "./lib/jobStore.js";
import { getRequestMetricsSnapshot, recordReviewRequest } from "./lib/requestMetrics.js";
import { normalizeReviewMode } from "./lib/reviewMode.js";
import { initializeSse, sendSseEvent, startHeartbeat } from "./lib/sse.js";
import { processReviewJob } from "./lib/reviewJob.js";

const app = express();
app.set("trust proxy", 1);

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

app.get("/api/review/stream/:jobId", requireAppAuth, (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
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

  const stopHeartbeat = startHeartbeat(res);
  const unsubscribe = subscribeToJob(job, (event) => {
    sendSseEvent(res, event);
  });

  req.on("close", () => {
    unsubscribe();
    stopHeartbeat();
  });
});

if (hasBuiltClient) {
  app.use(express.static(clientDist));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }

    res.sendFile(resolve(clientDist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>APA Review API</title>
    <style>
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f3ec;
        color: #1f2a2c;
      }
      main {
        max-width: 760px;
        margin: 56px auto;
        padding: 0 24px;
      }
      .card {
        background: white;
        border: 1px solid rgba(31, 42, 44, 0.12);
        border-radius: 20px;
        padding: 28px;
        box-shadow: 0 16px 48px rgba(31, 42, 44, 0.08);
      }
      code {
        background: #eef3f2;
        padding: 2px 6px;
        border-radius: 6px;
      }
      ul {
        line-height: 1.7;
      }
      a {
        color: #0f766e;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1>APA Review backend is running</h1>
        <p>The React frontend has not been built yet, so this server cannot serve the web app from <code>/</code>.</p>
        <ul>
          <li>For local development, run the Vite client and open <a href="http://localhost:5173">http://localhost:5173</a>.</li>
          <li>To serve everything from this Express server, build the client so <code>client/dist</code> exists.</li>
          <li>API health check: <a href="/api/health">/api/health</a></li>
        </ul>
      </div>
    </main>
  </body>
</html>`);
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
