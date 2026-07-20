import { HALF_INCH_TWIPS, TWIPS_PER_INCH } from "./docxLayout.js";
import { buildSection, makeFinding, makeItemIssue, makeLocation } from "./ruleChecks.js";

const MARGIN_TARGET = TWIPS_PER_INCH;
const MARGIN_EXACT_TOLERANCE = 20;
const MARGIN_NEAR_TOLERANCE = 180;
const MARGIN_FAIL_LOW = 1260;
const MARGIN_FAIL_HIGH = 1800;
const INDENT_TOLERANCE = 72;

// Font families APA 7 (section 2.19) explicitly permits, with their sizes.
const ACCEPTED_FONTS = [
  { family: "times new roman", sizePt: 12 },
  { family: "calibri", sizePt: 11 },
  { family: "arial", sizePt: 11 },
  { family: "lucida sans unicode", sizePt: 10 },
  { family: "georgia", sizePt: 11 },
  { family: "computer modern", sizePt: 10 },
];

function inches(twipValue) {
  return Math.round((twipValue / TWIPS_PER_INCH) * 100) / 100;
}

function layoutLocation(labelOverride, excerpt = "") {
  return makeLocation({ sectionId: "layout", labelOverride, excerpt });
}

function describeMargins(margins) {
  return ["top", "right", "bottom", "left"]
    .map((side) => `${side} ${margins[side] === null ? "unknown" : `${inches(margins[side])} in`}`)
    .join(", ");
}

function assessMargins(margins) {
  if (!margins) {
    return makeFinding(
      "warning",
      "Margins not detected",
      "The DOCX did not expose page-margin settings in its section properties.",
      "Confirm 1 in (2.54 cm) margins on all sides in the original document.",
      null,
      layoutLocation("Page setup"),
    );
  }

  const sides = ["top", "right", "bottom", "left"];
  const values = sides.map((side) => margins[side]);

  if (values.some((value) => value === null)) {
    return makeFinding(
      "warning",
      "Margins partially detected",
      `Some margin values were missing from the DOCX section properties (${describeMargins(margins)}).`,
      "Confirm 1 in (2.54 cm) margins on all sides in the original document.",
      null,
      layoutLocation("Page setup"),
    );
  }

  const detail = `Measured margins: ${describeMargins(margins)}.`;

  if (values.every((value) => Math.abs(value - MARGIN_TARGET) <= MARGIN_EXACT_TOLERANCE)) {
    return makeFinding("pass", "Margins are 1 inch", detail, "No action required.", null, layoutLocation("Page setup"));
  }

  if (values.some((value) => value < MARGIN_FAIL_LOW || value > MARGIN_FAIL_HIGH)) {
    return makeFinding(
      "fail",
      "Margins deviate from 1 inch",
      detail,
      "Set every margin to 1 in (2.54 cm) unless your program's thesis guide requires otherwise.",
      null,
      layoutLocation("Page setup"),
    );
  }

  const nonLeftSides = sides.filter((side) => side !== "left");
  const onlyLeftIsWider =
    margins.left > MARGIN_TARGET + MARGIN_EXACT_TOLERANCE &&
    nonLeftSides.every((side) => Math.abs(margins[side] - MARGIN_TARGET) <= MARGIN_EXACT_TOLERANCE);

  if (onlyLeftIsWider) {
    return makeFinding(
      "warning",
      "Left margin is wider than 1 inch",
      `${detail} A wider left margin is common for bound theses.`,
      "Keep the wider left margin only if your program's binding guidelines require it; APA 7 itself uses 1 in on all sides.",
      null,
      layoutLocation("Page setup"),
    );
  }

  const isMetricApproximation = values.every((value) => Math.abs(value - MARGIN_TARGET) <= MARGIN_NEAR_TOLERANCE);

  return makeFinding(
    "warning",
    "Margins are close to but not exactly 1 inch",
    isMetricApproximation ? `${detail} This often results from metric (2.5 cm) page setup.` : detail,
    "Set every margin to exactly 1 in (2.54 cm).",
    null,
    layoutLocation("Page setup"),
  );
}

