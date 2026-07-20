const issueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title", "detail", "recommendation", "locationLabel", "sourceExcerpt"],
  properties: {
    severity: {
      type: "string",
      enum: ["pass", "warning", "fail"],
    },
    title: {
      type: "string",
    },
    detail: {
      type: "string",
    },
    recommendation: {
      type: "string",
    },
    locationLabel: {
      type: "string",
    },
    sourceExcerpt: {
      type: "string",
    },
  },
};

const sectionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sectionId", "label", "status", "summary", "issues"],
  properties: {
    sectionId: {
      type: "string",
      enum: ["document", "layout", "titlePage", "body", "citations", "references", "overall"],
    },
    label: {
      type: "string",
    },
    status: {
      type: "string",
      enum: ["pass", "warning", "fail"],
    },
    summary: {
      type: "string",
    },
    issues: {
      type: "array",
      items: issueSchema,
    },
  },
};

export const APA_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["overallStatus", "overallScore", "summary", "confidence", "priorityActions", "limitations", "sections"],
  properties: {
    overallStatus: {
      type: "string",
      enum: ["pass", "warning", "fail"],
    },
    overallScore: {
      type: "integer",
      minimum: 0,
      maximum: 100,
    },
    summary: {
      type: "string",
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
    priorityActions: {
      type: "array",
      items: {
        type: "string",
      },
    },
    limitations: {
      type: "array",
      items: {
        type: "string",
      },
    },
    sections: {
      type: "array",
      items: sectionSchema,
    },
  },
};
