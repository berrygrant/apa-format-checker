import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { annotateDocxWithIssues, sanitizeAnnotationIssues } from "../src/lib/docxComments.js";
import { extractDocxLayout } from "../src/lib/docxLayout.js";
import { parseDocumentBuffer } from "../src/lib/docxParser.js";
import { buildDocxBuffer } from "./helpers/buildDocxFixture.js";

const COMMENTS_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const COMMENTS_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const DOCX_FILE_META = { name: "thesis.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

const FIXTURE_OPTIONS = {
  doubleSpaced: true,
  firstLineIndent: 720,
  paragraphs: [
    "Effects of Sleep on Working Memory",
    "Sleep restriction impairs working memory across many laboratory studies (Smith and Lee, 2020).",
    "Participants completed a digit span task after one night of restricted sleep.",
  ],
  referenceEntries: ["Walker, M. (2017). Why we sleep. Scribner."],
};

function makeIssue(overrides = {}) {
  return {
    id: "issue-x",
    status: "warning",
    title: "Sample issue",
    detail: "Sample detail.",
    recommendation: "Sample recommendation.",
    evidence: "",
    location: { excerpt: "" },
    ...overrides,
  };
}

async function readZipText(buffer, path) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(path);
  return file ? file.async("string") : null;
}

// Rebuilds the fixture DOCX without any comment infrastructure so the
// "register the part from scratch" path gets exercised.
async function stripCommentInfrastructure(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  zip.remove("word/comments.xml");
  zip.remove("word/_rels/comments.xml.rels");

  const contentTypes = await zip.file("[Content_Types].xml").async("string");
  zip.file(
    "[Content_Types].xml",
    contentTypes.replace(/<Override [^>]*PartName="\/word\/comments\.xml"[^>]*\/>/, ""),
  );

  const rels = await zip.file("word/_rels/document.xml.rels").async("string");
  zip.file(
    "word/_rels/document.xml.rels",
    rels.replace(/<Relationship [^>]*Type="[^"]*relationships\/comments"[^>]*\/>/, ""),
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("anchors matching issues as native Word comments and reports the rest as unanchored", async () => {
  const buffer = await buildDocxBuffer(FIXTURE_OPTIONS);
  const issues = [
    makeIssue({
      id: "issue-citation",
      status: "fail",
      title: 'Ampersand & <angle> "quotes"',
      detail: "Use & only inside parentheses.",
      recommendation: "Rewrite the citation with <and>.",
      location: { excerpt: "Sleep restriction impairs working memory across many laboratory studies" },
    }),
    makeIssue({
      id: "issue-evidence",
      title: "Evidence-only issue",
      evidence: "Participants completed a digit span task",
    }),
    makeIssue({
      id: "issue-truncated",
      title: "Truncated excerpt issue",
      location: { excerpt: "Effects of Sleep on Working..." },
    }),
    makeIssue({
      id: "issue-unmatched",
      title: "Never matches",
      location: { excerpt: "Quantum entanglement of lunar cheese wheels" },
    }),
  ];

  const result = await annotateDocxWithIssues(buffer, issues);

  assert.equal(result.anchoredCount, 3);
  assert.equal(result.unanchoredCount, 1);
  assert.deepEqual(
    result.unanchored.map((issue) => issue.id),
    ["issue-unmatched"],
  );

  const commentsXml = await readZipText(result.buffer, "word/comments.xml");
  assert.ok(commentsXml, "word/comments.xml should exist");
  assert.equal((commentsXml.match(/<w:comment\s/g) ?? []).length, 3);
  assert.match(commentsXml, /w:author="APA Format Checker"/);
  assert.match(commentsXml, /w:initials="APA"/);
  assert.ok(
    commentsXml.includes("[FAIL] Ampersand &amp; &lt;angle&gt; &quot;quotes&quot; — Use &amp; only inside parentheses."),
    "comment text should be XML-escaped",
  );
  assert.ok(commentsXml.includes("Fix: Rewrite the citation with &lt;and&gt;."));

  const documentXml = await readZipText(result.buffer, "word/document.xml");

  for (const id of [0, 1, 2]) {
    assert.ok(documentXml.includes(`<w:commentRangeStart w:id="${id}"/>`), `missing commentRangeStart ${id}`);
    assert.ok(documentXml.includes(`<w:commentRangeEnd w:id="${id}"/>`), `missing commentRangeEnd ${id}`);
    assert.ok(documentXml.includes(`<w:commentReference w:id="${id}"/>`), `missing commentReference ${id}`);
    assert.ok(commentsXml.includes(`<w:comment w:id="${id}" `), `missing w:comment entry ${id}`);
  }

  // Range starts must land after the paragraph properties, and the reference
  // run must trail its range end inside the same paragraph.
  assert.match(documentXml, /<\/w:pPr><w:commentRangeStart w:id="0"\/>/);
  assert.match(documentXml, /<w:commentRangeEnd w:id="0"\/><w:r><w:commentReference w:id="0"\/><\/w:r><\/w:p>/);

  const contentTypesXml = await readZipText(result.buffer, "[Content_Types].xml");
  assert.ok(contentTypesXml.includes('PartName="/word/comments.xml"'));
  assert.ok(contentTypesXml.includes(COMMENTS_CONTENT_TYPE));

  const relsXml = await readZipText(result.buffer, "word/_rels/document.xml.rels");
  assert.ok(relsXml.includes(COMMENTS_RELATIONSHIP_TYPE));

  // The annotated copy still parses through the review pipeline with the same
  // extracted text as the original upload.
  const originalParsed = await parseDocumentBuffer(buffer, DOCX_FILE_META);
  const annotatedParsed = await parseDocumentBuffer(result.buffer, DOCX_FILE_META);
  assert.equal(annotatedParsed.rawText, originalParsed.rawText);
  assert.equal(annotatedParsed.normalizedText, originalParsed.normalizedText);

  const layout = await extractDocxLayout(result.buffer);
  assert.equal(layout.available, true);
});

test("creates the comments part, content-type override, and relationship when the package lacks them", async () => {
  const strippedBuffer = await stripCommentInfrastructure(await buildDocxBuffer(FIXTURE_OPTIONS));
  assert.equal(await readZipText(strippedBuffer, "word/comments.xml"), null);

  const result = await annotateDocxWithIssues(strippedBuffer, [
    makeIssue({ location: { excerpt: "Participants completed a digit span task" } }),
  ]);

  assert.equal(result.anchoredCount, 1);
  assert.equal(result.unanchoredCount, 0);

  const commentsXml = await readZipText(result.buffer, "word/comments.xml");
  assert.ok(commentsXml.includes('<w:comment w:id="0" '));

  const contentTypesXml = await readZipText(result.buffer, "[Content_Types].xml");
  assert.equal((contentTypesXml.match(/PartName="\/word\/comments\.xml"/g) ?? []).length, 1);
  assert.ok(contentTypesXml.includes(COMMENTS_CONTENT_TYPE));

  const relsXml = await readZipText(result.buffer, "word/_rels/document.xml.rels");
  const relationshipMatch = relsXml.match(/<Relationship Id="(rId\d+)" Type="[^"]*relationships\/comments" Target="comments\.xml"\/>/);
  assert.ok(relationshipMatch, "comments relationship should be added");
  assert.equal(
    (relsXml.match(new RegExp(`Id="${relationshipMatch[1]}"`, "g")) ?? []).length,
    1,
    "the fresh rId must be unused",
  );
});

test("caps each paragraph at three comments and reports the extras as unanchored", async () => {
  const buffer = await buildDocxBuffer(FIXTURE_OPTIONS);
  const issues = Array.from({ length: 5 }, (_, index) =>
    makeIssue({
      id: `issue-${index}`,
      location: { excerpt: "Sleep restriction impairs working memory" },
    }),
  );

  const result = await annotateDocxWithIssues(buffer, issues);

  assert.equal(result.anchoredCount, 3);
  assert.equal(result.unanchoredCount, 2);
  assert.deepEqual(
    result.unanchored.map((issue) => issue.id),
    ["issue-3", "issue-4"],
  );

  const documentXml = await readZipText(result.buffer, "word/document.xml");
  assert.equal((documentXml.match(/<w:commentRangeStart /g) ?? []).length, 3);
});

test("matches on the leading words when an excerpt diverges after its prefix", async () => {
  const buffer = await buildDocxBuffer(FIXTURE_OPTIONS);
  const result = await annotateDocxWithIssues(buffer, [
    makeIssue({
      location: { excerpt: "Participants completed a digit span task after one entire week of monitored recovery" },
    }),
  ]);

  assert.equal(result.anchoredCount, 1);
  assert.equal(result.unanchoredCount, 0);
});

test("assigns fresh comment ids when the document already contains comments", async () => {
  const buffer = await buildDocxBuffer(FIXTURE_OPTIONS);
  const firstPass = await annotateDocxWithIssues(buffer, [
    makeIssue({ location: { excerpt: "Sleep restriction impairs working memory" } }),
  ]);
  const secondPass = await annotateDocxWithIssues(firstPass.buffer, [
    makeIssue({ location: { excerpt: "Participants completed a digit span task" } }),
  ]);

  const commentsXml = await readZipText(secondPass.buffer, "word/comments.xml");
  assert.deepEqual(
    [...commentsXml.matchAll(/<w:comment\s[^>]*w:id="(\d+)"/g)].map((match) => match[1]),
    ["0", "1"],
  );

  const documentXml = await readZipText(secondPass.buffer, "word/document.xml");
  assert.ok(documentXml.includes('<w:commentRangeStart w:id="0"/>'));
  assert.ok(documentXml.includes('<w:commentRangeStart w:id="1"/>'));
});

test("returns the original buffer untouched when nothing anchors", async () => {
  const buffer = await buildDocxBuffer(FIXTURE_OPTIONS);
  const result = await annotateDocxWithIssues(buffer, [
    makeIssue({ id: "no-excerpt" }),
    makeIssue({ id: "no-match", location: { excerpt: "Totally absent sentence fragment" } }),
  ]);

  assert.equal(result.anchoredCount, 0);
  assert.equal(result.unanchoredCount, 2);
  assert.ok(result.buffer.equals(buffer));
});

test("rejects buffers that are not DOCX packages with a clear error", async () => {
  await assert.rejects(
    () => annotateDocxWithIssues(Buffer.from("not a zip file"), [makeIssue()]),
    /could not be opened as a DOCX package/,
  );
});

test("rejects non-array issue payloads", async () => {
  const buffer = await buildDocxBuffer({ paragraphs: ["One paragraph."] });
  await assert.rejects(() => annotateDocxWithIssues(buffer, { not: "an array" }), /must be an array/);
});

test("sanitizeAnnotationIssues keeps only the string fields the annotator uses", () => {
  assert.equal(sanitizeAnnotationIssues("nope"), null);
  assert.equal(sanitizeAnnotationIssues({ length: 1 }), null);

  const [sanitized] = sanitizeAnnotationIssues([
    {
      id: "issue-1",
      status: 42,
      title: "Real title",
      detail: null,
      recommendation: "Do this.",
      evidence: "Quoted evidence",
      maliciousExtra: "<script>alert(1)</script>",
      location: { excerpt: "An excerpt", label: "Line 4", lineStart: 4, nested: { deep: true } },
    },
  ]);

  assert.deepEqual(sanitized, {
    id: "issue-1",
    status: "",
    title: "Real title",
    detail: "",
    recommendation: "Do this.",
    evidence: "Quoted evidence",
    location: { excerpt: "An excerpt" },
  });

  const capped = sanitizeAnnotationIssues(Array.from({ length: 250 }, () => makeIssue()));
  assert.equal(capped.length, 200);

  const [nonObject] = sanitizeAnnotationIssues(["just a string"]);
  assert.deepEqual(nonObject, {
    id: "",
    status: "",
    title: "",
    detail: "",
    recommendation: "",
    evidence: "",
    location: { excerpt: "" },
  });
});
