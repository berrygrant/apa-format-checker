import { createHash } from "node:crypto";
import OpenAI from "openai";
import { APA_REVIEW_SCHEMA } from "./apaReportSchema.js";
import { OPENAI_MODEL } from "./config.js";
import { APA_REVIEW_SYSTEM_PROMPT, buildApaReviewUserInput } from "../prompts/apaReviewPrompt.js";

let clientInstance = null;

function getClient() {
  if (!clientInstance) {
    clientInstance = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return clientInstance;
}

function extractJson(text) {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new Error("OpenAI returned an empty response.");
  }

  return JSON.parse(trimmed);
}

function normalizeIssue(issue) {
  return {
    severity: ["pass", "warning", "fail"].includes(issue?.severity) ? issue.severity : "warning",
    title: String(issue?.title ?? "LLM finding"),
    detail: String(issue?.detail ?? ""),
    recommendation: String(issue?.recommendation ?? ""),
    locationLabel: String(issue?.locationLabel ?? ""),
    sourceExcerpt: String(issue?.sourceExcerpt ?? ""),
  };
}

function normalizeSection(section) {
  return {
    sectionId: String(section?.sectionId ?? "overall"),
    label: String(section?.label ?? "LLM Review"),
    status: ["pass", "warning", "fail"].includes(section?.status) ? section.status : "warning",
    summary: String(section?.summary ?? ""),
    issues: Array.isArray(section?.issues) ? section.issues.map(normalizeIssue) : [],
  };
}

function normalizeReport(report) {
  return {
    overallStatus: ["pass", "warning", "fail"].includes(report?.overallStatus) ? report.overallStatus : "warning",
    overallScore:
      Number.isFinite(report?.overallScore) && report.overallScore >= 0 && report.overallScore <= 100
        ? Math.round(report.overallScore)
        : 70,
    summary: String(report?.summary ?? ""),
    confidence: ["low", "medium", "high"].includes(report?.confidence) ? report.confidence : "medium",
    priorityActions: Array.isArray(report?.priorityActions) ? report.priorityActions.map(String) : [],
    limitations: Array.isArray(report?.limitations) ? report.limitations.map(String) : [],
    sections: Array.isArray(report?.sections) ? report.sections.map(normalizeSection) : [],
  };
}

export async function runOpenAiReview({ jobId, fileMeta, parsedDocument, ruleBasedReport, onTextDelta }) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      skipped: true,
      failed: false,
      model: null,
      rawText: "",
      message: "OPENAI_API_KEY is not configured, so only the rule-based APA review was run.",
      report: null,
    };
  }

  try {
    const client = getClient();
    const requestPayload = {
      model: OPENAI_MODEL,
      input: [
        {
          role: "system",
          content: APA_REVIEW_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildApaReviewUserInput({
            fileMeta,
            parsedDocument,
            ruleBasedReport,
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "apa_review_report",
          strict: true,
          schema: APA_REVIEW_SCHEMA,
        },
      },
      safety_identifier: createHash("sha256").update(jobId).digest("hex"),
    };

    let rawText = "";
    let parsed;
    let responseId = null;

    if (typeof client.responses.stream === "function") {
      const stream = client.responses.stream(requestPayload);

      stream.on("response.output_text.delta", (event) => {
        rawText += event.delta;
        onTextDelta?.(event.delta);
      });

      const finalResponse = await stream.finalResponse();
      responseId = finalResponse.id;
      rawText = rawText || finalResponse.output_text || JSON.stringify(finalResponse.output_parsed ?? {});
      parsed = normalizeReport(finalResponse.output_parsed ?? extractJson(rawText));
    } else {
      const response = await client.responses.parse(requestPayload);
      responseId = response.id;
      parsed = normalizeReport(response.output_parsed);
      rawText = JSON.stringify(parsed);
    }

    return {
      skipped: false,
      failed: false,
      model: OPENAI_MODEL,
      rawText,
      responseId,
      message: "OpenAI APA review completed.",
      report: parsed,
    };
  } catch (error) {
    return {
      skipped: false,
      failed: true,
      model: OPENAI_MODEL,
      rawText: "",
      message: error instanceof Error ? error.message : "OpenAI review failed.",
      report: null,
    };
  }
}
