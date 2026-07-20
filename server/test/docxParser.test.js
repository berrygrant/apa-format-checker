import assert from "node:assert/strict";
import test from "node:test";

import { parseDocumentBuffer } from "../src/lib/docxParser.js";
import { buildDocxBuffer } from "./helpers/buildDocxFixture.js";
import { parseRawText, SIMPLE_THESIS_TEXT } from "./helpers/textFixtures.js";

test("splits main and references zones around the References heading", () => {
  const parsed = parseRawText(SIMPLE_THESIS_TEXT);

  assert.equal(parsed.referencesMissing, false);
  assert.ok(parsed.referencesHeadingLineNumber > 0);
  assert.ok(parsed.mainLineRecords.length > 0);
  assert.ok(parsed.referenceLineRecords.length > 0);
  assert.ok(parsed.mainLineRecords.every((record) => record.zone === "main"));
  assert.ok(parsed.referenceLineRecords.every((record) => record.zone === "references"));
  assert.match(parsed.referencesText, /Walker, M\./);
  assert.doesNotMatch(parsed.preReferencesText, /Why we sleep/);
});

test("groups reference entries separated by blank lines", () => {
  const parsed = parseRawText(SIMPLE_THESIS_TEXT);

  assert.equal(parsed.referenceEntryRecords.length, 2);
  assert.match(parsed.referenceEntryRecords[0].text, /^Lim, J\./);
  assert.match(parsed.referenceEntryRecords[1].text, /^Walker, M\./);
  assert.equal(parsed.referenceEntryRecords[0].entryNumber, 1);
  assert.ok(parsed.referenceEntryRecords[0].startLine <= parsed.referenceEntryRecords[0].endLine);
});

test("falls back to one entry per line when references have no blank separators", () => {
  const rawText = [
    "Body text before the list.",
    "",
    "References",
    "Adams, B. (2019). First study. Journal One, 1(1), 1-10.",
    "Baker, C. (2020). Second study. Journal Two, 2(2), 11-20.",
    "Carter, D. (2021). Third study. Journal Three, 3(3), 21-30.",
  ].join("\n");

  const parsed = parseRawText(rawText);

  assert.equal(parsed.referenceEntryRecords.length, 3);
  assert.match(parsed.referenceEntryRecords[2].text, /^Carter/);
});

test("marks references missing when no heading exists", () => {
  const parsed = parseRawText("Just a body paragraph with no reference list at all.");

  assert.equal(parsed.referencesMissing, true);
  assert.equal(parsed.referencesHeadingLineNumber, null);
  assert.equal(parsed.referenceEntryRecords.length, 0);
});

test("assigns line and paragraph numbers to non-empty lines", () => {
  const parsed = parseRawText("First paragraph line one.\nFirst paragraph line two.\n\nSecond paragraph.");

  assert.equal(parsed.lineRecords.length, 3);
  assert.equal(parsed.lineRecords[0].paragraphNumber, 1);
  assert.equal(parsed.lineRecords[1].paragraphNumber, 1);
  assert.equal(parsed.lineRecords[2].paragraphNumber, 2);
  assert.equal(parsed.lineRecords[2].lineNumber, 4);
});

test("parses a generated DOCX buffer through mammoth", async () => {
  const buffer = await buildDocxBuffer({
    paragraphs: [
      "Effects of Automated Feedback on Revision",
      "",
      "Formative feedback helps students revise more confidently (Smith, 2022).",
    ],
    referenceEntries: ["Smith, J. (2022). Writing feedback. Journal of Teaching, 14(2), 22-31."],
  });

  const parsed = await parseDocumentBuffer(buffer, {
    name: "fixture.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  assert.equal(parsed.sourceFormat, "docx");
  assert.ok(parsed.wordCount > 10);
  assert.equal(parsed.referencesMissing, false);
  assert.equal(parsed.referenceEntryRecords.length, 1);
  assert.match(parsed.referenceEntryRecords[0].text, /^Smith, J\./);
});
