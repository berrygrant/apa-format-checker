import { parseDocumentBuffer, summarizeParsedDocument } from "./docxParser.js";
import { extractDocxLayout } from "./docxLayout.js";
import { analyzeLayout, analyzeLayoutFailure, analyzePdfLayoutPlaceholder } from "./layoutChecks.js";
import {
  analyzeBody,
  analyzeCitations,
  analyzeDocumentStructure,
  analyzeReferences,
  analyzeTitlePage,
  assembleRuleBasedReport,
  extractCitationData,
  extractReferenceData,
} from "./ruleChecks.js";
import { runOpenAiReview } from "./openaiReview.js";
import { buildFinalReport } from "./reportBuilder.js";
import { appendLlmPreview, completeJob, failJob, setJobStage, upsertJobSection } from "./jobStore.js";

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createParserSection(summary) {
  const sourceLabel = summary.sourceLabel || "document";

  return {
    id: "parser",
    label: "Parser",
    status: summary.referencesMissing || summary.parserMessages.length > 0 ? "warning" : "pass",
    score: summary.referencesMissing ? 78 : 95,
    summary: summary.referencesMissing
      ? `The ${sourceLabel} parsed, but a standalone "References" heading was not detected in the extracted text.`
      : `The ${sourceLabel} parsed successfully and the review excerpts were extracted.`,
    findings: [
      {
        id: "parser-summary",
        status: summary.referencesMissing ? "warning" : "pass",
        title: "Document extraction",
        detail: `Parsed ${summary.wordCount} words and ${summary.referenceEntryCount} reference entries.`,
        recommendation: summary.referencesMissing
          ? 'Review the source document and ensure a standalone "References" heading exists.'
          : "No parser action required.",
        evidence: summary.previews.body,
      },
    ],
    metrics: {
      wordCount: summary.wordCount,
      referenceEntryCount: summary.referenceEntryCount,
    },
    previews: summary.previews,
  };
}

function createLlmSection(llmReview) {
  if (llmReview.skipped) {
    return {
      id: "llm",
      label: "OpenAI Review",
      status: "warning",
      score: 70,
      summary: "The LLM review stage was skipped.",
      findings: [
        {
          id: "llm-skipped",
          status: "warning",
          title: "OpenAI stage skipped",
          detail: llmReview.message,
          recommendation: "Set OPENAI_API_KEY to enable the structured APA review stage.",
          evidence: null,
        },
      ],
      metrics: {},
    };
  }

  if (llmReview.failed) {
    return {
      id: "llm",
      label: "OpenAI Review",
      status: "warning",
      score: 65,
      summary: "The LLM review stage failed and the app fell back to rule-based output only.",
      findings: [
        {
          id: "llm-failed",
          status: "warning",
          title: "OpenAI stage failed",
          detail: llmReview.message,
          recommendation: "Check the API key, model configuration, and outbound network access.",
          evidence: null,
        },
      ],
      metrics: {},
    };
  }

  return {
    id: "llm",
    label: "OpenAI Review",
    status: llmReview.report.overallStatus,
    score: llmReview.report.overallScore,
    summary: llmReview.report.summary,
    findings: llmReview.report.sections.flatMap((section) =>
      section.issues.map((issue) => ({
        id: `${section.sectionId}-${issue.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        status: issue.severity,
        title: `${section.label}: ${issue.title}`,
        detail: issue.detail,
        recommendation: issue.recommendation,
        evidence: issue.sourceExcerpt || null,
        location: issue.locationLabel
          ? {
              label: issue.locationLabel,
              excerpt: issue.sourceExcerpt || "",
            }
          : null,
      })),
    ),
    metrics: {
      confidence: llmReview.report.confidence,
      sectionCount: llmReview.report.sections.length,
    },
  };
}

export async function processReviewJob(job, buffer) {
  try {
    setJobStage(
      job,
      "parsing_document",
      job.reviewMode === "comprehensive" ? "Parsing document for comprehensive review..." : "Parsing document...",
      10,
    );
    const parsedDocument = await parseDocumentBuffer(buffer, job.fileMeta, { reviewMode: job.reviewMode });
    const parsedSummary = summarizeParsedDocument(parsedDocument);
    upsertJobSection(job, createParserSection(parsedSummary));

    const isDocx = parsedDocument.sourceFormat === "docx";
    setJobStage(
      job,
      "analyzing_layout",
      isDocx ? "Measuring margins, font, spacing, and page numbers..." : "Layout checks are limited for PDF uploads.",
      18,
    );

    let layoutPart;

    if (isDocx) {
      try {
        const layoutFacts = await extractDocxLayout(buffer);
        layoutPart = analyzeLayout(layoutFacts, { referencesLocated: !parsedDocument.referencesMissing });
      } catch (error) {
        layoutPart = analyzeLayoutFailure(error);
      }
    } else {
      layoutPart = analyzePdfLayoutPlaceholder();
    }

    upsertJobSection(job, layoutPart.section);
    await yieldToEventLoop();

    setJobStage(job, "running_rule_checks", "Running rule-based checks...", 30);
    const citationData = extractCitationData(parsedDocument.bodyLineRecords);
    await yieldToEventLoop();
    const referenceData = extractReferenceData(parsedDocument);
    await yieldToEventLoop();

    const parts = [{ section: layoutPart.section, itemIssues: layoutPart.itemIssues }];
    for (const analyze of [analyzeDocumentStructure, analyzeTitlePage, analyzeBody]) {
      const part = analyze(parsedDocument);
      parts.push(part);
      upsertJobSection(job, part.section);
      await yieldToEventLoop();
    }

    setJobStage(job, "evaluating_citations", "Evaluating citations...", 48);
    const citationsPart = analyzeCitations(parsedDocument, citationData, referenceData);
    parts.push(citationsPart);
    upsertJobSection(job, citationsPart.section);
    await yieldToEventLoop();

    setJobStage(job, "evaluating_references", "Evaluating references...", 62);
    const referencesPart = analyzeReferences(parsedDocument, citationData, referenceData);
    parts.push(referencesPart);
    upsertJobSection(job, referencesPart.section);
    await yieldToEventLoop();

    const ruleBasedReport = assembleRuleBasedReport({ parsedDocument, citationData, referenceData, parts });

    setJobStage(
      job,
      "llm_review",
      process.env.OPENAI_API_KEY
        ? job.reviewMode === "comprehensive"
          ? "Streaming comprehensive OpenAI APA review..."
          : "Streaming OpenAI APA review..."
        : "Skipping OpenAI review and finalizing...",
      72,
    );

    const llmReview = await runOpenAiReview({
      jobId: job.id,
      fileMeta: job.fileMeta,
      parsedDocument,
      ruleBasedReport,
      layoutFacts: layoutPart.promptFacts,
      reviewMode: job.reviewMode,
      onTextDelta: (delta) => appendLlmPreview(job, delta),
    });

    upsertJobSection(job, createLlmSection(llmReview));

    setJobStage(job, "finalizing", "Finalizing APA report...", 96);
    const finalReport = buildFinalReport({
      job,
      parsedDocument,
      ruleBasedReport,
      layoutFacts: layoutPart.promptFacts,
      llmReview,
    });

    completeJob(job, finalReport);
  } catch (error) {
    failJob(job, error);
  }
}
