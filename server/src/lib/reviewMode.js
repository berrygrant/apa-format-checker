export const DEFAULT_REVIEW_MODE = "standard";

export const REVIEW_MODE_CONFIG = {
  standard: {
    label: "Standard",
    description: "Balanced review focused on the most actionable APA issues supported by extracted evidence.",
    extraction: {
      titlePageWords: 400,
      bodyWords: 2000,
      referencesWords: 2500,
      annotatedTitleLines: 40,
      annotatedBodyLines: 160,
      annotatedReferenceEntries: 120,
    },
    llmInstruction:
      "Standard mode: prioritize the highest-impact APA deviations and the clearest corrective actions. Avoid duplicative restatements of repetitive evidence.",
  },
  comprehensive: {
    label: "Comprehensive",
    description: "Expanded review window with a more exhaustive issue sweep across supported APA deviations.",
    extraction: {
      titlePageWords: 600,
      bodyWords: 5000,
      referencesWords: 5000,
      annotatedTitleLines: 80,
      annotatedBodyLines: 320,
      annotatedReferenceEntries: 220,
    },
    llmInstruction:
      "Comprehensive mode: surface as many distinct APA deviations as the provided evidence supports. Prefer recall over brevity, but keep one issue per discrete problem and do not invent unsupported layout facts.",
  },
};

export const VALID_REVIEW_MODES = new Set(Object.keys(REVIEW_MODE_CONFIG));

export function normalizeReviewMode(value) {
  const normalized = String(value ?? DEFAULT_REVIEW_MODE)
    .trim()
    .toLowerCase();

  return VALID_REVIEW_MODES.has(normalized) ? normalized : null;
}

export function getReviewModeConfig(reviewMode = DEFAULT_REVIEW_MODE) {
  return REVIEW_MODE_CONFIG[reviewMode] ?? REVIEW_MODE_CONFIG[DEFAULT_REVIEW_MODE];
}

export function getReviewModeLabel(reviewMode = DEFAULT_REVIEW_MODE) {
  return getReviewModeConfig(reviewMode).label;
}
