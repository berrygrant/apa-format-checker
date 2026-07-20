import assert from "node:assert/strict";
import test from "node:test";

import { runRuleBasedReview } from "../src/lib/ruleChecks.js";
import { parseRawText, SIMPLE_THESIS_TEXT } from "./helpers/textFixtures.js";

test("produces the five ordered rule sections with coherent summary counts", () => {
  const report = runRuleBasedReview(parseRawText(SIMPLE_THESIS_TEXT));

  assert.deepEqual(
    report.sections.map((section) => section.id),
    ["document", "titlePage", "body", "citations", "references"],
  );

  for (const section of report.sections) {
    assert.ok(["pass", "warning", "fail"].includes(section.status), `unexpected status for ${section.id}`);
    assert.ok(Number.isFinite(section.score));
    assert.ok(Array.isArray(section.findings) && section.findings.length > 0);
  }

  const allFindings = report.sections.flatMap((section) => section.findings);
  assert.equal(report.summary.passCount, allFindings.filter((finding) => finding.status === "pass").length);
  assert.equal(report.summary.warningCount, allFindings.filter((finding) => finding.status === "warning").length);
  assert.equal(report.summary.failCount, allFindings.filter((finding) => finding.status === "fail").length);
  assert.ok(Number.isFinite(report.summary.score));
  assert.ok(report.summary.score >= 0 && report.summary.score <= 100);
  assert.ok(Array.isArray(report.itemIssues));
  assert.ok(Array.isArray(report.limitations) && report.limitations.length > 0);
});

test("matches citations to reference entries in a clean document", () => {
  const report = runRuleBasedReview(parseRawText(SIMPLE_THESIS_TEXT));

  assert.ok(report.metrics.citationCount >= 2);
  assert.deepEqual(report.crossChecks.unmatchedCitations, []);
  assert.ok(!report.itemIssues.some((issue) => issue.title === "In-text citation missing from references"));
});

test("flags a citation that has no matching reference entry", () => {
  const rawText = [
    "A Study of Missing Sources",
    "",
    "This claim rests on earlier findings (Nguyen, 2018).",
    "",
    "References",
    "Walker, M. (2017). Why we sleep. Scribner.",
  ].join("\n");

  const report = runRuleBasedReview(parseRawText(rawText));

  assert.ok(report.crossChecks.unmatchedCitations.includes("nguyen-2018"));
  assert.ok(report.itemIssues.some((issue) => issue.title === "In-text citation missing from references"));
});

test("reports a missing references heading as a failure", () => {
  const report = runRuleBasedReview(parseRawText("A short document with body text only (Lopez, 2021)."));

  const documentSection = report.sections.find((section) => section.id === "document");
  assert.equal(documentSection.status, "fail");
  assert.ok(report.itemIssues.some((issue) => issue.title === "References heading missing"));
});
