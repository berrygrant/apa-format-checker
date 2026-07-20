import assert from "node:assert/strict";
import test from "node:test";

import { extractCitationData, runRuleBasedReview } from "../src/lib/ruleChecks.js";
import { parseRawText } from "./helpers/textFixtures.js";

function makeLineRecords(lines) {
  return lines.map((text, index) => ({
    lineNumber: index + 1,
    paragraphNumber: index + 1,
    text,
    zone: "main",
  }));
}

function extractFrom(text) {
  return extractCitationData(makeLineRecords([text]));
}

test("ignores parentheticals that merely contain a year", () => {
  assert.equal(extractFrom("The downturn (the 2008 recession) shaped funding.").pairs.length, 0);
  assert.equal(extractFrom("Our sample (data collected 2018–2020) was large.").pairs.length, 0);
  assert.equal(extractFrom("The survey window (2020) was short.").pairs.length, 0);
});

test("extracts a standard parenthetical citation", () => {
  const { pairs } = extractFrom("Feedback improves outcomes (Smith, 2020).");

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].author, "Smith");
  assert.equal(pairs[0].year, "2020");
  assert.equal(pairs[0].key, "smith-2020");
  assert.equal(pairs[0].type, "parenthetical");
});

test("splits multi-citation parentheticals and strips lead-ins", () => {
  const { pairs, formattingIssues } = extractFrom("Effects are robust (e.g., Smith & Lee, 2020; Jones, 2019).");

  assert.deepEqual(
    pairs.map((pair) => pair.key),
    ["smith-2020", "jones-2019"],
  );
  assert.deepEqual(formattingIssues, [], "a lead-in inside a parenthetical is valid APA, not a signal-bare citation");
});

test("handles organizational authors with bracketed abbreviations", () => {
  const { pairs } = extractFrom("Prevalence is rising (National Institute of Mental Health [NIMH], 2020).");

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].author, "National Institute of Mental Health");
  assert.equal(pairs[0].year, "2020");
});

test("accepts locators and year lists inside parentheticals", () => {
  assert.equal(extractFrom("This was shown earlier (see Smith, 2020, p. 12).").pairs[0].key, "smith-2020");
  assert.equal(extractFrom("The quote appears later (Smith, 2020, pp. 12-14).").pairs[0].key, "smith-2020");

  const yearList = extractFrom("Two related studies exist (Smith, 2020a, 2020b).").pairs;
  assert.deepEqual(
    yearList.map((pair) => pair.year),
    ["2020a", "2020b"],
  );
});

test("captures narrative citations that include a page locator", () => {
  const { pairs } = extractFrom("Smith (2020, p. 5) argued the effect was small.");

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].type, "narrative");
  assert.equal(pairs[0].key, "smith-2020");
});

test("does not treat labeled document parts as narrative authors", () => {
  assert.equal(extractFrom("Table 3 (2020) summarizes the sample.").pairs.length, 0);
  assert.equal(extractFrom("Study 1 (2019) used a smaller cohort.").pairs.length, 0);
});

test("flags a missing author-year comma but still counts the citation", () => {
  const { pairs, formattingIssues } = extractFrom("Feedback improves outcomes (Smith 2020).");

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].key, "smith-2020");
  assert.equal(formattingIssues.length, 1);
  assert.match(formattingIssues[0].detail, /missing the comma/i);
});

test("recognizes n.d. citations without generating cross-check keys", () => {
  const { pairs } = extractFrom("The agency continues to report this (Smith, n.d.).");

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].year, "n.d.");
  assert.equal(pairs[0].key, null);
});

test("cross-checks against the source after 'as cited in'", () => {
  const { pairs } = extractFrom("Earlier work agrees (Jones, 1998, as cited in Smith, 2020).");

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].key, "smith-2020");
});

const ET_AL_DOCUMENT = [
  "A Study of Citation Habits",
  "",
  "Wrong period placement is common, as Smith et. al. showed in 2020.",
  "Some drafts drop the period entirely, as Jones et al argued.",
  "Correct usage also appears throughout (Brown et al., 2019).",
  "",
  "References",
  "Brown, A., Lee, B., & Chen, C. (2019). Citation habits. Journal of Writing, 8(1), 1-10.",
].join("\n");

test("flags 'et. al.' and bare 'et al' while passing correct 'et al.'", () => {
  const report = runRuleBasedReview(parseRawText(ET_AL_DOCUMENT));
  const malformedIssues = report.itemIssues.filter((issue) => issue.title === "Malformed et al. citation");

  assert.equal(malformedIssues.length, 2);
  assert.ok(malformedIssues.some((issue) => issue.detail.includes("et. al.")));
  assert.ok(malformedIssues.some((issue) => issue.detail.includes("et al")));
  assert.ok(!malformedIssues.some((issue) => issue.detail.includes("Brown et al.,")));
});

test("passes correct et al. citations without malformed flags", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "Clean Citations",
        "",
        "The effect replicates (Brown et al., 2019). Brown et al. (2019) agree.",
        "",
        "References",
        "Brown, A., Lee, B., & Chen, C. (2019). Citation habits. Journal of Writing, 8(1), 1-10.",
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "Malformed et al. citation"));
});
