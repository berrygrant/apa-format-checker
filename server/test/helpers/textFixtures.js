import { buildParsedDocument } from "../../src/lib/docxParser.js";

export function parseRawText(rawText, { sourceFormat = "docx", parserMessages = [], reviewMode = "standard" } = {}) {
  return buildParsedDocument(
    {
      sourceFormat,
      sourceLabel: sourceFormat === "pdf" ? "PDF" : "DOCX",
      rawText,
      parserMessages,
    },
    { reviewMode },
  );
}

export const SIMPLE_THESIS_TEXT = [
  "Effects of Sleep on Working Memory",
  "Jordan Rivera",
  "Department of Psychology, Example University",
  "PSY 6100: Thesis Seminar",
  "Dr. Casey Morgan",
  "May 4, 2026",
  "",
  "Abstract",
  "This study examined the relationship between sleep duration and working memory performance in graduate students.",
  "",
  "Introduction",
  "Sleep is central to cognitive performance (Walker, 2017). Prior studies found strong effects of sleep loss on attention (Lim & Dinges, 2010).",
  "Narrative reviews also support this conclusion, as Walker (2017) argued.",
  "",
  "Method",
  "Participants completed a working memory battery after a normal night of sleep.",
  "",
  "Results",
  "Sleep duration predicted working memory accuracy.",
  "",
  "Discussion",
  "These findings replicate earlier work (Walker, 2017).",
  "",
  "References",
  "Lim, J., & Dinges, D. F. (2010). A meta-analysis of the impact of short-term sleep deprivation on cognitive variables. Psychological Bulletin, 136(3), 375-389. https://doi.org/10.1037/a0018883",
  "",
  "Walker, M. (2017). Why we sleep. Scribner.",
].join("\n");
