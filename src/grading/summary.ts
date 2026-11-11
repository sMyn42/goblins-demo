import type { Practice, SubmissionView } from "./ports";
export function assignmentSummary(assignment: Practice, work: readonly SubmissionView[]) {
  const items = assignment.problems.map((problem) => work.find((item) => item.questionVersionId === problem.id));
  const submittedCount = items.filter(Boolean).length;
  const allFinal = items.length > 0 && items.every((item) => item?.status === "finalized" && item.finalGrade);
  const allGraded = items.length > 0 && items.every((item) => item?.finalGrade || item?.draftGrade);
  const finalScore = allFinal ? items.reduce((sum, item) => sum + item!.finalGrade!.totalScore, 0) : null;
  const draftScore = allGraded ? items.reduce((sum, item) => sum + (item!.finalGrade ?? item!.draftGrade)!.totalScore, 0) : null;
  const states = items.flatMap((item) => item ? [item.status] : []);
  const allSubmitted = items.length > 0 && submittedCount === items.length;
  const status = allFinal ? "finalized" : submittedCount === 0 ? "not_submitted" : !allSubmitted ? "in_progress" : states.includes("permanent_failure") ? "permanent_failure" : states.includes("retryable_failure") ? "retryable_failure" : states.includes("auto_grading") ? "auto_grading" : states.includes("processing") ? "processing" : states.includes("submitted") ? "submitted" : "waiting_for_teacher";
  const visible = items.filter((item) => item?.finalGrade || item?.draftGrade);
  const approved = items.filter((item) => item?.finalGrade);
  return { status, allSubmitted, submittedCount, totalProblems: items.length, finalScore, draftScore, maxPoints: assignment.maxPoints,
    visibleGradeCount: visible.length, approvedCount: approved.length,
    visibleScore: visible.reduce((sum, item) => sum + (item!.finalGrade ?? item!.draftGrade)!.totalScore, 0),
    approvedScore: approved.reduce((sum, item) => sum + item!.finalGrade!.totalScore, 0),
    failedCount: states.filter((state) => ["permanent_failure", "retryable_failure"].includes(state)).length,
  };
}
export function assignmentScoreLabel(summary: ReturnType<typeof assignmentSummary>) {
  return summary.finalScore !== null ? `${summary.finalScore} / ${summary.maxPoints} final` : summary.draftScore !== null ? `${summary.draftScore} / ${summary.maxPoints} draft` : "—";
}
