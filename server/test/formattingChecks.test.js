import assert from "node:assert/strict";
import test from "node:test";

import { extractDocxLayout } from "../src/lib/docxLayout.js";
import { parseDocxBuffer } from "../src/lib/docxParser.js";
import { analyzeReferenceItalics, analyzeStatisticsFormatting, mergeAnalyzerResults } from "../src/lib/formattingChecks.js";
import { analyzeBody, buildSection, makeFinding, runRuleBasedReview } from "../src/lib/ruleChecks.js";
import { buildDocxBuffer } from "./helpers/buildDocxFixture.js";
import { parseRawText, SIMPLE_THESIS_TEXT } from "./helpers/textFixtures.js";

function paragraphFromRuns(runs) {
  const normalizedRuns = runs.map((run) => ({ text: run.text, italic: Boolean(run.italic), bold: Boolean(run.bold) }));
  return { text: normalizedRuns.map((run) => run.text).join(""), runs: normalizedRuns };
}

function runFactsFrom(mainParagraphs = [], referenceParagraphs = []) {
  return { mainParagraphs, referenceParagraphs };
}

const DOCX_PARSED = parseRawText("A body line for context.");
const PDF_PARSED = parseRawText("A body line for context.", { sourceFormat: "pdf" });

// --- Statistics italics (run-level, DOCX only) ---

test("stats round-trip: an italic p in a DOCX yields the pass finding and no issues", async () => {
  const buffer = await buildDocxBuffer({
    paragraphs: [
      "Sleep Loss and Memory Consolidation",
      {
        runs: [
          { text: "Working memory declined under sleep loss, " },
          { text: "p", italics: true },
          { text: " = .03." },
        ],
      },
    ],
    referenceEntries: ["Walker, M. (2017). Why we sleep. Scribner."],
  });
  const layout = await extractDocxLayout(buffer);
  const parsed = await parseDocxBuffer(buffer);
  const result = analyzeStatisticsFormatting(parsed, layout.runs);

  assert.equal(result.itemIssues.length, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].status, "pass");
  assert.equal(result.findings[0].title, "Statistical symbols italicized");
});

test("stats round-trip: plain p and t are flagged with line-mapped locations", async () => {
  const buffer = await buildDocxBuffer({
    paragraphs: ["A Study Title", "The effect was reliable, p = .03, and strong, t(34) = 2.10."],
    referenceEntries: ["Walker, M. (2017). Why we sleep. Scribner."],
  });
  const layout = await extractDocxLayout(buffer);
  const parsed = await parseDocxBuffer(buffer);
  const result = analyzeStatisticsFormatting(parsed, layout.runs);

  assert.deepEqual(
    result.itemIssues.map((issue) => issue.status),
    ["warning", "warning"],
  );
  assert.match(result.itemIssues[0].detail, /"p"/);
  assert.match(result.itemIssues[1].detail, /"t"/);
  assert.equal(typeof result.itemIssues[0].location.lineStart, "number");
  assert.equal(result.findings[0].status, "warning");
  assert.equal(result.findings[0].title, "Statistical symbols not italicized");
});

test("stats matches only APA symbol shapes, not lookalike tokens", () => {
  const negatives = [
    "The pH = 7 reading stayed constant across sessions.",
    "Group P = 4 sessions were scheduled.",
    "The VAR2 = 3 configuration was reused.",
    "A sentence with no statistics at all.",
  ];

  for (const text of negatives) {
    const result = analyzeStatisticsFormatting(DOCX_PARSED, runFactsFrom([paragraphFromRuns([{ text }])]));
    assert.deepEqual(result, { findings: [], itemIssues: [] }, `expected no findings for: ${text}`);
  }

  const positives = analyzeStatisticsFormatting(
    DOCX_PARSED,
    runFactsFrom([paragraphFromRuns([{ text: "Scores rose, M = 4.2, SD = 1.1, R2 = .45, n = 34, N > 100, d = 0.5." }])]),
  );

  assert.deepEqual(
    positives.itemIssues.map((issue) => issue.detail.match(/"([^"]+)"/)[1]),
    ["M", "SD", "R2", "n", "N", "d"],
  );
});

