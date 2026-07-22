import assert from "node:assert/strict";
import test from "node:test";

import { buildFinalReport, dedupeIssueInventory } from "../src/lib/reportBuilder.js";
import { runRuleBasedReview } from "../src/lib/ruleChecks.js";
import { computeWeightedScore, countByStatus } from "../src/lib/scoring.js";
import { parseRawText, SIMPLE_THESIS_TEXT } from "./helpers/textFixtures.js";

const JOB = {
  id: "job-report-test",
  reviewMode: "standard",
  fileMeta: { name: "thesis.docx", sizeBytes: 1000, mimeType: "application/octet-stream" },
};

const SKIPPED_LLM = {
  skipped: true,
  failed: false,
  model: null,
  rawText: "",
  message: "OPENAI_API_KEY is not configured, so only the rule-based APA review was run.",
  report: null,
};

function llmReviewWithIssues(issues, overrides = {}) {
  return {
    skipped: false,
    failed: false,
    model: "test-model",
    rawText: "{}",
    message: "ok",
    report: {
      overallStatus: "warning",
      overallScore: 95,
      summary: "AI summary.",
      confidence: "medium",
      priorityActions: [],
      limitations: [],
      sections: [
        {
          sectionId: "citations",
          label: "Citations",
          status: "warning",
          summary: "",
          issues,
        },
      ],
      ...overrides,
    },
  };
}

function buildRuleReport(rawText) {
  return runRuleBasedReview(parseRawText(rawText));
}

const ORPHAN_DOCUMENT = [
  "A Study",
  "",
  "This claim rests on earlier findings (Nguyen, 2018).",
  "",
  "References",
  "Walker, M. (2017). Why we sleep. Scribner.",
].join("\n");

test("an equivalent LLM issue dedupes into the rule item instead of appearing twice", () => {
  const parsedDocument = parseRawText(ORPHAN_DOCUMENT);
  const ruleBasedReport = runRuleBasedReview(parsedDocument);
  const llmReview = llmReviewWithIssues([
    {
      severity: "fail",
      title: "Citation missing from reference list",
      detail: "Nguyen (2018) is cited but has no reference entry.",
      recommendation: "Add the Nguyen (2018) entry.",
      locationLabel: "Citations line 3",
      sourceExcerpt: "",
    },
  ]);

  const report = buildFinalReport({ job: JOB, parsedDocument, ruleBasedReport, llmReview });
  const orphanIssues = report.issueInventory.filter((issue) => issue.title.toLowerCase().includes("missing from reference"));

  assert.equal(orphanIssues.length, 1);
  assert.equal(orphanIssues[0].source, "rule_based");
  assert.equal(orphanIssues[0].alsoFlaggedByLlm, true);
});

test("distinct LLM issues survive dedup with their own source", () => {
  const parsedDocument = parseRawText(ORPHAN_DOCUMENT);
  const ruleBasedReport = runRuleBasedReview(parsedDocument);
  const llmReview = llmReviewWithIssues([
    {
      severity: "warning",
      title: "Ampersand used in narrative citation",
      detail: "Narrative citations should use 'and', not '&'.",
      recommendation: "Write 'Lim and Dinges (2010)' in running text.",
      locationLabel: "L4",
      sourceExcerpt: "",
    },
  ]);

  const report = buildFinalReport({ job: JOB, parsedDocument, ruleBasedReport, llmReview });
  const ampersandIssue = report.issueInventory.find((issue) => issue.title.startsWith("Ampersand"));

  assert.ok(ampersandIssue);
  assert.equal(ampersandIssue.source, "llm");
  assert.equal(ampersandIssue.alsoFlaggedByLlm, false);
});

