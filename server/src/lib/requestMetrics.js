import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDirectory, "..", "..");
const dataDirectory = resolve(projectRoot, "server-data");
const metricsFile = resolve(dataDirectory, "request-metrics.json");
const metricsTimeZone = process.env.REQUEST_METRICS_TIME_ZONE || process.env.TZ || "America/New_York";
const metricsDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: metricsTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function todayKey() {
  return metricsDateFormatter.format(new Date());
}

function loadMetrics() {
  if (!existsSync(metricsFile)) {
    return {
      total: 0,
      byDay: {},
      updatedAt: null,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(metricsFile, "utf8"));

    return {
      total: Number.isFinite(parsed?.total) ? parsed.total : 0,
      byDay: parsed?.byDay && typeof parsed.byDay === "object" ? parsed.byDay : {},
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return {
      total: 0,
      byDay: {},
      updatedAt: null,
    };
  }
}

function persistMetrics(state) {
  mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${metricsFile}.tmp`;

  writeFileSync(
    temporaryFile,
    JSON.stringify(
      {
        total: state.total,
        byDay: state.byDay,
        updatedAt: state.updatedAt,
      },
      null,
      2,
    ),
  );
  renameSync(temporaryFile, metricsFile);
}

function sortDaysDescending(left, right) {
  if (left[0] < right[0]) {
    return 1;
  }

  if (left[0] > right[0]) {
    return -1;
  }

  return 0;
}

const metricsState = loadMetrics();

export function recordReviewRequest() {
  const day = todayKey();

  metricsState.total += 1;
  metricsState.byDay[day] = (metricsState.byDay[day] ?? 0) + 1;
  metricsState.updatedAt = new Date().toISOString();
  persistMetrics(metricsState);

  return getRequestMetricsSnapshot();
}

export function getRequestMetricsSnapshot(limit = 30) {
  const day = todayKey();
  const dailyCounts = Object.entries(metricsState.byDay)
    .sort(sortDaysDescending)
    .slice(0, limit)
    .map(([date, count]) => ({
      date,
      count,
    }));

  return {
    total: metricsState.total,
    today: metricsState.byDay[day] ?? 0,
    byDay: dailyCounts,
    updatedAt: metricsState.updatedAt,
    timeZone: metricsTimeZone,
  };
}
