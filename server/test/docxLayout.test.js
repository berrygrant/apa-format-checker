import assert from "node:assert/strict";
import test from "node:test";

import { extractDocxLayout } from "../src/lib/docxLayout.js";
import { buildDocxBuffer } from "./helpers/buildDocxFixture.js";

const APA_FIXTURE = {
  margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
  defaultFont: "Times New Roman",
  defaultSizePt: 12,
  doubleSpaced: true,
  firstLineIndent: 720,
  pageNumbers: true,
  paragraphs: [
    { text: "Effects of Sleep on Working Memory", bold: true, centered: true },
    "Jordan Rivera",
    "Department of Psychology, Example University",
    "Sleep is central to cognitive performance and this paragraph provides body text.",
    "A second body paragraph keeps the sampling honest across the document.",
  ],
  referenceEntries: [
    "Lim, J., & Dinges, D. F. (2010). A meta-analysis. Psychological Bulletin, 136(3), 375-389.",
    "Walker, M. (2017). Why we sleep. Scribner.",
  ],
  hangingIndent: 720,
};

test("round-trips margins, font, spacing, indents, and page numbers from a DOCX", async () => {
  const layout = await extractDocxLayout(await buildDocxBuffer(APA_FIXTURE));

  assert.equal(layout.available, true);
  assert.deepEqual(
    [layout.margins.top, layout.margins.right, layout.margins.bottom, layout.margins.left],
    [1440, 1440, 1440, 1440],
  );
  assert.equal(layout.defaultFont.family, "Times New Roman");
  assert.equal(layout.defaultFont.sizePt, 12);
  assert.ok(layout.spacing.doubleSpacedRatio >= 0.8, `doubleSpacedRatio was ${layout.spacing.doubleSpacedRatio}`);
  assert.equal(layout.indentation.references.dominantHanging, 720);
  assert.ok(layout.indentation.references.hangingRatio >= 0.9);
  assert.ok(layout.indentation.body.firstLineRatio > 0.5);
  assert.equal(layout.pageNumbering.hasPageNumberField, true);
  assert.equal(layout.titlePage.hasBoldCenteredTitle, true);
});

test("reports missing page-number fields when the document has no headers or footers", async () => {
  const layout = await extractDocxLayout(
    await buildDocxBuffer({
      paragraphs: ["A plain document without headers.", "Second paragraph."],
    }),
  );

  assert.equal(layout.pageNumbering.hasPageNumberField, false);
});

test("detects single spacing and missing hanging indents", async () => {
  const layout = await extractDocxLayout(
    await buildDocxBuffer({
      doubleSpaced: false,
      paragraphs: ["Single-spaced body paragraph one.", "Single-spaced body paragraph two."],
      referenceEntries: ["Walker, M. (2017). Why we sleep. Scribner."],
      hangingIndent: null,
    }),
  );

  assert.ok(layout.spacing.doubleSpacedRatio < 0.5);
  assert.equal(layout.indentation.references.hangingRatio, 0);
});

test("detects Word heading styles", async () => {
  const layout = await extractDocxLayout(
    await buildDocxBuffer({
      useHeadingStyles: true,
      paragraphs: [
        "A Title Paragraph",
        { text: "Method", heading: "Heading1" },
        "Participants completed the battery.",
        { text: "Results", heading: "Heading1" },
        "Scores improved.",
      ],
    }),
  );

  assert.equal(layout.headingStyles.usesWordHeadingStyles, true);
  assert.ok(layout.headingStyles.levelsUsed.includes(1));
});

test("rejects a buffer that is not a DOCX package", async () => {
  await assert.rejects(() => extractDocxLayout(Buffer.from("not a zip file")));
});
