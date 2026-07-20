import { getReviewModeConfig, getReviewModeLabel } from "./reviewMode.js";
import { computeWeightedScore, countByStatus, worstStatus } from "./scoring.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function combineStatus(ruleStatus, llmStatus) {
  if (!llmStatus) {
    return ruleStatus;
  }

  return worstStatus(ruleStatus, llmStatus);
}

function summarizeHybridHeadline(ruleBasedReport, llmReview, overallStatus) {
  if (llmReview.report?.summary) {
    return llmReview.report.summary;
  }

  if (overallStatus === "fail") {
    return ruleBasedReport.summary.headline;
  }

  if (llmReview.skipped) {
    return `${ruleBasedReport.summary.headline} The LLM stage was skipped because no API key was configured.`;
  }

  if (llmReview.failed) {
    return `${ruleBasedReport.summary.headline} The LLM stage failed, so this result reflects only the rule-based checks.`;
  }

  return ruleBasedReport.summary.headline;
}

function buildPriorityActions(ruleBasedReport, llmReview) {
  const localActions = ruleBasedReport.sections.flatMap((section) =>
    section.findings
      .filter((finding) => finding.status === "fail" || finding.status === "warning")
      .map((finding) => finding.recommendation),
  );

  return unique([...localActions, ...(llmReview.report?.priorityActions ?? [])]).slice(0, 8);
}

function titleTokens(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

function titleSimilarity(leftTitle, rightTitle) {
  const leftTokens = titleTokens(leftTitle);
  const rightTokens = titleTokens(rightTitle);

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let sharedCount = 0;

  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      sharedCount += 1;
    }
  }

  return sharedCount / (leftTokens.size + rightTokens.size - sharedCount);
}

function extractLineNumber(locationLabel) {
  const match = String(locationLabel || "").match(/\b(?:L|lines?\s+)(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function isDuplicateOfRuleItem(llmItem, ruleItem) {
  if (llmItem.sectionId !== ruleItem.sectionId) {
    return false;
  }

  const similarity = titleSimilarity(llmItem.title, ruleItem.title);

  if (similarity >= 0.6) {
    return true;
  }

  const llmLine = extractLineNumber(llmItem.location?.label);

  return llmLine !== null && llmLine === ruleItem.location?.lineStart && similarity >= 0.25;
}

// Both stages often surface the same problem. Keep the rule-based item (it has
// structured coordinates) and mark it as confirmed by the AI pass instead of
// listing the problem twice.
export function dedupeIssueInventory(ruleItems, llmItems) {
  const inventory = ruleItems.map((issue) => ({
    ...issue,
    evidence: issue.location?.excerpt ?? null,
    alsoFlaggedByLlm: false,
  }));

  for (const llmItem of llmItems) {
    const duplicateRuleItem = inventory.find((candidate) => candidate.source === "rule_based" && isDuplicateOfRuleItem(llmItem, candidate));

    if (duplicateRuleItem) {
      duplicateRuleItem.alsoFlaggedByLlm = true;
      continue;
    }

    inventory.push(llmItem);
  }

  return inventory;
}

function buildLlmItems(llmReview) {
  return (llmReview.report?.sections ?? []).flatMap((section) =>
    section.issues.map((issue) => ({
      source: "llm",
      sectionId: section.sectionId,
      sectionLabel: section.label,
      status: issue.severity,
      title: issue.title,
      detail: issue.detail,
      recommendation: issue.recommendation,
      evidence: issue.sourceExcerpt || null,
      alsoFlaggedByLlm: false,
      location: {
        sectionId: section.sectionId,
        lineStart: null,
        lineEnd: null,
        paragraphNumber: null,
        entryNumber: null,
        label: issue.locationLabel || `${section.label} location unavailable`,
        excerpt: issue.sourceExcerpt || "",
      },
    })),
  );
}

export function buildFinalReport({ job, parsedDocument, ruleBasedReport, layoutFacts = { available: false }, llmReview }) {
  const reviewModeConfig = getReviewModeConfig(job.reviewMode);
  const llmStatus = llmReview.report?.overallStatus ?? null;
  const overallStatus = combineStatus(ruleBasedReport.summary.overallStatus, llmStatus);
  const llmSummaryStatus = llmStatus ?? (llmReview.skipped ? "skipped" : llmReview.failed ? "failed" : null);

  const priorityActions = buildPriorityActions(ruleBasedReport, llmReview);
  const llmItems = buildLlmItems(llmReview);
  const issueInventory = dedupeIssueInventory(ruleBasedReport.itemIssues ?? [], llmItems);
  const issueCounts = countByStatus(issueInventory.filter((issue) => issue.status !== "pass"));
  const overallScore = computeWeightedScore(issueCounts);
  const limitations = unique([
    ...ruleBasedReport.limitations,
    ...(llmReview.report?.limitations ?? []),
    ...(llmReview.failed ? [llmReview.message] : []),
    ...(llmReview.skipped ? [llmReview.message] : []),
  ]);

  return {
    version: "3.1.0",
    jobId: job.id,
    generatedAt: new Date().toISOString(),
    review: {
      mode: job.reviewMode,
      label: getReviewModeLabel(job.reviewMode),
      description: reviewModeConfig.description,
    },
    document: {
      filename: job.fileMeta.name,
      sizeBytes: job.fileMeta.sizeBytes,
      mimeType: job.fileMeta.mimeType,
      sourceFormat: parsedDocument.sourceFormat,
      totalWords: parsedDocument.wordCount,
      referencesMissing: parsedDocument.referencesMissing,
      extractionWindow: parsedDocument.extractionWindow,
      excerpts: {
        titlePage: parsedDocument.titlePageText,
        body: parsedDocument.bodyText,
        references: parsedDocument.referencesText,
      },
      metrics: parsedDocument.metrics,
      parserMessages: parsedDocument.parserMessages,
      layout: layoutFacts,
    },
    summary: {
      overallStatus,
      overallScore,
      headline: summarizeHybridHeadline(ruleBasedReport, llmReview, overallStatus),
      ruleBasedStatus: ruleBasedReport.summary.overallStatus,
      llmStatus: llmSummaryStatus,
      // "Checks passed" comes from the fixed per-section findings; the issue
      // counts come from the deduplicated item inventory (rule + AI).
      passCount: ruleBasedReport.summary.passCount,
      warningCount: issueCounts.warning,
      failCount: issueCounts.fail,
      infoCount: issueCounts.info,
      aiAssessment: llmReview.report
        ? {
            overallScore: llmReview.report.overallScore,
            overallStatus: llmReview.report.overallStatus,
            confidence: llmReview.report.confidence,
          }
        : null,
    },
    ruleBased: ruleBasedReport,
    llm: {
      enabled: Boolean(process.env.OPENAI_API_KEY),
      skipped: llmReview.skipped,
      failed: llmReview.failed,
      model: llmReview.model,
      message: llmReview.message,
      confidence: llmReview.report?.confidence ?? "low",
      sections: llmReview.report?.sections ?? [],
      priorityActions: llmReview.report?.priorityActions ?? [],
      limitations: llmReview.report?.limitations ?? [],
      streamedTextPreview: llmReview.rawText.slice(0, 4000),
    },
    priorityActions,
    issueInventory,
    crossChecks: ruleBasedReport.crossChecks,
    limitations,
  };
}
