import assert from "node:assert/strict";
import test from "node:test";

import { analyzeLayout, analyzeLayoutFailure, analyzePdfLayoutPlaceholder } from "../src/lib/layoutChecks.js";

function makeFacts(overrides = {}) {
  return {
    available: true,
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440, gutter: 0 },
    pageSize: { width: 12240, height: 15840 },
    defaultFont: { family: "Times New Roman", sizePt: 12 },
    spacing: { sampledParagraphs: 20, doubleSpacedRatio: 0.95, dominantLine: 480, dominantLineRule: "auto", spaceAfterRatio: 0 },
    indentation: {
      body: { sampled: 15, firstLineRatio: 0.8, dominantFirstLine: 720 },
      references: { sampled: 5, hangingRatio: 1, dominantHanging: 720 },
    },
    pageNumbering: { hasPageNumberField: true },
    headingStyles: { count: 4, levelsUsed: [1, 2], usesWordHeadingStyles: true },
    titlePage: { paragraphs: [], hasBoldCenteredTitle: true },
    ...overrides,
  };
}

function findingByTitlePrefix(section, prefix) {
  return section.findings.find((finding) => finding.title.startsWith(prefix));
}

test("a fully APA-conformant layout passes every check", () => {
  const { section, itemIssues } = analyzeLayout(makeFacts());

  assert.equal(section.id, "layout");
  assert.equal(section.status, "pass");
  assert.deepEqual(itemIssues, []);
});

test("a wider left margin alone reads as a binding-margin warning with inches in the detail", () => {
  const { section } = analyzeLayout(makeFacts({ margins: { top: 1440, right: 1440, bottom: 1440, left: 1800, gutter: 0 } }));
  const marginFinding = findingByTitlePrefix(section, "Left margin");

  assert.equal(marginFinding.status, "warning");
  assert.match(marginFinding.detail, /left 1\.25 in/);
});

test("metric 2.5cm margins warn with a metric hint instead of failing", () => {
  const { section } = analyzeLayout(makeFacts({ margins: { top: 1417, right: 1417, bottom: 1417, left: 1417, gutter: 0 } }));
  const marginFinding = findingByTitlePrefix(section, "Margins are close");

  assert.equal(marginFinding.status, "warning");
  assert.match(marginFinding.detail, /metric/);
});

test("a clearly wrong margin fails", () => {
  const { section } = analyzeLayout(makeFacts({ margins: { top: 900, right: 1440, bottom: 1440, left: 1440, gutter: 0 } }));

  assert.equal(findingByTitlePrefix(section, "Margins deviate").status, "fail");
});

test("Calibri 11 passes; unknown fonts and wrong sizes warn", () => {
  const calibri = analyzeLayout(makeFacts({ defaultFont: { family: "Calibri", sizePt: 11 } }));
  assert.equal(findingByTitlePrefix(calibri.section, "APA-accepted font").status, "pass");

  const comicSans = analyzeLayout(makeFacts({ defaultFont: { family: "Comic Sans MS", sizePt: 11 } }));
  assert.equal(findingByTitlePrefix(comicSans.section, "Font is not on the APA-accepted list").status, "warning");

  const smallTimes = analyzeLayout(makeFacts({ defaultFont: { family: "Times New Roman", sizePt: 10 } }));
  const sizeFinding = findingByTitlePrefix(smallTimes.section, "Font size differs");
  assert.equal(sizeFinding.status, "warning");
  assert.match(sizeFinding.detail, /12 pt/);
});

test("single spacing warns", () => {
  const { section } = analyzeLayout(
    makeFacts({ spacing: { sampledParagraphs: 20, doubleSpacedRatio: 0.2, dominantLine: 240, dominantLineRule: "auto", spaceAfterRatio: 0 } }),
  );

  assert.equal(findingByTitlePrefix(section, "Document does not appear double-spaced").status, "warning");
});

test("space-after paragraphs produce an extra item issue", () => {
  const { itemIssues } = analyzeLayout(
    makeFacts({ spacing: { sampledParagraphs: 20, doubleSpacedRatio: 0.95, dominantLine: 480, dominantLineRule: "auto", spaceAfterRatio: 0.8 } }),
  );

  assert.ok(itemIssues.some((issue) => issue.title === "Extra space between paragraphs"));
});

test("missing reference hanging indents fail; unlocated references stay info", () => {
  const missing = analyzeLayout(
    makeFacts({
      indentation: {
        body: { sampled: 15, firstLineRatio: 0.8, dominantFirstLine: 720 },
        references: { sampled: 5, hangingRatio: 0.1, dominantHanging: null },
      },
    }),
  );
  assert.equal(findingByTitlePrefix(missing.section, "References lack a hanging indent").status, "fail");

  const unlocated = analyzeLayout(makeFacts(), { referencesLocated: false });
  assert.equal(findingByTitlePrefix(unlocated.section, "Reference hanging indent not measurable").status, "info");
});

test("missing page numbers and unbolded titles warn", () => {
  const { section } = analyzeLayout(
    makeFacts({
      pageNumbering: { hasPageNumberField: false },
      titlePage: { paragraphs: [], hasBoldCenteredTitle: false },
    }),
  );

  assert.equal(findingByTitlePrefix(section, "No page-number field").status, "warning");
  assert.equal(findingByTitlePrefix(section, "Title not detected").status, "warning");
});

test("the PDF placeholder is a single info finding with no item issues", () => {
  const { section, itemIssues, promptFacts } = analyzePdfLayoutPlaceholder();

  assert.equal(section.id, "layout");
  assert.equal(section.status, "info");
  assert.equal(section.findings.length, 1);
  assert.equal(section.findings[0].status, "info");
  assert.deepEqual(itemIssues, []);
  assert.equal(promptFacts.available, false);
});

test("a corrupt DOCX degrades to a warning section instead of failing the job", () => {
  const { section, itemIssues } = analyzeLayoutFailure(new Error("End of central directory not found"));

  assert.equal(section.status, "warning");
  assert.equal(itemIssues.length, 1);
  assert.match(itemIssues[0].detail, /End of central directory/);
});
