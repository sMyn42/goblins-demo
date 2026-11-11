import type { Practice, SubmissionView } from "../grading/ports";
import { assignmentSummary, assignmentScoreLabel } from "../grading/summary";
import { statuses } from "./submission-view";

export function StudentAssignmentStatus({ assignment, work }: { assignment: Practice; work: SubmissionView[] }) {
  // These DTOs have already had hidden draft grades redacted server-side.
  const summary = assignmentSummary(assignment, work);
  return <section className="student-assignment-status" aria-label="Assignment status">
    <p role="status" data-testid="assignment-status"><strong>Assignment: {statuses[summary.status]}</strong> · {summary.submittedCount} / {summary.totalProblems} problems submitted</p>
    {summary.failedCount > 0 && <p className="field-error">{summary.failedCount} problem{summary.failedCount === 1 ? " has" : "s have"} a processing failure. This is not a zero grade.</p>}
    {summary.finalScore !== null ? <p className="assignment-total" data-testid="assignment-final-total">Assignment total: {assignmentScoreLabel(summary)}</p>
      : summary.draftScore !== null ? <p className="assignment-total" data-testid="assignment-draft-total">Provisional assignment total: {summary.draftScore} / {summary.maxPoints} · Draft — awaiting teacher approval</p>
      : summary.visibleGradeCount > 0 ? <p className="field-hint" data-testid="assignment-partial-total">{summary.visibleGradeCount === summary.approvedCount ? "Approved" : "Provisional"} points so far: {summary.visibleScore} / {summary.maxPoints} · {summary.visibleGradeCount} / {summary.totalProblems} grades available. Remaining grades are pending.</p>
      : <p className="field-hint">Total grade pending{summary.allSubmitted ? " grading or teacher approval" : " submission of all problems"}.</p>}
  </section>;
}
