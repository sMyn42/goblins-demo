import type { ExtractedAnswer, Question } from "./contracts";

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
export const evaluateCriteria = (question: Question, answer: ExtractedAnswer) => question.criteria.map((criterion) => {
  const config = criterion.evaluator;
  let outcome: "MATCH" | "MISMATCH" | "INCONCLUSIVE" = "INCONCLUSIVE";
  // Uncertain OCR never establishes a safe deterministic match.
  const certain = answer.lines.length > 0 && answer.lines.every((line) => line.kind !== "unknown" && (answer.ocrProvider === "typed" || (line.confidence !== undefined && line.confidence >= 0.95)));
  if (criterion.method !== "ai" && config && certain) {
    const last = answer.lines.at(-1)?.text ?? "";
    if (config.type === "numeric") {
      const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
      if (numeric.test(last.trim()) && config.answers.every((a) => numeric.test(a.trim()))) {
        outcome = config.answers.some((a) => Math.abs(Number(last) - Number(a)) <= (config.tolerance ?? 0)) ? "MATCH" : "MISMATCH";
      }
    } else {
      const text = config.type === "exact_text" ? answer.fullText : last;
      outcome = config.answers.some((candidate) => normalize(text) === normalize(candidate)) ? "MATCH" : "MISMATCH";
    }
  }
  return { criterionId: criterion.id, outcome };
});