function assessFont(defaultFont) {
  if (!defaultFont?.family) {
    return makeFinding(
      "warning",
      "Default font not detected",
      "The DOCX styles did not expose a default font family.",
      "Confirm the document uses an APA-accepted font such as Times New Roman 12 or Calibri 11.",
      null,
      layoutLocation("Styles: document defaults"),
    );
  }

  const normalizedFamily = defaultFont.family.trim().toLowerCase();
  const acceptedFont = ACCEPTED_FONTS.find((font) => normalizedFamily.includes(font.family));
  const fontLabel = `${defaultFont.family}${defaultFont.sizePt ? ` ${defaultFont.sizePt} pt` : ""}`;

  if (!acceptedFont) {
    return makeFinding(
      "warning",
      "Font is not on the APA-accepted list",
      `The document default font is ${fontLabel}.`,
      "APA 7 recommends Times New Roman 12, Calibri 11, Arial 11, Lucida Sans Unicode 10, Georgia 11, or Computer Modern 10.",
      null,
      layoutLocation("Styles: document defaults"),
    );
  }

  if (defaultFont.sizePt !== null && defaultFont.sizePt !== acceptedFont.sizePt) {
    return makeFinding(
      "warning",
      "Font size differs from the APA pairing",
      `The document default is ${fontLabel}; APA pairs this family with ${acceptedFont.sizePt} pt.`,
      `Set the body text to ${acceptedFont.sizePt} pt ${defaultFont.family}.`,
      null,
      layoutLocation("Styles: document defaults"),
    );
  }

  return makeFinding(
    "pass",
    "APA-accepted font",
    `The document default font is ${fontLabel}.`,
    "No action required.",
    null,
    layoutLocation("Styles: document defaults"),
  );
}

function assessSpacing(spacing) {
  if (!spacing || spacing.sampledParagraphs === 0) {
    return makeFinding(
      "warning",
      "Line spacing not detected",
      "No paragraph spacing settings could be sampled from the DOCX.",
      "Confirm the document is double-spaced throughout.",
      null,
      layoutLocation("Paragraph settings"),
    );
  }

  const percentDouble = Math.round(spacing.doubleSpacedRatio * 100);

  if (spacing.doubleSpacedRatio >= 0.8) {
    return makeFinding(
      "pass",
      "Double spacing detected",
      `${percentDouble}% of sampled paragraphs use double spacing.`,
      "No action required.",
      null,
      layoutLocation("Paragraph settings"),
    );
  }

  return makeFinding(
    "warning",
    "Document does not appear double-spaced",
    `Only ${percentDouble}% of sampled paragraphs use double line spacing.`,
    "Set line spacing to double (2.0) for the entire document, including the reference list.",
    null,
    layoutLocation("Paragraph settings"),
  );
}

function assessReferenceHangingIndent(indentation, referencesLocated) {
  const references = indentation?.references;

  if (!referencesLocated || !references || references.sampled === 0) {
    return makeFinding(
      "info",
      "Reference hanging indent not measurable",
      "The reference list could not be located in the DOCX structure, so hanging indents were not measured.",
      "Confirm each reference entry uses a 0.5 in hanging indent.",
      null,
      layoutLocation("References paragraphs"),
    );
  }

  const percentHanging = Math.round(references.hangingRatio * 100);
  const dominantLooksRight =
    references.dominantHanging !== null && Math.abs(references.dominantHanging - HALF_INCH_TWIPS) <= INDENT_TOLERANCE;

  if (references.hangingRatio >= 0.7 && dominantLooksRight) {
    return makeFinding(
      "pass",
      "References use a hanging indent",
      `${percentHanging}% of reference paragraphs carry a ${inches(references.dominantHanging)} in hanging indent.`,
      "No action required.",
      null,
      layoutLocation("References paragraphs"),
    );
  }

  if (references.hangingRatio < 0.3) {
    return makeFinding(
      "fail",
      "References lack a hanging indent",
      `Only ${percentHanging}% of reference paragraphs carry a hanging indent.`,
      "Apply a 0.5 in hanging indent to every reference entry (Paragraph > Indentation > Special > Hanging).",
      null,
      layoutLocation("References paragraphs"),
    );
  }

  return makeFinding(
    "warning",
    "Reference hanging indents look inconsistent",
    `${percentHanging}% of reference paragraphs carry a hanging indent${
      references.dominantHanging ? ` (most common: ${inches(references.dominantHanging)} in)` : ""
    }.`,
    "Apply a consistent 0.5 in hanging indent to every reference entry.",
    null,
    layoutLocation("References paragraphs"),
  );
}