test("stats symbol inside a wider italic run still counts as italicized", () => {
  const result = analyzeStatisticsFormatting(
    DOCX_PARSED,
    runFactsFrom([
      paragraphFromRuns([
        { text: "The contrast was significant (" },
        { text: "p", italic: true },
        { text: " = .03) overall, and " },
        { text: "t(34) = 2.10", italic: true },
        { text: " confirmed it." },
      ]),
    ]),
  );

  assert.equal(result.itemIssues.length, 0);
  assert.equal(result.findings[0].status, "pass");
});

test("stats issues dedupe per symbol per paragraph and cap at 20 with a +N note", () => {
  const deduped = analyzeStatisticsFormatting(
    DOCX_PARSED,
    runFactsFrom([paragraphFromRuns([{ text: "First p = .01 and second p = .02 differ." }])]),
  );

  assert.equal(deduped.itemIssues.length, 1);
  assert.match(deduped.findings[0].detail, /2 of 2/);

  const manyParagraphs = Array.from({ length: 25 }, (_, index) =>
    paragraphFromRuns([{ text: `Model ${index} shows p = .0${(index % 9) + 1} overall.` }]),
  );
  const capped = analyzeStatisticsFormatting(DOCX_PARSED, runFactsFrom(manyParagraphs));

  assert.equal(capped.itemIssues.length, 20);
  assert.match(capped.findings[0].detail, /\+5 more/);
});

test("stats checks are skipped for PDFs and missing run facts", () => {
  const statsRunFacts = runFactsFrom([paragraphFromRuns([{ text: "The result was p = .03 overall." }])]);

  assert.deepEqual(analyzeStatisticsFormatting(PDF_PARSED, statsRunFacts), { findings: [], itemIssues: [] });
  assert.deepEqual(analyzeStatisticsFormatting(DOCX_PARSED, null), { findings: [], itemIssues: [] });
});

// --- Reference italics (run-level, DOCX only) ---

test("reference italics round-trip: plain entry flagged, italic-title entry passes", async () => {
  const buffer = await buildDocxBuffer({
    paragraphs: ["A Title", "A body sentence about the findings."],
    referenceEntries: [
      {
        runs: [
          { text: "Lim, J., & Dinges, D. F. (2010). A meta-analysis of sleep deprivation effects. " },
          { text: "Psychological Bulletin", italics: true },
          { text: ", 136(3), 375-389." },
        ],
      },
      "Walker, M. (2017). Why we sleep: Unlocking the power of sleep and dreams. Scribner.",
    ],
  });
  const layout = await extractDocxLayout(buffer);
  const parsed = await parseDocxBuffer(buffer);
  const result = analyzeReferenceItalics(parsed, layout.runs);

  assert.equal(result.itemIssues.length, 1);
  assert.match(result.itemIssues[0].detail, /Walker/);
  assert.equal(result.itemIssues[0].location.entryNumber, 2);
  assert.equal(result.findings[0].status, "warning");
  assert.equal(result.findings[0].title, "Reference entries missing italicized titles");
});

test("reference italics passes when every scanned entry has an italic title span", () => {
  const result = analyzeReferenceItalics(
    DOCX_PARSED,
    runFactsFrom(
      [],
      [
        paragraphFromRuns([
          { text: "Lim, J., & Dinges, D. F. (2010). A meta-analysis of sleep deprivation. " },
          { text: "Psychological Bulletin", italic: true },
          { text: ", 136(3), 375-389." },
        ]),
      ],
    ),
  );

  assert.equal(result.itemIssues.length, 0);
  assert.equal(result.findings[0].status, "pass");
  assert.equal(result.findings[0].title, "Reference titles italicized");
});

test("adjacent italic runs merge into one title span", () => {
  const result = analyzeReferenceItalics(
    DOCX_PARSED,
    runFactsFrom(
      [],
      [
        paragraphFromRuns([
          { text: "Lim, J., & Dinges, D. F. (2010). Sleep deprivation and cognition. " },
          { text: "Psychological ", italic: true },
          { text: "Bulletin", italic: true },
          { text: ", 136(3), 375-389." },
        ]),
      ],
    ),
  );

  assert.equal(result.itemIssues.length, 0);
  assert.equal(result.findings[0].status, "pass");
});

