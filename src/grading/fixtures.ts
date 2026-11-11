import type { Criterion } from "./contracts";

export const PRACTICE_PROMPT = "Solve x + 3 = 7. Show your work.";
export const COMPLETE_WORK = "x + 3 = 7\nx = 7 - 3\nx = 4";
export const PRACTICE_CRITERIA: readonly (typeof Criterion.Type)[] = [
  { id: "final-answer", description: "Correct final answer", maxPoints: 4, method: "hybrid", fullCredit: "x = 4", partialCredit: "No partial credit on the final answer criterion.", acceptedAlternatives: ["4"], reviewPolicy: "teacher_required", evaluator: { type: "accepted_answers", answers: ["x = 4", "4"] } },
  { id: "working", description: "Show the subtraction step", maxPoints: 6, method: "ai", fullCredit: "Subtract 3 from both sides to get x = 7 - 3, then x = 4.", partialCredit: "3 points for correct setup with an arithmetic error.", acceptedAlternatives: [], reviewPolicy: "teacher_required" },
];
// A finite oracle, not a pretend intelligent grader. Unknown work is explicitly sent to review.
export const GRADING_FIXTURES = [
  { text: COMPLETE_WORK, answer: 4, working: 6, confidence: 1, feedback: "Correct answer and subtraction step." },
  { text: "x = 4", answer: 4, working: 0, confidence: 1, feedback: "Correct final answer. Show the subtraction step." },
  { text: "4", answer: 4, working: 0, confidence: 1, feedback: "Correct final answer. Show the subtraction step." },
  { text: "x + 3 = 7\nx = 7 - 3\nx = 5", answer: 0, working: 3, confidence: 1, feedback: "Correct setup. Check 7 - 3." },
  { text: "x = 5", answer: 0, working: 0, confidence: 1, feedback: "Subtract 3 from both sides and check the result." },
] as const;
