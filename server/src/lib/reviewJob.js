import { parseDocxBuffer, summarizeParsedDocument } from "./docxParser.js";
import { runRuleBasedReview } from "./ruleChecks.js";
import { runOpenAiReview } from "./openaiReview.js";
import { buildFinalReport } from "./reportBuilder.js";
import { appendLlmPreview, completeJob, failJob, setJobStage, upsertJobSection } from "./jobStore.js";

function createParserSection(summary) {
  return {
    id: "parser",
    label: "Parser",
    status: summary.referencesMissing || summary.parserMessages.length > 0 ? "warning" : "pass",
    score: summary.referencesMissing ? 78 : 95,
    summary: summary.referencesMissing
      ? 'The DOCX parsed, but a standalone "References" heading was not detected.'
      : "The DOCX parsed successfully and the review excerpts were extracted.",
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
    setJobStage(job, "parsing_document", "Parsing document...", 10);
    const parsedDocument = await parseDocxBuffer(buffer);
    const parsedSummary = summarizeParsedDocument(parsedDocument);
    upsertJobSection(job, createParserSection(parsedSummary));

    setJobStage(job, "running_rule_checks", "Running rule-based checks...", 30);
    const ruleBasedReport = runRuleBasedReview(parsedDocument);

    for (const sectionId of ["document", "titlePage", "body"]) {
      const section = ruleBasedReport.sections.find((item) => item.id === sectionId);
      if (section) {
        upsertJobSection(job, section);
      }
    }

    setJobStage(job, "evaluating_citations", "Evaluating citations...", 55);
    const citationsSection = ruleBasedReport.sections.find((item) => item.id === "citations");
    if (citationsSection) {
      upsertJobSection(job, citationsSection);
    }

    setJobStage(job, "evaluating_references", "Evaluating references...", 72);
    const referencesSection = ruleBasedReport.sections.find((item) => item.id === "references");
    if (referencesSection) {
      upsertJobSection(job, referencesSection);
    }

    setJobStage(
      job,
      "llm_review",
      process.env.OPENAI_API_KEY ? "Streaming OpenAI APA review..." : "Skipping OpenAI review and finalizing...",
      86,
    );

    const llmReview = await runOpenAiReview({
      jobId: job.id,
      fileMeta: job.fileMeta,
      parsedDocument,
      ruleBasedReport,
      onTextDelta: (delta) => appendLlmPreview(job, delta),
    });

    upsertJobSection(job, createLlmSection(llmReview));

    setJobStage(job, "finalizing", "Finalizing APA report...", 96);
    const finalReport = buildFinalReport({
      job,
      parsedDocument,
      ruleBasedReport,
      llmReview,
    });

    completeJob(job, finalReport);
  } catch (error) {
    failJob(job, error);
  }
}
