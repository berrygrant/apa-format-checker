import assert from "node:assert/strict";
import test from "node:test";

import { findReferencesHeading } from "../src/lib/docxParser.js";
import { runRuleBasedReview } from "../src/lib/ruleChecks.js";
import { parseRawText } from "./helpers/textFixtures.js";

test("recognizes common reference-list heading variants", () => {
  for (const heading of ["References", "REFERENCES", "References:", "Reference List", "Bibliography", "Works Cited"]) {
    const parsed = parseRawText(["Body text before the list.", "", heading, "Adams, B. (2019). A study. Journal, 1(1), 1-10."].join("\n"));
    assert.equal(parsed.referencesMissing, false, `expected "${heading}" to be detected`);
  }
});

test("a table-of-contents entry cannot hijack the references split", () => {
  const parsed = parseRawText(
    [
      "Contents overview",
      "References",
      "",
      "Introduction",
      "Long body content with a citation (Smith, 2020).",
      "",
      "References",
      "Smith, J. (2020). A study. Journal, 2(1), 1-9.",
    ].join("\n"),
  );

  assert.equal(parsed.referencesMissing, false);
  assert.equal(parsed.referenceEntryRecords.length, 1);
  assert.match(parsed.referenceEntryRecords[0].text, /^Smith, J\./);
  assert.ok(parsed.referencesHeadingLineNumber > 2, "the later heading should win");
});

test("findReferencesHeading returns the last matching line and its label", () => {
  const { index, label } = findReferencesHeading(["References", "body", "Bibliography"]);

  assert.equal(index, 2);
  assert.equal(label, "Bibliography");
});

test("a non-APA reference-list label produces a warning instead of a hard failure", () => {
  const report = runRuleBasedReview(
    parseRawText(
      ["A Study", "", "Findings were clear (Adams, 2019).", "", "Bibliography", "Adams, B. (2019). A study. Journal, 1(1), 1-10."].join(
        "\n",
      ),
    ),
  );

  const documentSection = report.sections.find((section) => section.id === "document");

  assert.ok(!report.itemIssues.some((issue) => issue.title === "References heading missing"));
  assert.ok(report.itemIssues.some((issue) => issue.title === "Non-APA reference-list label"));
  assert.ok(documentSection.findings.some((finding) => finding.title === "Non-APA reference-list label"));
});

test("sentences that start with a number are not numbered headings", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "5 participants were excluded from the final analysis due to attrition.",
        "12 items were reverse-scored before analysis.",
        "",
        "References",
        "Adams, B. (2019). A study. Journal, 1(1), 1-10.",
      ].join("\n"),
    ),
  );

  const bodySection = report.sections.find((section) => section.id === "body");

  assert.equal(bodySection.metrics.numberedHeadingIssueCount, 0);
  assert.ok(!report.itemIssues.some((issue) => issue.title.includes("Section numbering")));
});

test("numbered-heading continuity still fires when numbering is clearly used", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "2. Method",
        "Participants completed the battery.",
        "",
        "3. Results",
        "Scores improved.",
        "",
        "References",
        "Adams, B. (2019). A study. Journal, 1(1), 1-10.",
      ].join("\n"),
    ),
  );

  const numberingIssues = report.itemIssues.filter((issue) => issue.title === "Section numbering out of sequence");

  assert.equal(numberingIssues.length, 1);
  assert.match(numberingIssues[0].detail, /starts at 2 instead of 1/);
});

test("a single numbered line does not trigger continuity checks", () => {
  const report = runRuleBasedReview(
    parseRawText(
      ["A Study", "", "3. Results", "Scores improved.", "", "References", "Adams, B. (2019). A study. Journal, 1(1), 1-10."].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title.includes("Section numbering")));
});

test("an APA 7 student title page passes without a 'by' line", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "Effects of Sleep on Memory",
        "Jordan Rivera",
        "Department of Psychology, Example University",
        "PSY 6100: Thesis Seminar",
        "Dr. Casey Morgan",
        "May 4, 2026",
        "",
        "Sleep predicts memory (Walker, 2017).",
        "",
        "References",
        "Walker, M. (2017). Why we sleep. Scribner.",
      ].join("\n"),
    ),
  );

  const titleSection = report.sections.find((section) => section.id === "titlePage");
  const elementsFinding = titleSection.findings.find((finding) => finding.title.startsWith("Student title-page elements"));

  assert.equal(elementsFinding.status, "pass");
  assert.ok(!report.itemIssues.some((issue) => issue.title === "Student title-page elements incomplete"));
});

test("a bare title page warns and names the missing elements", () => {
  const report = runRuleBasedReview(
    parseRawText(
      ["Some Title Only", "", "Body sentence with a citation (Walker, 2017).", "", "References", "Walker, M. (2017). Why we sleep. Scribner."].join(
        "\n",
      ),
    ),
  );

  const incompleteIssue = report.itemIssues.find((issue) => issue.title === "Student title-page elements incomplete");

  assert.ok(incompleteIssue);
  assert.match(incompleteIssue.detail, /course number/);
  assert.match(incompleteIssue.detail, /instructor/);
});

test("heading variants like Methods and Findings count as section headings", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "Methods",
        "Participants completed the battery.",
        "",
        "Findings",
        "Scores improved.",
        "",
        "References",
        "Adams, B. (2019). A study. Journal, 1(1), 1-10.",
      ].join("\n"),
    ),
  );

  const bodySection = report.sections.find((section) => section.id === "body");

  assert.ok(bodySection.metrics.headingCount >= 2);
});

test("extraction copy names the actual source format", () => {
  const pdfReport = runRuleBasedReview(parseRawText("Only body text here.", { sourceFormat: "pdf" }));
  const docxReport = runRuleBasedReview(parseRawText("Only body text here."));

  const pdfFinding = pdfReport.sections.find((section) => section.id === "document").findings[0];
  const docxFinding = docxReport.sections.find((section) => section.id === "document").findings[0];

  assert.equal(pdfFinding.title, "PDF extraction");
  assert.equal(docxFinding.title, "DOCX extraction");
});