test("headline counts and score derive from deterministic issues; AI-only findings are advisory", () => {
  const parsedDocument = parseRawText(ORPHAN_DOCUMENT);
  const ruleBasedReport = runRuleBasedReview(parsedDocument);
  const llmReview = llmReviewWithIssues([
    {
      severity: "warning",
      title: "Ampersand used in narrative citation",
      detail: "Narrative citations should use 'and', not '&'.",
      recommendation: "Write 'Lim and Dinges (2010)' in running text.",
      locationLabel: "L4",
      sourceExcerpt: "",
    },
  ]);

  const report = buildFinalReport({ job: JOB, parsedDocument, ruleBasedReport, llmReview });
  const deterministicCounts = countByStatus(
    report.issueInventory.filter((issue) => issue.status !== "pass" && issue.source === "rule_based"),
  );

  assert.equal(report.summary.failCount, deterministicCounts.fail);
  assert.equal(report.summary.warningCount, deterministicCounts.warning);
  assert.equal(report.summary.infoCount, deterministicCounts.info);
  assert.equal(report.summary.overallScore, computeWeightedScore(deterministicCounts));
  assert.equal(report.summary.aiFlaggedCount, 1);
  assert.ok(report.issueInventory.some((issue) => issue.source === "llm"), "AI issues stay visible in the inventory");
  assert.deepEqual(report.summary.aiAssessment, { overallScore: 95, overallStatus: "warning", confidence: "medium" });
});

test("the same manuscript grades identically regardless of what the AI pass returns", () => {
  const parsedDocument = parseRawText(ORPHAN_DOCUMENT);
  const ruleBasedReport = runRuleBasedReview(parsedDocument);
  const quietRun = buildFinalReport({ job: JOB, parsedDocument, ruleBasedReport, llmReview: llmReviewWithIssues([]) });
  const noisyRun = buildFinalReport({
    job: JOB,
    parsedDocument,
    ruleBasedReport,
    llmReview: llmReviewWithIssues(
      Array.from({ length: 6 }, (_, index) => ({
        severity: index % 2 === 0 ? "fail" : "warning",
        title: `Run-specific AI finding ${index}`,
        detail: "A finding the model may or may not produce on another run.",
        recommendation: "Varies.",
        locationLabel: `L${20 + index}`,
        sourceExcerpt: "",
      })),
      { overallStatus: "fail", overallScore: 12 },
    ),
  });

  assert.equal(noisyRun.summary.overallScore, quietRun.summary.overallScore);
  assert.equal(noisyRun.summary.overallStatus, quietRun.summary.overallStatus);
  assert.equal(noisyRun.summary.failCount, quietRun.summary.failCount);
  assert.equal(noisyRun.summary.warningCount, quietRun.summary.warningCount);
  assert.equal(noisyRun.summary.aiFlaggedCount, 6);
  assert.equal(quietRun.summary.aiFlaggedCount, 0);
});

test("the skipped-LLM path keeps rule-only counts and no AI assessment", () => {
  const parsedDocument = parseRawText(SIMPLE_THESIS_TEXT);
  const ruleBasedReport = runRuleBasedReview(parsedDocument);
  const report = buildFinalReport({ job: JOB, parsedDocument, ruleBasedReport, llmReview: SKIPPED_LLM });
  const ruleCounts = countByStatus(ruleBasedReport.itemIssues);

  assert.equal(report.version, "3.3.0");
  assert.equal(report.referenceVerification.status, "skipped");
  assert.equal(report.summary.failCount, ruleCounts.fail);
  assert.equal(report.summary.warningCount, ruleCounts.warning);
  assert.equal(report.summary.aiAssessment, null);
  assert.equal(report.summary.overallScore, ruleBasedReport.summary.score);
});

test("dedupeIssueInventory matches on section plus title similarity or line number", () => {
  const ruleItems = [
    {
      id: "rule-1",
      source: "rule_based",
      sectionId: "citations",
      sectionLabel: "Citations",
      status: "fail",
      title: "Malformed et al. citation",
      detail: "",
      recommendation: "",
      location: { lineStart: 12, label: "Citations line 12", excerpt: "" },
    },
  ];
  const llmItems = [
    {
      source: "llm",
      sectionId: "citations",
      sectionLabel: "Citations",
      status: "warning",
      title: "et al. citation is malformed",
      detail: "",
      recommendation: "",
      evidence: null,
      alsoFlaggedByLlm: false,
      location: { lineStart: null, label: "L12", excerpt: "" },
    },
    {
      source: "llm",
      sectionId: "references",
      sectionLabel: "References",
      status: "warning",
      title: "Malformed et al. citation",
      detail: "different section, so it must survive",
      recommendation: "",
      evidence: null,
      alsoFlaggedByLlm: false,
      location: { lineStart: null, label: "R2", excerpt: "" },
    },
  ];

  const inventory = dedupeIssueInventory(ruleItems, llmItems);

  assert.equal(inventory.length, 2);
  assert.equal(inventory[0].alsoFlaggedByLlm, true);
  assert.equal(inventory[1].sectionId, "references");
});