function assessBodyIndent(indentation) {
  const body = indentation?.body;

  if (!body || body.sampled === 0) {
    return makeFinding(
      "info",
      "Paragraph indentation not measurable",
      "No body paragraphs could be sampled for first-line indentation.",
      "Confirm each paragraph begins with a 0.5 in first-line indent.",
      null,
      layoutLocation("Body paragraphs"),
    );
  }

  const percentIndented = Math.round(body.firstLineRatio * 100);
  const dominantLooksRight =
    body.dominantFirstLine !== null && Math.abs(body.dominantFirstLine - HALF_INCH_TWIPS) <= INDENT_TOLERANCE;

  if (body.firstLineRatio >= 0.6 && dominantLooksRight) {
    return makeFinding(
      "pass",
      "Paragraphs use a first-line indent",
      `${percentIndented}% of body paragraphs carry a ${inches(body.dominantFirstLine)} in first-line indent.`,
      "No action required.",
      null,
      layoutLocation("Body paragraphs"),
    );
  }

  return makeFinding(
    "warning",
    "First-line indents not consistently detected",
    `${percentIndented}% of body paragraphs carry a stored first-line indent. Indents typed with the Tab key are not visible to this check.`,
    "Use paragraph formatting (0.5 in first-line indent) rather than tabs or spaces, and exempt only headings and the abstract.",
    null,
    layoutLocation("Body paragraphs"),
  );
}

function assessPageNumbering(pageNumbering) {
  if (pageNumbering?.hasPageNumberField) {
    return makeFinding(
      "pass",
      "Page-number field present",
      "A PAGE field was found in the document's header or footer.",
      "Confirm the number sits in the top-right header per APA 7.",
      null,
      layoutLocation("Header/footer"),
    );
  }

  return makeFinding(
    "warning",
    "No page-number field detected",
    "No PAGE field was found in any header or footer.",
    "Insert automatic page numbers in the top-right header (Insert > Page Number).",
    null,
    layoutLocation("Header/footer"),
  );
}

function assessHeadingStyles(headingStyles) {
  if (headingStyles?.usesWordHeadingStyles) {
    return makeFinding(
      "pass",
      "Word heading styles in use",
      `${headingStyles.count} paragraph${headingStyles.count === 1 ? "" : "s"} use Word heading styles (levels ${headingStyles.levelsUsed.join(", ")}).`,
      "Confirm each level's formatting matches APA 7 heading specifications.",
      null,
      layoutLocation("Heading styles"),
    );
  }

  return makeFinding(
    "info",
    "No Word heading styles detected",
    "Headings appear to be formatted manually instead of with Word's Heading styles.",
    "Using Word's Heading 1-5 styles makes APA heading levels consistent and navigable.",
    null,
    layoutLocation("Heading styles"),
  );
}

function assessTitlePage(titlePage) {
  if (titlePage?.hasBoldCenteredTitle) {
    return makeFinding(
      "pass",
      "Bold, centered title detected",
      "A bold, centered paragraph appears among the first paragraphs of the document.",
      "No action required.",
      null,
      layoutLocation("Title page"),
    );
  }

  return makeFinding(
    "warning",
    "Title not detected as bold and centered",
    "No bold, centered paragraph was found at the start of the document.",
    "APA 7 title pages center the title in bold in the upper half of the first page.",
    null,
    layoutLocation("Title page"),
  );
}

function findingsToItemIssues(findings) {
  return findings
    .filter((finding) => finding.status !== "pass")
    .map((finding) =>
      makeItemIssue({
        sectionId: "layout",
        sectionLabel: "Layout",
        status: finding.status,
        title: finding.title,
        detail: finding.detail,
        recommendation: finding.recommendation,
        location: finding.location ?? layoutLocation("Layout"),
      }),
    );
}

