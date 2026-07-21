import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDirectory, "..", "..");
const isLambdaRuntime = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const dataDirectory =
  process.env.REQUEST_METRICS_DIR || (isLambdaRuntime ? "/tmp/thesis-apa-formatter" : resolve(projectRoot, "server-data"));
const metricsFile = resolve(dataDirectory, "request-metrics.json");
const metricsTimeZone = process.env.REQUEST_METRICS_TIME_ZONE || process.env.TZ || "America/New_York";
const metricsDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: metricsTimeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Cohort-insight bounds: the store never grows past these, so a busy semester
// (or a hallucination-prone model inventing novel check titles) cannot bloat
// the JSON file.
const MAX_OUTCOME_DAYS = 120;
const MAX_CHECK_KEYS_PER_DAY = 150;
const MAX_TOP_CHECKS = 25;
const MAX_CHECK_TITLE_LENGTH = 160;
const COUNTED_SEVERITIES = new Set(["fail", "warning", "info"]);

function todayKey() {
  return metricsDateFormatter.format(new Date());
}

function dayKeyDaysAgo(daysAgo) {
  return metricsDateFormatter.format(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000));
}

function emptySeverityTally() {
  return { fail: 0, warning: 0, info: 0 };
}

function emptyOutcomeDay() {
  return {
    runs: 0,
    runsWithAnyFail: 0,
    bySourceFormat: { docx: 0, pdf: 0 },
    byMode: { standard: 0, comprehensive: 0 },
    checkFailures: {},
  };
}

function sanitizeCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sanitizeCheckFailure(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.title !== "string" || !raw.title) {
    return null;
  }

  return {
    title: raw.title.slice(0, MAX_CHECK_TITLE_LENGTH),
    sectionId: typeof raw.sectionId === "string" && raw.sectionId ? raw.sectionId : "unknown",
    runsAffected: sanitizeCount(raw.runsAffected),
    occurrences: sanitizeCount(raw.occurrences),
    severityTally: {
      fail: sanitizeCount(raw.severityTally?.fail),
      warning: sanitizeCount(raw.severityTally?.warning),
      info: sanitizeCount(raw.severityTally?.info),
    },
  };
}

function sanitizeOutcomeDay(raw) {
  const day = emptyOutcomeDay();

  if (!raw || typeof raw !== "object") {
    return day;
  }

  day.runs = sanitizeCount(raw.runs);
  day.runsWithAnyFail = sanitizeCount(raw.runsWithAnyFail);
  day.bySourceFormat.docx = sanitizeCount(raw.bySourceFormat?.docx);
  day.bySourceFormat.pdf = sanitizeCount(raw.bySourceFormat?.pdf);
  day.byMode.standard = sanitizeCount(raw.byMode?.standard);
  day.byMode.comprehensive = sanitizeCount(raw.byMode?.comprehensive);

  const rawFailures = raw.checkFailures && typeof raw.checkFailures === "object" ? raw.checkFailures : {};

  for (const [key, value] of Object.entries(rawFailures).slice(0, MAX_CHECK_KEYS_PER_DAY)) {
    const entry = sanitizeCheckFailure(value);

    if (entry) {
      day.checkFailures[key] = entry;
    }
  }

  return day;
}

function pruneOutcomeDays(reviewOutcomes) {
  const dates = Object.keys(reviewOutcomes.days).sort();

  while (dates.length > MAX_OUTCOME_DAYS) {
    delete reviewOutcomes.days[dates.shift()];
  }
}

// Metrics files written before review-outcome tracking existed simply lack the
// reviewOutcomes field; they load as an empty outcome store.
function sanitizeReviewOutcomes(raw) {
  const reviewOutcomes = { days: {} };

  if (!raw || typeof raw !== "object" || !raw.days || typeof raw.days !== "object") {
    return reviewOutcomes;
  }

  for (const [date, value] of Object.entries(raw.days)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      reviewOutcomes.days[date] = sanitizeOutcomeDay(value);
    }
  }

  pruneOutcomeDays(reviewOutcomes);

  return reviewOutcomes;
}

function defaultMetricsState() {
  return {
    total: 0,
    byDay: {},
    updatedAt: null,
    reviewOutcomes: { days: {} },
  };
}

function loadMetrics() {
  if (!existsSync(metricsFile)) {
    return defaultMetricsState();
  }

  try {
    const parsed = JSON.parse(readFileSync(metricsFile, "utf8"));

    return {
      total: Number.isFinite(parsed?.total) ? parsed.total : 0,
      byDay: parsed?.byDay && typeof parsed.byDay === "object" ? parsed.byDay : {},
      updatedAt: typeof parsed?.updatedAt === "string" ? parsed.updatedAt : null,
      reviewOutcomes: sanitizeReviewOutcomes(parsed?.reviewOutcomes),
    };
  } catch {
    return defaultMetricsState();
  }
}