test("reference italics ignores short paragraphs and prose without a year", () => {
  const result = analyzeReferenceItalics(
    DOCX_PARSED,
    runFactsFrom(
      [],
      [
        paragraphFromRuns([{ text: "Appendix A" }]),
        paragraphFromRuns([{ text: "Walker, M. (2017). Sleep. Scribner." }]),
        paragraphFromRuns([{ text: "This appendix paragraph has plenty of words but no year marker at all." }]),
      ],
    ),
  );

  assert.deepEqual(result, { findings: [], itemIssues: [] });
});

test("reference italics issues cap at 15 with a +N note", () => {
  const entries = Array.from({ length: 20 }, (_, index) =>
    paragraphFromRuns([{ text: `Author${index}, A. (2000). A sufficiently long article title here. Journal of Tests, 1(1), 1-10.` }]),
  );
  const result = analyzeReferenceItalics(DOCX_PARSED, runFactsFrom([], entries));

  assert.equal(result.itemIssues.length, 15);
  assert.match(result.findings[0].detail, /\+5 more/);
});

test("reference italics is skipped for PDFs and missing run facts", () => {
  const entryRunFacts = runFactsFrom(
    [],
    [paragraphFromRuns([{ text: "Walker, M. (2017). Why we sleep: Unlocking the power of sleep. Scribner." }])],
  );

  assert.deepEqual(analyzeReferenceItalics(PDF_PARSED, entryRunFacts), { findings: [], itemIssues: [] });
  assert.deepEqual(analyzeReferenceItalics(DOCX_PARSED, null), { findings: [], itemIssues: [] });
});

// --- mergeAnalyzerResults ---

test("mergeAnalyzerResults recomputes the section score/status and keeps no-op parts identical", () => {
  const part = {
    section: buildSection("body", "Body and Headings", "summary", [makeFinding("pass", "Base check", "detail", "rec")]),
    itemIssues: [],
  };

  assert.equal(mergeAnalyzerResults(part, [{ findings: [], itemIssues: [] }]), part);

  const stats = analyzeStatisticsFormatting(
    DOCX_PARSED,
    runFactsFrom([paragraphFromRuns([{ text: "The result was p = .03 overall." }])]),
  );
  const merged = mergeAnalyzerResults(part, [stats]);

  assert.equal(merged.section.findings.length, 2);
  assert.equal(merged.section.status, "warning");
  assert.ok(merged.section.score < 100);
  assert.equal(merged.itemIssues.length, 1);
  assert.equal(part.section.findings.length, 1, "the original part must not be mutated");
});

// --- Abstract length (text-level, both formats) ---

test("an abstract over 250 words warns with an approximate count", () => {
  const longAbstract = Array.from({ length: 260 }, (_, index) => `term${index}`).join(" ");
  const part = analyzeBody(
    parseRawText(["Thesis Title", "", "Abstract", longAbstract, "", "Introduction", "The introduction begins here."].join("\n")),
  );

  const issue = part.itemIssues.find((candidate) => candidate.title === "Abstract exceeds APA word limit");
  assert.ok(issue);
  assert.match(issue.detail, /~260/);
  assert.ok(part.section.findings.some((finding) => finding.title === "Abstract exceeds APA word limit"));
});

test("an abstract within the limit passes, and Keywords lines stop the count", () => {
  const abstractText = Array.from({ length: 100 }, (_, index) => `term${index}`).join(" ");
  const part = analyzeBody(
    parseRawText(
      ["Thesis Title", "", "Abstract", abstractText, "Keywords: sleep, memory, cognition", "", "Introduction", "Body starts."].join("\n"),
    ),
  );

  assert.equal(part.section.metrics.abstractWordCount, 100);
  assert.ok(part.section.findings.some((finding) => finding.title === "Abstract length within APA limit"));
  assert.ok(!part.itemIssues.some((issue) => issue.title === "Abstract exceeds APA word limit"));
});

