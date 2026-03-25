function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function statusRank(status) {
  if (status === "fail") {
    return 2;
  }

  if (status === "warning") {
    return 1;
  }

  return 0;
}

function combineStatus(ruleStatus, llmStatus) {
  if (!llmStatus) {
    return ruleStatus;
  }

  return statusRank(llmStatus) > statusRank(ruleStatus) ? llmStatus : ruleStatus;
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

function buildIssueInventory(ruleBasedReport, llmReview) {
  const ruleBasedItems = (ruleBasedReport.itemIssues ?? []).map((issue) => ({
    ...issue,
    evidence: issue.location?.excerpt ?? null,
  }));

  const llmItems = (llmReview.report?.sections ?? []).flatMap((section) =>
    section.issues.map((issue) => ({
      source: "llm",
      sectionId: section.sectionId,
      sectionLabel: section.label,
      status: issue.severity,
      title: issue.title,
      detail: issue.detail,
      recommendation: issue.recommendation,
      evidence: issue.sourceExcerpt || null,
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

  return [...ruleBasedItems, ...llmItems];
}

export function buildFinalReport({ job, parsedDocument, ruleBasedReport, llmReview }) {
  const llmStatus = llmReview.report?.overallStatus ?? null;
  const overallStatus = combineStatus(ruleBasedReport.summary.overallStatus, llmStatus);
  const llmSummaryStatus = llmStatus ?? (llmReview.skipped ? "skipped" : llmReview.failed ? "failed" : null);
  const overallScore =
    typeof llmReview.report?.overallScore === "number"
      ? Math.round((ruleBasedReport.summary.score + llmReview.report.overallScore) / 2)
      : ruleBasedReport.summary.score;

  const priorityActions = buildPriorityActions(ruleBasedReport, llmReview);
  const issueInventory = buildIssueInventory(ruleBasedReport, llmReview);
  const limitations = unique([
    ...ruleBasedReport.limitations,
    ...(llmReview.report?.limitations ?? []),
    ...(llmReview.failed ? [llmReview.message] : []),
    ...(llmReview.skipped ? [llmReview.message] : []),
  ]);

  return {
    version: "2.0.0",
    jobId: job.id,
    generatedAt: new Date().toISOString(),
    document: {
      filename: job.fileMeta.name,
      sizeBytes: job.fileMeta.sizeBytes,
      mimeType: job.fileMeta.mimeType,
      totalWords: parsedDocument.wordCount,
      referencesMissing: parsedDocument.referencesMissing,
      excerpts: {
        titlePage: parsedDocument.titlePageText,
        body: parsedDocument.bodyText,
        references: parsedDocument.referencesText,
      },
      metrics: parsedDocument.metrics,
      parserMessages: parsedDocument.parserMessages,
    },
    summary: {
      overallStatus,
      overallScore,
      headline: summarizeHybridHeadline(ruleBasedReport, llmReview, overallStatus),
      ruleBasedStatus: ruleBasedReport.summary.overallStatus,
      llmStatus: llmSummaryStatus,
      passCount: ruleBasedReport.summary.passCount,
      warningCount: ruleBasedReport.summary.warningCount,
      failCount: ruleBasedReport.summary.failCount,
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