function buildPromptFacts(layoutFacts) {
  const { margins, defaultFont, spacing, indentation, pageNumbering, headingStyles, titlePage } = layoutFacts;

  return {
    available: true,
    marginsInches: margins
      ? {
          top: margins.top === null ? null : inches(margins.top),
          right: margins.right === null ? null : inches(margins.right),
          bottom: margins.bottom === null ? null : inches(margins.bottom),
          left: margins.left === null ? null : inches(margins.left),
        }
      : null,
    fontFamily: defaultFont?.family ?? null,
    fontSizePt: defaultFont?.sizePt ?? null,
    doubleSpacedRatio: spacing ? Math.round(spacing.doubleSpacedRatio * 100) / 100 : null,
    spaceAfterRatio: spacing ? Math.round(spacing.spaceAfterRatio * 100) / 100 : null,
    bodyFirstLineIndentRatio: indentation?.body ? Math.round(indentation.body.firstLineRatio * 100) / 100 : null,
    referencesHangingIndentRatio: indentation?.references
      ? Math.round(indentation.references.hangingRatio * 100) / 100
      : null,
    hasPageNumberField: Boolean(pageNumbering?.hasPageNumberField),
    headingLevelsUsed: headingStyles?.levelsUsed ?? [],
    titlePageHasBoldCenteredTitle: Boolean(titlePage?.hasBoldCenteredTitle),
  };
}

const LAYOUT_SECTION_SUMMARY =
  "Measures margins, font, line spacing, indentation, page numbers, and heading styles from the DOCX file's stored settings.";

export function analyzeLayout(layoutFacts, { referencesLocated = true } = {}) {
  const findings = [
    assessMargins(layoutFacts.margins),
    assessFont(layoutFacts.defaultFont),
    assessSpacing(layoutFacts.spacing),
    assessReferenceHangingIndent(layoutFacts.indentation, referencesLocated),
    assessBodyIndent(layoutFacts.indentation),
    assessPageNumbering(layoutFacts.pageNumbering),
    assessHeadingStyles(layoutFacts.headingStyles),
    assessTitlePage(layoutFacts.titlePage),
  ];

  const itemIssues = findingsToItemIssues(findings);

  if (layoutFacts.spacing && layoutFacts.spacing.spaceAfterRatio >= 0.5) {
    itemIssues.push(
      makeItemIssue({
        sectionId: "layout",
        sectionLabel: "Layout",
        status: "warning",
        title: "Extra space between paragraphs",
        detail: `${Math.round(layoutFacts.spacing.spaceAfterRatio * 100)}% of paragraphs add space after the paragraph.`,
        recommendation: 'Set "Spacing After" to 0 pt; APA 7 uses double spacing with no extra space between paragraphs.',
        location: layoutLocation("Paragraph settings"),
      }),
    );
  }

  return {
    section: buildSection("layout", "Layout", LAYOUT_SECTION_SUMMARY, findings),
    itemIssues,
    promptFacts: buildPromptFacts(layoutFacts),
  };
}

export function analyzePdfLayoutPlaceholder() {
  const findings = [
    makeFinding(
      "info",
      "Layout not verifiable from PDF",
      "Margins, fonts, spacing, indentation, and page numbers cannot be measured from extracted PDF text.",
      "Upload the DOCX version to enable measured layout checks, or verify these settings manually.",
      null,
      layoutLocation("PDF upload"),
    ),
  ];

  return {
    section: {
      ...buildSection("layout", "Layout", LAYOUT_SECTION_SUMMARY, findings),
      status: "info",
    },
    itemIssues: [],
    promptFacts: { available: false, reason: "pdf_source" },
  };
}

export function analyzeLayoutFailure(error) {
  const findings = [
    makeFinding(
      "warning",
      "Layout analysis failed",
      `The DOCX layout could not be analyzed: ${error instanceof Error ? error.message : "unknown error"}.`,
      "The rest of the review still ran. Verify margins, font, spacing, and page numbers manually.",
      null,
      layoutLocation("DOCX package"),
    ),
  ];

  return {
    section: buildSection("layout", "Layout", LAYOUT_SECTION_SUMMARY, findings),
    itemIssues: findingsToItemIssues(findings),
    promptFacts: { available: false, reason: "extraction_failed" },
  };
}
