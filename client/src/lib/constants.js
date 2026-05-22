export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = [".docx", ".pdf"];
export const SUPPORTED_FILE_LABEL = "DOCX or PDF";

export const REVIEW_MODES = [
  {
    id: "standard",
    label: "Standard",
    description: "Balanced review focused on the most actionable APA issues supported by extracted evidence.",
  },
  {
    id: "comprehensive",
    label: "Comprehensive",
    description: "Larger evidence window and a more exhaustive issue sweep across supported APA deviations.",
  },
];

export const REVIEW_STAGES = [
  { id: "queued", label: "Queued" },
  { id: "parsing_document", label: "Parsing document" },
  { id: "running_rule_checks", label: "Rule-based checks" },
  { id: "evaluating_citations", label: "Evaluating citations" },
  { id: "evaluating_references", label: "Evaluating references" },
  { id: "llm_review", label: "OpenAI review" },
  { id: "finalizing", label: "Finalizing report" },
  { id: "completed", label: "Complete" },
];

export const SECTION_SLOTS = [
  { id: "parser", label: "Parser" },
  { id: "document", label: "Document Structure" },
  { id: "titlePage", label: "Title Page" },
  { id: "body", label: "Body and Headings" },
  { id: "citations", label: "Citations" },
  { id: "references", label: "References" },
  { id: "llm", label: "OpenAI Review" },
];
