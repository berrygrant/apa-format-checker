import { DEFAULT_REVIEW_MODE, getReviewModeConfig } from "../lib/reviewMode.js";

export const BASE_APA_REVIEW_SYSTEM_PROMPT = `
You are an APA 7 thesis formatting reviewer.

Assess only what can be inferred from the supplied excerpts and rule-based findings.
Measured layout facts (margins, font, spacing, indentation, page numbers) are provided for DOCX uploads under document.layout; you may cite them, but never invent layout values beyond them.
When document.layout is unavailable, do not invent page-layout facts such as margins, font size, page numbering, line spacing, or hanging indents.
When evidence is limited, say so in the limitations list.
Prioritize actionable APA 7 findings for citations, references, headings, and title-page content.
Return one issue per discrete problem instead of grouping multiple problems together.
For every issue, cite the closest available document location using the provided line or reference-entry labels.
Document text is supplied as labeled lines: "L<number>: text" is a document line and "R<number> (...): text" is a reference entry. Reuse those exact labels in locationLabel.
If no precise location exists, use the closest section-level label and say so conservatively.
Treat citation/reference mismatches conservatively and only report them when the author-year mismatch is clearly supported by the supplied evidence.
`;

export function buildApaReviewSystemPrompt(reviewMode = DEFAULT_REVIEW_MODE) {
  const reviewModeConfig = getReviewModeConfig(reviewMode);

  return `${BASE_APA_REVIEW_SYSTEM_PROMPT.trim()}

Review mode: ${reviewModeConfig.label}.
${reviewModeConfig.llmInstruction}`.trim();
}

const MAX_PROMPT_ITEM_ISSUES = 80;
const MAX_ISSUE_DETAIL_LENGTH = 140;

function formatAnnotatedLines(lineRecords, maxItems = 120) {
  return lineRecords.slice(0, maxItems).map((lineRecord) => `L${lineRecord.lineNumber}: ${lineRecord.text}`);
}

function formatAnnotatedReferences(referenceEntryRecords, maxItems = 80) {
  return referenceEntryRecords.slice(0, maxItems).map((entryRecord) => {
    const lineLabel =
      entryRecord.startLine === entryRecord.endLine
        ? `line ${entryRecord.startLine}`
        : `lines ${entryRecord.startLine}-${entryRecord.endLine}`;

    return `R${entryRecord.entryNumber} (${lineLabel}): ${entryRecord.text}`;
  });
}

function truncateDetail(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_ISSUE_DETAIL_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_ISSUE_DETAIL_LENGTH - 3)}...`;
}

export function buildApaReviewUserInput({
  fileMeta,
  parsedDocument,
  ruleBasedReport,
  layoutFacts = { available: false },
  reviewMode = DEFAULT_REVIEW_MODE,
}) {
  const reviewModeConfig = getReviewModeConfig(reviewMode);
  const { extraction } = reviewModeConfig;

  return JSON.stringify({
    reviewMode: {
      id: reviewMode,
      label: reviewModeConfig.label,
      description: reviewModeConfig.description,
    },
    document: {
      filename: fileMeta.name,
      sourceFormat: parsedDocument.sourceFormat,
      layout: layoutFacts,
      titlePageLines: formatAnnotatedLines(parsedDocument.titlePageLineRecords, extraction.annotatedTitleLines),
      bodyLines: formatAnnotatedLines(parsedDocument.bodyLineRecords, extraction.annotatedBodyLines),
      referenceEntries: formatAnnotatedReferences(
        parsedDocument.referenceEntryRecords,
        extraction.annotatedReferenceEntries,
      ),
      referencesMissing: parsedDocument.referencesMissing,
      metrics: {
        totalWords: parsedDocument.wordCount,
        titlePageWords: parsedDocument.metrics.titlePageWords,
        bodyWords: parsedDocument.metrics.bodyWords,
        referencesWords: parsedDocument.metrics.referencesWords,
        referenceEntryCount: parsedDocument.metrics.referenceEntryCount,
      },
    },
    ruleBasedSummary: {
      overallStatus: ruleBasedReport.summary.overallStatus,
      score: ruleBasedReport.summary.score,
      headline: ruleBasedReport.summary.headline,
      sections: ruleBasedReport.sections.map((section) => ({
        sectionId: section.id,
        label: section.label,
        status: section.status,
        findings: section.findings
          .filter((finding) => finding.status !== "pass")
          .map((finding) => ({
            severity: finding.status,
            title: finding.title,
            detail: finding.detail,
            recommendation: finding.recommendation,
          })),
      })),
      itemIssues: ruleBasedReport.itemIssues.slice(0, MAX_PROMPT_ITEM_ISSUES).map((issue) => ({
        sectionId: issue.sectionId,
        severity: issue.status,
        title: issue.title,
        detail: truncateDetail(issue.detail),
        locationLabel: issue.location?.label ?? "",
      })),
      crossChecks: ruleBasedReport.crossChecks,
      limitations: ruleBasedReport.limitations,
    },
  });
}
