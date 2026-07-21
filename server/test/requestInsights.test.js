import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// requestMetrics.js reads REQUEST_METRICS_DIR (and the time zone) at import
// time, so every test imports a fresh module instance via a cache-busting
// query after pointing the env at its own temp directory.
const MODULE_URL = new URL("../src/lib/requestMetrics.js", import.meta.url);
let instanceCounter = 0;

async function loadMetricsModule(directory) {
  process.env.REQUEST_METRICS_DIR = directory;
  process.env.REQUEST_METRICS_TIME_ZONE = "UTC";
  instanceCounter += 1;

  return import(`${MODULE_URL.href}?instance=${instanceCounter}`);
}

function createMetricsDir() {
  return mkdtempSync(join(tmpdir(), "apa-insights-test-"));
}

function metricsFilePath(directory) {
  return join(directory, "request-metrics.json");
}

function readPersistedMetrics(directory) {
  return JSON.parse(readFileSync(metricsFilePath(directory), "utf8"));
}

function utcDayKey(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function issue(sectionId, title, status) {
  return { source: "rule_based", sectionId, sectionLabel: sectionId, status, title };
}

function buildReport({ sourceFormat = "docx", mode = "standard", issues = [] } = {}) {
  return {
    version: "3.1.0",
    review: { mode, label: "Standard review" },
    document: { sourceFormat, filename: "never-stored.docx" },
    issueInventory: issues,
  };
}

function outcomeDayFixture({ runs, check }) {
  return {
    runs,
    runsWithAnyFail: runs,
    bySourceFormat: { docx: runs, pdf: 0 },
    byMode: { standard: runs, comprehensive: 0 },
    checkFailures: check
      ? {
          [check.key]: {
            title: check.title,
            sectionId: check.sectionId,
            runsAffected: check.runsAffected,
            occurrences: check.occurrences,
            severityTally: check.severityTally,
          },
        }
      : {},
  };
}

test("recordReviewOutcome aggregates runs, splits, and per-check tallies", async () => {
  const directory = createMetricsDir();
  const metrics = await loadMetricsModule(directory);

  metrics.recordReviewOutcome(
    buildReport({
      sourceFormat: "docx",
      mode: "standard",
      issues: [
        ...Array.from({ length: 12 }, () => issue("citations", "In-text citation missing from references", "fail")),
        issue("layout", "Hanging indent missing", "warning"),
      ],
    }),
  );
  metrics.recordReviewOutcome(
    buildReport({
      sourceFormat: "pdf",
      mode: "comprehensive",
      issues: [issue("citations", "In-text citation missing from references", "warning")],
    }),
  );

  const snapshot = metrics.getInsightsSnapshot({ days: 30 });

  assert.equal(snapshot.windowDays, 30);
  assert.equal(snapshot.totalRuns, 2);
  assert.deepEqual(snapshot.bySourceFormat, { docx: 1, pdf: 1 });
  assert.deepEqual(snapshot.byMode, { standard: 1, comprehensive: 1 });
  assert.equal(snapshot.runsWithAnyFailPercent, 50);
  assert.deepEqual(snapshot.byDay, [{ date: utcDayKey(0), runs: 2 }]);

  assert.equal(snapshot.topChecks.length, 2);
  const [orphanCheck, hangingCheck] = snapshot.topChecks;

  // runsAffected counts each report once per check; occurrences keep every issue.
  assert.equal(orphanCheck.key, "citations:in-text citation missing from references");
  assert.equal(orphanCheck.title, "In-text citation missing from references");
  assert.equal(orphanCheck.sectionId, "citations");
  assert.equal(orphanCheck.runsAffected, 2);
  assert.equal(orphanCheck.occurrences, 13);
  assert.deepEqual(orphanCheck.severityTally, { fail: 12, warning: 1, info: 0 });
  assert.equal(orphanCheck.percentOfRuns, 100);

  assert.equal(hangingCheck.key, "layout:hanging indent missing");
  assert.equal(hangingCheck.runsAffected, 1);
  assert.equal(hangingCheck.occurrences, 1);
  assert.equal(hangingCheck.percentOfRuns, 50);

  // The persisted snapshot must survive a fresh module load (new container).
  await metrics.flushRequestMetrics();
  const reloaded = await loadMetricsModule(directory);
  assert.deepEqual(reloaded.getInsightsSnapshot({ days: 30 }).topChecks, snapshot.topChecks);
});

test("check keys normalize whitespace and case so LLM title variants merge", async () => {
  const metrics = await loadMetricsModule(createMetricsDir());

  metrics.recordReviewOutcome(buildReport({ issues: [issue("layout", "Hanging   Indent Missing", "fail")] }));
  metrics.recordReviewOutcome(buildReport({ issues: [issue("layout", "hanging indent missing", "warning")] }));

  const snapshot = metrics.getInsightsSnapshot();

  assert.equal(snapshot.topChecks.length, 1);
  assert.equal(snapshot.topChecks[0].key, "layout:hanging indent missing");
  assert.equal(snapshot.topChecks[0].runsAffected, 2);
  assert.deepEqual(snapshot.topChecks[0].severityTally, { fail: 1, warning: 1, info: 0 });
});

test("pass items, unknown severities, and untitled issues are ignored", async () => {
  const metrics = await loadMetricsModule(createMetricsDir());

  metrics.recordReviewOutcome(
    buildReport({
      issues: [
        issue("layout", "Margins verified", "pass"),
        issue("layout", "Mystery severity", "banana"),
        issue("layout", "   ", "warning"),
      ],
    }),
  );

  const snapshot = metrics.getInsightsSnapshot();

  assert.equal(snapshot.totalRuns, 1);
  assert.equal(snapshot.runsWithAnyFailPercent, 0);
  assert.deepEqual(snapshot.topChecks, []);
});

test("malformed reports never throw and only object reports count as runs", async () => {
  const metrics = await loadMetricsModule(createMetricsDir());

  metrics.recordReviewOutcome(null);
  metrics.recordReviewOutcome(undefined);
  metrics.recordReviewOutcome("not-a-report");
  metrics.recordReviewOutcome({ review: 7, document: null, issueInventory: "nope" });

  const snapshot = metrics.getInsightsSnapshot();

  assert.equal(snapshot.totalRuns, 1);
  assert.deepEqual(snapshot.bySourceFormat, { docx: 0, pdf: 0 });
  assert.deepEqual(snapshot.byMode, { standard: 0, comprehensive: 0 });
});

test("distinct check keys cap at 150 per day and topChecks caps at 25", async () => {
  const directory = createMetricsDir();
  const metrics = await loadMetricsModule(directory);

  metrics.recordReviewOutcome(
    buildReport({
      issues: Array.from({ length: 160 }, (_, index) => issue("citations", `Distinct check ${index}`, "fail")),
    }),
  );
  // A later report: one brand-new key (dropped silently) plus one existing key
  // (which must keep counting).
  metrics.recordReviewOutcome(
    buildReport({
      issues: [issue("citations", "Distinct check 999", "fail"), issue("citations", "Distinct check 0", "fail")],
    }),
  );
  await metrics.flushRequestMetrics();

  const persisted = readPersistedMetrics(directory);
  const storedKeys = Object.keys(persisted.reviewOutcomes.days[utcDayKey(0)].checkFailures);

  assert.equal(storedKeys.length, 150);
  assert.ok(!storedKeys.includes("citations:distinct check 999"));

  const snapshot = metrics.getInsightsSnapshot();

  assert.equal(snapshot.topChecks.length, 25);
  assert.equal(snapshot.topChecks[0].key, "citations:distinct check 0");
  assert.equal(snapshot.topChecks[0].runsAffected, 2);
});

test("stored outcome days prune to the newest 120", async () => {
  const directory = createMetricsDir();
  const days = {};

  for (let daysAgo = 1; daysAgo <= 120; daysAgo += 1) {
    days[utcDayKey(daysAgo)] = outcomeDayFixture({ runs: 1 });
  }

  writeFileSync(
    metricsFilePath(directory),
    JSON.stringify({ total: 120, byDay: {}, updatedAt: new Date().toISOString(), reviewOutcomes: { days } }),
  );

  const metrics = await loadMetricsModule(directory);
  metrics.recordReviewOutcome(buildReport({ issues: [] }));
  await metrics.flushRequestMetrics();

  const persistedDays = Object.keys(readPersistedMetrics(directory).reviewOutcomes.days);

  assert.equal(persistedDays.length, 120);
  assert.ok(persistedDays.includes(utcDayKey(0)), "today must be kept");
  assert.ok(!persistedDays.includes(utcDayKey(120)), "the oldest day must be pruned");
});

test("insights aggregate only the requested window and clamp the day count", async () => {
  const directory = createMetricsDir();
  const oldCheck = {
    key: "layout:hanging indent missing",
    title: "Hanging indent missing",
    sectionId: "layout",
    runsAffected: 5,
    occurrences: 9,
    severityTally: { fail: 9, warning: 0, info: 0 },
  };

  writeFileSync(
    metricsFilePath(directory),
    JSON.stringify({
      total: 5,
      byDay: {},
      updatedAt: new Date().toISOString(),
      reviewOutcomes: { days: { [utcDayKey(40)]: outcomeDayFixture({ runs: 5, check: oldCheck }) } },
    }),
  );

  const metrics = await loadMetricsModule(directory);
  metrics.recordReviewOutcome(buildReport({ issues: [issue("layout", "Hanging indent missing", "fail")] }));

  const narrow = metrics.getInsightsSnapshot({ days: 30 });
  assert.equal(narrow.totalRuns, 1);
  assert.deepEqual(narrow.byDay, [{ date: utcDayKey(0), runs: 1 }]);
  assert.equal(narrow.topChecks[0].runsAffected, 1);

  const wide = metrics.getInsightsSnapshot({ days: 120 });
  assert.equal(wide.totalRuns, 6);
  assert.deepEqual(wide.byDay, [
    { date: utcDayKey(40), runs: 5 },
    { date: utcDayKey(0), runs: 1 },
  ]);
  assert.equal(wide.topChecks[0].runsAffected, 6);
  assert.equal(wide.topChecks[0].occurrences, 10);
  assert.equal(wide.topChecks[0].percentOfRuns, 100);
  assert.equal(wide.runsWithAnyFailPercent, 100);

  assert.equal(metrics.getInsightsSnapshot({ days: 999 }).windowDays, 120);
  assert.equal(metrics.getInsightsSnapshot({ days: 0 }).windowDays, 1);
  assert.equal(metrics.getInsightsSnapshot({ days: "nonsense" }).windowDays, 30);
  assert.equal(metrics.getInsightsSnapshot().windowDays, 30);
});

test("an empty store yields a zeroed snapshot", async () => {
  const metrics = await loadMetricsModule(createMetricsDir());
  const snapshot = metrics.getInsightsSnapshot();

  assert.equal(snapshot.windowDays, 30);
  assert.equal(snapshot.totalRuns, 0);
  assert.deepEqual(snapshot.bySourceFormat, { docx: 0, pdf: 0 });
  assert.deepEqual(snapshot.byMode, { standard: 0, comprehensive: 0 });
  assert.deepEqual(snapshot.topChecks, []);
  assert.equal(snapshot.runsWithAnyFailPercent, 0);
  assert.deepEqual(snapshot.byDay, []);
});

test("old-format metrics files load without the new fields and keep working", async () => {
  const directory = createMetricsDir();

  writeFileSync(
    metricsFilePath(directory),
    JSON.stringify({ total: 7, byDay: { "2026-07-01": 7 }, updatedAt: "2026-07-01T12:00:00.000Z" }, null, 2),
  );

  const metrics = await loadMetricsModule(directory);

  assert.equal(metrics.getRequestMetricsSnapshot().total, 7);
  assert.equal(metrics.getInsightsSnapshot().totalRuns, 0);

  metrics.recordReviewOutcome(buildReport({ issues: [issue("layout", "Hanging indent missing", "fail")] }));
  await metrics.flushRequestMetrics();

  const persisted = readPersistedMetrics(directory);

  assert.equal(persisted.total, 7, "legacy request totals must survive the upgrade");
  assert.deepEqual(persisted.byDay, { "2026-07-01": 7 });
  assert.equal(persisted.reviewOutcomes.days[utcDayKey(0)].runs, 1);
});

test("privacy: the persisted store never contains filenames or excerpts", async () => {
  const directory = createMetricsDir();
  const metrics = await loadMetricsModule(directory);

  metrics.recordReviewOutcome(
    buildReport({
      issues: [
        {
          ...issue("citations", "In-text citation missing from references", "fail"),
          detail: "SECRET-DETAIL Nguyen (2018) is cited but missing.",
          evidence: "SECRET-EXCERPT from the student document.",
          location: { label: "Citations line 3", excerpt: "SECRET-EXCERPT again" },
        },
      ],
    }),
  );
  await metrics.flushRequestMetrics();

  const rawFile = readFileSync(metricsFilePath(directory), "utf8");

  assert.ok(!rawFile.includes("never-stored.docx"), "filenames must not be persisted");
  assert.ok(!rawFile.includes("SECRET"), "issue details/excerpts must not be persisted");
});
