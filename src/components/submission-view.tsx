"use client";
import type { GradeResult, Question } from "../grading/contracts";
import type { SubmissionView } from "../grading/ports";

export const statuses: Record<string, string> = { not_submitted: "Not submitted", in_progress: "In progress", submitted: "Submitted", processing: "Processing", auto_grading: "Auto-grading", waiting_for_teacher: "Waiting for teacher", finalized: "Finalized", retryable_failure: "Retrying after a processing failure", permanent_failure: "Processing failed — teacher can retry" };
export const scoreLabel = (item: SubmissionView | undefined, maximum: number) => item?.finalGrade ? `${item.finalGrade.totalScore} / ${maximum} final` : item?.draftGrade ? `${item.draftGrade.totalScore} / ${maximum} draft` : "—";
export function Grade({ value, final, evidence = false }: { value: GradeResult; final: boolean; evidence?: boolean }) {
  return <div className="grade-result" data-testid={final ? "final-grade" : "draft-grade"}><strong>{final ? "Teacher-approved final grade" : "Draft — awaiting teacher approval"}: {value.totalScore} points</strong>
    <p>{value.feedback}</p>{evidence && <p className="field-hint">Confidence: {Math.round(value.confidence * 100)}% · Review: {value.reviewReason}</p>}<p className="field-hint">{value.provider === "mock" ? "Mock fixture result, not live AI grading." : `Provider: ${value.provider} · ${value.model}`}</p>
  </div>;
}
export function SubmissionActions({ item, pending, act }: { item: SubmissionView | undefined; pending: boolean; act: (path: string, body?: unknown) => void }) {
  return <>{item?.status === "waiting_for_teacher" && item.draftGrade && <button className="button button-small" disabled={pending} onClick={() => act(`/api/submissions/${item.id}/approve`, { revision: item.reviewRevision })}>Approve and release</button>}
    {item?.status === "permanent_failure" && <button className="button button-small" disabled={pending} onClick={() => act(`/api/submissions/${item.id}/retry`)}>Retry grading</button>}</>;
}
export function RubricView({ contract }: { contract: Question | undefined }) {
  if (!contract) return null;
  return <details className="submission-details"><summary>Published rubric and teacher solution</summary><p>Expected answers: {contract.expectedAnswers.join("; ")}</p><pre className="answer-text">{contract.teacherSolution}</pre><ul>{contract.criteria.map((criterion) => <li key={criterion.id}><strong>{criterion.description}: {criterion.maxPoints} points</strong><p>{criterion.fullCredit}</p><p className="field-hint">Partial credit: {criterion.partialCredit || "None specified"} · {criterion.method}</p></li>)}</ul></details>;
}
export function SubmissionEvidence({ item, label = item.studentName }: { item: SubmissionView; label?: string }) {
  return <details className="submission-details"><summary>{label} — answer and evidence</summary><p role="status">{statuses[item.status]}</p>
    {item.source.type === "typed" ? <pre className="answer-text">{item.source.text}</pre> : <a href={`/api/submissions/${item.id}/image`} target="_blank" rel="noreferrer">View original handwritten work</a>}
    {item.failureCode && <p className="field-error">Processing failure: {item.failureCode}. No grade was assigned.</p>}
    {item.extractedAnswer && <><h3>OCR lines</h3><ol start={0}>{item.extractedAnswer.lines.map((line) => <li key={line.index}>{line.text || "[blank line]"}</li>)}</ol><p className="field-hint">{item.extractedAnswer.ocrProvider} · {item.extractedAnswer.ocrModel}</p></>}
    {(item.finalGrade ?? item.draftGrade) && <Grade value={(item.finalGrade ?? item.draftGrade)!} final={Boolean(item.finalGrade)} evidence />}
    {item.draftGrade && <ul>{item.draftGrade.criterionResults.map((criterion) => <li key={criterion.criterionId}>{criterion.criterionId}: {criterion.score} points — {criterion.explanation} <span className="field-hint">Lines: {criterion.evidenceLineIndices.join(", ") || "none"}</span></li>)}</ul>}
  </details>;
}
