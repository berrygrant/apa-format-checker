import { takeReferenceExcerpt } from "../lib/docxParser.js";
import { DEFAULT_REVIEW_MODE, getReviewModeConfig } from "../lib/reviewMode.js";

export const BASE_APA_REVIEW_SYSTEM_PROMPT = `
You are an APA 7 thesis formatting reviewer.

Assess only what can be inferred from the supplied excerpts and rule-based findings.
Do not invent page-layout facts such as margins, font size, page numbering, line spacing, or hanging indents unless the evidence explicitly supports them.
When evidence is limited, say so in the limitations list.
Prioritize actionable APA 7 findings for citations, references, headings, and title-page content.
Return one issue per discrete problem instead of grouping multiple problems together.
For every issue, cite the closest available document location using the provided line or reference-entry labels.
If no precise location exists, use the closest section-level label and say so conservatively.
Treat citation/reference mismatches conservatively and only report them when the author-year mismatch is clearly supported by the supplied evidence.
`;

export function buildApaReviewSystemPrompt(reviewMode = DEFAULT_REVIEW_MODE) {
  const reviewModeConfig = getReviewModeConfig(reviewMode);

  return `${BASE_APA_REVIEW_SYSTEM_PROMPT.trim()}

Review mode: ${reviewModeConfig.label}.
${reviewModeConfig.llmInstruction}`.trim();
}

function formatAnnotatedLines(lineRecords, maxItems = 120) {
  return lineRecords.slice(0, maxItems).map((lineRecord) => ({
    label: `L${lineRecord.lineNumber}`,
    lineNumber: lineRecord.lineNumber,
    paragraphNumber: lineRecord.paragraphNumber,
    text: lineRecord.text,
  }));
}

function formatAnnotatedReferences(referenceEntryRecords, maxItems = 80) {
  return referenceEntryRecords.slice(0, maxItems).map((entryRecord) => ({
    label:
      entryRecord.startLine === entryRecord.endLine
        ? `R${entryRecord.entryNumber} (line ${entryRecord.startLine})`
        : `R${entryRecord.entryNumber} (lines ${entryRecord.startLine}-${entryRecord.endLine})`,
    entryNumber: entryRecord.entryNumber,
    lineStart: entryRecord.startLine,
    lineEnd: entryRecord.endLine,
    text: entryRecord.text,
  }));
}

export function buildApaReviewUserInput({ fileMeta, parsedDocument, ruleBasedReport, reviewMode = DEFAULT_REVIEW_MODE }) {
  const reviewModeConfig = getReviewModeConfig(reviewMode);
  const { extraction } = reviewModeConfig;

  return JSON.stringify(
    {
      reviewMode: {
        id: reviewMode,
        label: reviewModeConfig.label,
        description: reviewModeConfig.description,
      },
      document: {
        filename: fileMeta.name,
        sizeBytes: fileMeta.sizeBytes,
        sourceFormat: parsedDocument.sourceFormat,
        titlePageExcerpt: parsedDocument.titlePageText,
        bodyExcerpt: parsedDocument.bodyText,
        referencesExcerpt: takeReferenceExcerpt(parsedDocument.referencesText, extraction.referencesWords),
        annotatedTitlePageLines: formatAnnotatedLines(parsedDocument.titlePageLineRecords, extraction.annotatedTitleLines),
        annotatedBodyLines: formatAnnotatedLines(parsedDocument.bodyLineRecords, extraction.annotatedBodyLines),
        annotatedReferenceEntries: formatAnnotatedReferences(
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
        itemIssues: ruleBasedReport.itemIssues.map((issue) => ({
          sectionId: issue.sectionId,
          sectionLabel: issue.sectionLabel,
          severity: issue.status,
          title: issue.title,
          detail: issue.detail,
          recommendation: issue.recommendation,
          locationLabel: issue.location?.label ?? "",
          sourceExcerpt: issue.location?.excerpt ?? "",
        })),
        crossChecks: ruleBasedReport.crossChecks,
        limitations: ruleBasedReport.limitations,
      },
    },
    null,
    2,
  );
}