test("no Abstract heading means no abstract finding at all", () => {
  const part = analyzeBody(parseRawText("Just a body line with a handful of words."));

  assert.ok(!part.section.findings.some((finding) => finding.title.startsWith("Abstract")));
  assert.equal(part.section.metrics.abstractWordCount, null);
});

test("the abstract scan stops at the next heading and at the 40-line window", () => {
  const boundedPart = analyzeBody(
    parseRawText(
      [
        "Thesis Title",
        "",
        "Abstract",
        Array.from({ length: 200 }, (_, index) => `alpha${index}`).join(" "),
        "",
        "Introduction",
        Array.from({ length: 200 }, (_, index) => `beta${index}`).join(" "),
      ].join("\n"),
    ),
  );

  assert.equal(boundedPart.section.metrics.abstractWordCount, 200);

  const windowLines = Array.from({ length: 45 }, (_, index) => `filler line ${index} with exactly ten small words counted here`);
  const windowedPart = analyzeBody(parseRawText(["Thesis Title", "", "Abstract", ...windowLines].join("\n")));

  assert.equal(windowedPart.section.metrics.abstractWordCount, 400);
  const issue = windowedPart.itemIssues.find((candidate) => candidate.title === "Abstract exceeds APA word limit");
  assert.match(issue.detail, /~400/);
});

// --- Block quotes (text-level) ---

test("a 40+ word quotation warns that it must be a block quote", () => {
  const quoteWords = Array.from({ length: 42 }, (_, index) => `quoted${index}`).join(" ");
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        `Smith argued that "${quoteWords}" in the final report (Smith, 2020, p. 4).`,
        "",
        "References",
        "Smith, J. (2020). Original work. Journal, 2(1), 1-9.",
      ].join("\n"),
    ),
  );

  const issue = report.itemIssues.find((candidate) => candidate.title === "Long quotation not formatted as a block quote");
  assert.ok(issue);
  assert.match(issue.detail, /~42 words/);
  assert.match(issue.detail, /block quotes \(freestanding, indented, no quotation marks\)/);

  const citationsSection = report.sections.find((section) => section.id === "citations");
  assert.ok(citationsSection.findings.some((finding) => finding.title === "Quotations of 40+ words should be block quotes"));
});

test("short quotes and reference-zone quotes do not trigger the block-quote warning", () => {
  const shortQuote = Array.from({ length: 20 }, (_, index) => `quoted${index}`).join(" ");
  const referenceZoneQuote = Array.from({ length: 45 }, (_, index) => `refquoted${index}`).join(" ");
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        `Smith argued that "${shortQuote}" mattered (Smith, 2020, p. 4).`,
        "",
        "References",
        "",
        `Smith, J. (2020). Original work with "${referenceZoneQuote}" inside. Journal, 2(1), 1-9.`,
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "Long quotation not formatted as a block quote"));
});

// --- Sentence-initial numerals (text-level) ---

test("sentences that begin with bare numerals warn", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "5 participants began the protocol early. The task was hard. 12 students failed to finish.",
        "",
        "References",
        "Adams, B. (2019). A study. Journal, 1(1), 1-10.",
      ].join("\n"),
    ),
  );

  const issues = report.itemIssues.filter((issue) => issue.title === "Sentence begins with a numeral");
  assert.equal(issues.length, 2);
  assert.match(issues[0].detail, /numeral 5/);
  assert.match(issues[1].detail, /numeral 12/);

  const bodySection = report.sections.find((section) => section.id === "body");
  assert.ok(bodySection.findings.some((finding) => finding.title === "Sentences begin with numerals"));
  assert.equal(bodySection.metrics.sentenceInitialNumeralCount, 2);
});

test("years, locators, decimals, abbreviations, and numbered headings are not flagged as numerals", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "2020 was a challenging year for data collection.",
        "See p. 12 for the full breakdown of results.",
        "The mean improved by 4.5 points over baseline.",
        "Results were reported by Smith et al. 12 additional analyses followed.",
        "2 Method",
        "",
        "References",
        "Adams, B. (2019). A study. Journal, 1(1), 1-10.",
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "Sentence begins with a numeral"));
});