async function writeMetricsSnapshot(snapshot) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${metricsFile}.tmp`;

  await writeFile(temporaryFile, JSON.stringify(snapshot, null, 2));
  await rename(temporaryFile, metricsFile);
}

// Serialized so overlapping requests never interleave tmp-file writes; the hot
// path only enqueues and returns.
let persistChain = Promise.resolve();

function schedulePersist(state) {
  const snapshot = {
    total: state.total,
    byDay: { ...state.byDay },
    updatedAt: state.updatedAt,
    reviewOutcomes: structuredClone(state.reviewOutcomes),
  };

  persistChain = persistChain
    .then(() => writeMetricsSnapshot(snapshot))
    .catch((error) => {
      console.warn(`Failed to persist request metrics: ${error instanceof Error ? error.message : error}`);
    });

  return persistChain;
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
  schedulePersist(metricsState);

  return getRequestMetricsSnapshot();
}

function normalizeCheckTitle(title) {
  return String(title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHECK_TITLE_LENGTH);
}

// Aggregates one completed review into anonymous per-day cohort counters.
// Privacy rule: only check titles, section ids, severities, and counts are
// stored — never filenames, document text, excerpts, or student identifiers.
export function recordReviewOutcome(report) {
  if (!report || typeof report !== "object") {
    return;
  }

  const day = todayKey();
  const outcomeDay = (metricsState.reviewOutcomes.days[day] ??= emptyOutcomeDay());

  outcomeDay.runs += 1;

  const sourceFormat = report.document?.sourceFormat;

  if (sourceFormat === "docx" || sourceFormat === "pdf") {
    outcomeDay.bySourceFormat[sourceFormat] += 1;
  }

  const mode = report.review?.mode;

  if (mode === "standard" || mode === "comprehensive") {
    outcomeDay.byMode[mode] += 1;
  }

  const issues = Array.isArray(report.issueInventory) ? report.issueInventory : [];
  const keysCountedForThisRun = new Set();
  let runHasFail = false;

  for (const issue of issues) {
    const severity = issue?.status;

    if (!COUNTED_SEVERITIES.has(severity)) {
      continue;
    }

    if (severity === "fail") {
      runHasFail = true;
    }

    const title = normalizeCheckTitle(issue.title);

    if (!title) {
      continue;
    }

    const sectionId = typeof issue.sectionId === "string" && issue.sectionId ? issue.sectionId : "unknown";
    const key = `${sectionId}:${title.toLowerCase()}`;
    let entry = outcomeDay.checkFailures[key];

    if (!entry) {
      // Bound growth: silently drop brand-new keys once the day is full;
      // already-tracked checks keep counting.
      if (Object.keys(outcomeDay.checkFailures).length >= MAX_CHECK_KEYS_PER_DAY) {
        continue;
      }

      entry = {
        title,
        sectionId,
        runsAffected: 0,
        occurrences: 0,
        severityTally: emptySeverityTally(),
      };
      outcomeDay.checkFailures[key] = entry;
    }

    entry.occurrences += 1;
    entry.severityTally[severity] += 1;

    // "Runs affected" counts a check once per report: a thesis with 12 orphan
    // citations is one affected run, while occurrences keeps the raw tally.
    if (!keysCountedForThisRun.has(key)) {
      keysCountedForThisRun.add(key);
      entry.runsAffected += 1;
    }
  }

  if (runHasFail) {
    outcomeDay.runsWithAnyFail += 1;
  }

  pruneOutcomeDays(metricsState.reviewOutcomes);
  metricsState.updatedAt = new Date().toISOString();
  schedulePersist(metricsState);
}

function clampWindowDays(days) {
  const parsed = Number(days);

  if (!Number.isFinite(parsed)) {
    return 30;
  }

  return Math.min(MAX_OUTCOME_DAYS, Math.max(1, Math.floor(parsed)));
}

export function getInsightsSnapshot({ days = 30 } = {}) {
  const windowDays = clampWindowDays(days);
  const earliestDay = dayKeyDaysAgo(windowDays - 1);
  const totals = {
    runs: 0,
    runsWithAnyFail: 0,
    bySourceFormat: { docx: 0, pdf: 0 },
    byMode: { standard: 0, comprehensive: 0 },
  };
  const mergedChecks = new Map();
  const byDay = [];

  for (const [date, outcomeDay] of Object.entries(metricsState.reviewOutcomes.days)) {
    if (date < earliestDay) {
      continue;
    }

    totals.runs += outcomeDay.runs;
    totals.runsWithAnyFail += outcomeDay.runsWithAnyFail;
    totals.bySourceFormat.docx += outcomeDay.bySourceFormat.docx;
    totals.bySourceFormat.pdf += outcomeDay.bySourceFormat.pdf;
    totals.byMode.standard += outcomeDay.byMode.standard;
    totals.byMode.comprehensive += outcomeDay.byMode.comprehensive;
    byDay.push({ date, runs: outcomeDay.runs });

    for (const [key, entry] of Object.entries(outcomeDay.checkFailures)) {
      let merged = mergedChecks.get(key);

      if (!merged) {
        merged = {
          key,
          title: entry.title,
          sectionId: entry.sectionId,
          runsAffected: 0,
          occurrences: 0,
          severityTally: emptySeverityTally(),
        };
        mergedChecks.set(key, merged);
      }

      merged.runsAffected += entry.runsAffected;
      merged.occurrences += entry.occurrences;
      merged.severityTally.fail += entry.severityTally.fail;
      merged.severityTally.warning += entry.severityTally.warning;
      merged.severityTally.info += entry.severityTally.info;
    }
  }

  byDay.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));

  const topChecks = [...mergedChecks.values()]
    .sort(
      (left, right) =>
        right.runsAffected - left.runsAffected ||
        right.occurrences - left.occurrences ||
        (left.key < right.key ? -1 : 1),
    )
    .slice(0, MAX_TOP_CHECKS)
    .map((entry) => ({
      ...entry,
      percentOfRuns: totals.runs > 0 ? Math.round((entry.runsAffected / totals.runs) * 100) : 0,
    }));

  return {
    windowDays,
    totalRuns: totals.runs,
    bySourceFormat: totals.bySourceFormat,
    byMode: totals.byMode,
    topChecks,
    runsWithAnyFailPercent: totals.runs > 0 ? Math.round((totals.runsWithAnyFail / totals.runs) * 100) : 0,
    byDay,
    updatedAt: metricsState.updatedAt,
    timeZone: metricsTimeZone,
  };
}

export function flushRequestMetrics() {
  return persistChain;
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
