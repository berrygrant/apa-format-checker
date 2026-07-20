import assert from "node:assert/strict";
import test from "node:test";

import { computeReferenceOrdering, runRuleBasedReview } from "../src/lib/ruleChecks.js";
import { parseRawText } from "./helpers/textFixtures.js";

test("repeated orphan citations collapse into one issue with an occurrence count", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "First claim (Nguyen, 2018). Second claim (Nguyen, 2018).",
        "Third claim (Nguyen, 2018). Fourth claim (Nguyen, 2018). Fifth claim (Nguyen, 2018).",
        "",
        "References",
        "Walker, M. (2017). Why we sleep. Scribner.",
      ].join("\n"),
    ),
  );

  const orphanIssues = report.itemIssues.filter((issue) => issue.title === "In-text citation missing from references");
  const citationsSection = report.sections.find((section) => section.id === "citations");
  const crosswalkFinding = citationsSection.findings.find((finding) => finding.title === "Citations missing from references");

  assert.equal(orphanIssues.length, 1);
  assert.match(orphanIssues[0].detail, /appears 5 times/);
  assert.equal(citationsSection.metrics.unmatchedCitationCount, 1);
  assert.equal(crosswalkFinding.status, "warning", "one unique orphan should not escalate to fail");
});

test("three unique orphan sources still escalate the crosswalk finding to fail", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "Claims (Nguyen, 2018), (Ortiz, 2019), and (Price, 2021) all lack entries.",
        "",
        "References",
        "Walker, M. (2017). Why we sleep. Scribner.",
      ].join("\n"),
    ),
  );

  const citationsSection = report.sections.find((section) => section.id === "citations");
  const crosswalkFinding = citationsSection.findings.find((finding) => finding.title === "Citations missing from references");

  assert.equal(citationsSection.metrics.unmatchedCitationCount, 3);
  assert.equal(crosswalkFinding.status, "fail");
});

test("year-suffix citations match their reference entry in both directions", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "The first paper (Smith, 2020a) and the follow-up (Jones, 2019) both matter.",
        "",
        "References",
        "Jones, A. (2019a). Follow-up work. Journal, 3(1), 4-9.",
        "",
        "Smith, J. (2020). Original work. Journal, 2(1), 1-9.",
      ].join("\n"),
    ),
  );

  assert.deepEqual(report.crossChecks.unmatchedCitations, []);
  assert.deepEqual(report.crossChecks.uncitedReferences, []);
  assert.ok(!report.itemIssues.some((issue) => issue.title === "In-text citation missing from references"));
  assert.ok(!report.itemIssues.some((issue) => issue.title === "Reference entry may be uncited"));
});

test("scare quotes do not trigger the quote-locator warning", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        'The concept of "grit" and the so-called "replication crisis" appear often (Smith, 2020).',
        "",
        "References",
        "Smith, J. (2020). Original work. Journal, 2(1), 1-9.",
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "Quoted text may lack locator citation"));
});

test("a substantial quotation without a locator still warns", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        'Smith concluded that "students who receive timely feedback revise their drafts far more thoroughly than peers" (Smith, 2020).',
        "",
        "References",
        "Smith, J. (2020). Original work. Journal, 2(1), 1-9.",
      ].join("\n"),
    ),
  );

  assert.ok(report.itemIssues.some((issue) => issue.title === "Quoted text may lack locator citation"));
});

test("a substantial quotation with a page locator passes", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        'Smith concluded that "students who receive timely feedback revise their drafts far more thoroughly than peers" (Smith, 2020, p. 3).',
        "",
        "References",
        "Smith, J. (2020). Original work. Journal, 2(1), 1-9.",
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "Quoted text may lack locator citation"));
});

test("dx.doi.org URLs are legacy-format info, not bare-DOI warnings", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "Claims are supported (Adams, 2019; Baker, 2020; Cruz, 2021).",
        "",
        "References",
        "Adams, B. (2019). First. Journal, 1(1), 1-10. http://dx.doi.org/10.1037/a0021524",
        "",
        "Baker, C. (2020). Second. Journal, 2(1), 1-10. 10.1037/b0031525",
        "",
        "Cruz, D. (2021). Third. Journal, 3(1), 1-10. https://doi.org/10.1037/c0041526",
      ].join("\n"),
    ),
  );

  const bareDoiIssues = report.itemIssues.filter((issue) => issue.title === "Reference entry contains bare DOI");
  const legacyIssues = report.itemIssues.filter((issue) => issue.title === "Legacy DOI URL format");

  assert.equal(bareDoiIssues.length, 1);
  assert.match(bareDoiIssues[0].location.excerpt, /Baker/);
  assert.equal(legacyIssues.length, 1);
  assert.equal(legacyIssues[0].status, "info");
  assert.match(legacyIssues[0].location.excerpt, /Adams/);
});

test("computeReferenceOrdering flags surname disorder exactly once per adjacent pair", () => {
  const ordering = computeReferenceOrdering([
    { author: "Zimmer", year: "2019" },
    { author: "Adams", year: "2020" },
    { author: "Baker", year: "2021" },
  ]);

  assert.equal(ordering.isSorted, false);
  assert.equal(ordering.issues.length, 1);
  assert.equal(ordering.issues[0].reason, "surname");
});

test("computeReferenceOrdering applies the same-author year tie-break", () => {
  const ordering = computeReferenceOrdering([
    { author: "Smith", year: "2021" },
    { author: "Smith", year: "2019" },
  ]);

  assert.equal(ordering.isSorted, false);
  assert.equal(ordering.issues[0].reason, "year");
});

test("computeReferenceOrdering accepts a correctly sorted list", () => {
  const ordering = computeReferenceOrdering([
    { author: "Adams", year: "2020" },
    { author: "Smith", year: "2019" },
    { author: "Smith", year: "2021" },
  ]);

  assert.equal(ordering.isSorted, true);
  assert.deepEqual(ordering.issues, []);
});

test("ordering issues and the section finding come from the same computation", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "Both papers matter (Zimmer, 2019; Adams, 2020).",
        "",
        "References",
        "Zimmer, Z. (2019). Later letters first. Journal, 1(1), 1-10.",
        "",
        "Adams, A. (2020). Early letters second. Journal, 2(1), 1-10.",
      ].join("\n"),
    ),
  );

  const referencesSection = report.sections.find((section) => section.id === "references");
  const orderingFinding = referencesSection.findings.find((finding) => finding.title.startsWith("Alphabetical ordering"));
  const orderingIssues = report.itemIssues.filter((issue) => issue.title === "Reference entry out of alphabetical order");

  assert.equal(orderingFinding.status, "warning");
  assert.equal(orderingIssues.length, 1);
});