test("numeral issues cap at 10 with a +N note in the finding", () => {
  const sentences = Array.from({ length: 12 }, (_, index) => `${index + 21} rats ran the maze quickly.`).join(" ");
  const part = analyzeBody(parseRawText(["A Study", "", sentences].join("\n")));

  const issues = part.itemIssues.filter((issue) => issue.title === "Sentence begins with a numeral");
  assert.equal(issues.length, 10);

  const finding = part.section.findings.find((candidate) => candidate.title === "Sentences begin with numerals");
  assert.match(finding.detail, /\+2 more/);
  assert.equal(part.section.metrics.sentenceInitialNumeralCount, 12);
});

// --- Two-author et al. (text-level) ---

test("et al. citing a clearly two-author work fails on the citations section", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "Sleep loss impairs sustained attention (Lim et al., 2010).",
        "",
        "References",
        "Lim, J., & Dinges, D. F. (2010). A meta-analysis of short-term sleep deprivation. Psychological Bulletin, 136(3), 375-389.",
      ].join("\n"),
    ),
  );

  const issues = report.itemIssues.filter((issue) => issue.title === "et al. used for a two-author work");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].status, "fail");
  assert.match(issues[0].detail, /Lim & Dinges/);
  assert.match(issues[0].detail, /three or more authors/);

  const citationsSection = report.sections.find((section) => section.id === "citations");
  const finding = citationsSection.findings.find((candidate) => candidate.title === "et al. used for two-author works");
  assert.equal(finding.status, "fail");
  assert.equal(citationsSection.metrics.twoAuthorEtAlCount, 1);
});

test("et al. for three-author works and spelled-out two-author citations pass", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "The effect replicates (Brown et al., 2019) and holds under sleep loss (Lim & Dinges, 2010).",
        "",
        "References",
        "Brown, A., Lee, B., & Chen, C. (2019). Citation habits in psychology. Journal of Writing, 8(1), 1-10.",
        "",
        "Lim, J., & Dinges, D. F. (2010). A meta-analysis of short-term sleep deprivation. Psychological Bulletin, 136(3), 375-389.",
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "et al. used for a two-author work"));
});

test("a surname with both two- and three-author entries is never flagged", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "The larger team replicated the result (Smith et al., 2019).",
        "",
        "References",
        "Smith, J., & Lee, K. (2020). Two-author paper. Journal Alpha, 1(1), 1-10.",
        "",
        "Smith, J., Brown, B., & Chen, C. (2019). Three-author paper. Journal Beta, 2(1), 1-10.",
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "et al. used for a two-author work"));
});

test("an adjacent year that differs from the two-author entry suppresses the flag", () => {
  const report = runRuleBasedReview(
    parseRawText(
      [
        "A Study",
        "",
        "An earlier study is cited loosely (Smith et al., 2019).",
        "",
        "References",
        "Smith, J., & Lee, K. (2020). Two-author paper. Journal Alpha, 1(1), 1-10.",
      ].join("\n"),
    ),
  );

  assert.ok(!report.itemIssues.some((issue) => issue.title === "et al. used for a two-author work"));
});

// --- Regression: the clean fixture stays clean ---

test("SIMPLE_THESIS_TEXT triggers none of the new text-level warnings", () => {
  const report = runRuleBasedReview(parseRawText(SIMPLE_THESIS_TEXT));
  const newWarningTitles = [
    "Abstract exceeds APA word limit",
    "Sentence begins with a numeral",
    "Long quotation not formatted as a block quote",
    "et al. used for a two-author work",
  ];

  for (const title of newWarningTitles) {
    assert.ok(!report.itemIssues.some((issue) => issue.title === title), `unexpected issue: ${title}`);
  }

  const bodySection = report.sections.find((section) => section.id === "body");
  assert.ok(bodySection.findings.some((finding) => finding.title === "Abstract length within APA limit"));
});
