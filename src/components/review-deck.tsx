"use client";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { Practice, SubmissionView } from "../grading/ports";
import type { Question } from "../grading/contracts";
import { Grade, statuses } from "./submission-view";

type Request = (path: string, body?: unknown) => Promise<{ revision?: number }>;
function ReviewCard({ item, assignment, contract, request, refresh, onDirty }: { item: SubmissionView; assignment: Practice; contract: Question | undefined; request: Request; refresh: () => Promise<void>; onDirty: (value: boolean) => void }) {
  const grade = item.draftGrade;
  const [scores, setScores] = useState<Record<string, number>>(() => Object.fromEntries(grade?.criterionResults.map((criterion) => [criterion.criterionId, criterion.score]) ?? []));
  const [feedback, setFeedback] = useState(grade?.feedback ?? "");
  const [reason, setReason] = useState("");
  const [revision, setRevision] = useState(item.reviewRevision);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [highlight, setHighlight] = useState<readonly number[]>([]);
  const lineRefs = useRef<Record<number, HTMLLIElement | null>>({});
  const stale = revision !== item.reviewRevision;
  const editable = item.status === "waiting_for_teacher" && Boolean(grade && contract);
  const valid = contract?.criteria.every((criterion) => Number.isFinite(scores[criterion.id]) && scores[criterion.id] >= 0 && scores[criterion.id] <= criterion.maxPoints) ?? false;
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to save review."); } finally { setBusy(false); } };
  const reload = () => { setScores(Object.fromEntries(grade?.criterionResults.map((criterion) => [criterion.criterionId, criterion.score]) ?? [])); setFeedback(grade?.feedback ?? ""); setRevision(item.reviewRevision); setDirty(false); onDirty(false); setReason(""); setError(""); };
  const problem = assignment.problems.find((entry) => entry.id === item.questionVersionId);
  return <article className="review-card" aria-label="Answer review">
    <div className="panel-topline"><h2>{item.studentName}</h2><span className="field-hint">{statuses[item.status]}</span></div>
    <h3>{assignment.title} · Problem {(problem?.position ?? 0) + 1}</h3><p className="question-prompt">{problem?.prompt}</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {stale && <p className="error-message" role="alert">This grade changed in another review. Your unsaved entries are retained. <button type="button" className="button button-small" onClick={reload}>Reload current grade</button></p>}
    <div className="review-evidence-grid"><section aria-label="Original answer"><h3>Original answer</h3>
      {item.source.type === "typed" ? <pre className="answer-text">{item.source.text}</pre> : <><a href={`/api/submissions/${item.id}/image`} target="_blank" rel="noreferrer"><Image unoptimized src={`/api/submissions/${item.id}/image`} width={1000} height={500} alt={`Original handwritten work from ${item.studentName}`} className="original-work" /></a><p className="field-hint">Select the image to open the original.</p></>}
      <h3>OCR lines</h3>{item.extractedAnswer ? <><ol start={0} className="ocr-lines">{item.extractedAnswer.lines.map((line) => <li key={line.index} ref={(node) => { lineRefs.current[line.index] = node; }} className={highlight.includes(line.index) ? "evidence-highlight" : ""}>{line.text || "[blank line]"}{line.confidence !== undefined && <span className="field-hint"> · {Math.round(line.confidence * 100)}%</span>}</li>)}</ol><p className="field-hint">{item.extractedAnswer.ocrProvider} · {item.extractedAnswer.ocrModel}</p></> : <p className="muted">OCR has not completed.</p>}
      {grade && <p className="field-hint">AI confidence: {Math.round((item.originalGrade ?? grade).confidence * 100)}% · {grade.reviewReason}{grade.misconception ? ` · Misconception: ${grade.misconception}` : ""}</p>}
      {item.failureCode && <p className="field-error">Processing failure: {item.failureCode}. No score is available to approve.</p>}
    </section><section aria-label="Rubric review">
      <form className="form-stack" onSubmit={(event) => { event.preventDefault(); if (!editable || !valid || stale || !dirty) return; void action(async () => {
        const saved = await request(`/api/submissions/${item.id}/review`, { revision, feedback, reason, scores: contract!.criteria.map((criterion) => ({ criterionId: criterion.id, score: scores[criterion.id] })) });
        if (typeof saved.revision !== "number") throw new Error("Unable to verify saved revision. Reload before approving.");
        setRevision(saved.revision); setDirty(false); onDirty(false); setReason(""); await refresh();
      }); }} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
        <fieldset className="review-scores form-stack">
          <h3>Rubric criteria</h3>
          {contract?.criteria.map((criterion) => { const result = grade?.criterionResults.find((entry) => entry.criterionId === criterion.id); return <div key={criterion.id} className="criterion-review">
            {grade ? <label>{criterion.description}<input disabled={!editable || busy} aria-label={`Score: ${criterion.description}`} type="number" min={0} max={criterion.maxPoints} step={0.5} required value={scores[criterion.id] ?? 0} onChange={(event) => { setScores({ ...scores, [criterion.id]: Number(event.target.value) }); setDirty(true); onDirty(true); }} /></label> : <p>{criterion.description}: not graded</p>}<p className="field-hint">Out of {criterion.maxPoints} · {criterion.fullCredit}</p><p className="field-hint">Partial credit: {criterion.partialCredit || "None specified"}</p>
            <p>AI explanation: {result?.explanation}</p>{result?.acceptedAlternative && <p className="field-hint">Accepted alternative: {result.acceptedAlternative}</p>}
            {result && <div className="inline-actions">{result.evidenceLineIndices.map((index) => <button key={index} type="button" className="evidence-link" onClick={() => { setHighlight(result.evidenceLineIndices); lineRefs.current[index]?.scrollIntoView({ block: "nearest" }); }}>Line {index}</button>)}</div>}
          </div>; })}
          {grade && <><div className="field-group"><label htmlFor={`feedback-${item.id}`}>Student feedback</label><textarea id={`feedback-${item.id}`} disabled={!editable || busy} rows={4} required maxLength={10000} value={feedback} onChange={(event) => { setFeedback(event.target.value); setDirty(true); onDirty(true); }} /></div><label>Reason for correction<input disabled={!editable || busy} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} required={dirty} /></label></>}
        </fieldset>
        {grade && <p><strong>Total: {Object.values(scores).reduce((sum, score) => sum + score, 0)} / {problem?.maxPoints ?? contract?.maxPoints}</strong></p>}
        {editable && <div className="inline-actions"><button className="button" disabled={!dirty || !valid || !reason.trim() || !feedback.trim() || stale || busy}>Save correction</button><button type="button" className="button button-primary" disabled={dirty || stale || busy} onClick={() => void action(async () => { await request(`/api/submissions/${item.id}/approve`, { revision }); await refresh(); })}>Approve and release</button></div>}
        {dirty && <><p className="field-hint">Save your correction before approving or navigating. The original AI grade is preserved.</p><button type="button" className="button button-small" onClick={reload}>Discard unsaved changes</button></>}
      </form>
      {item.status === "permanent_failure" && <button className="button" disabled={busy} onClick={() => void action(async () => { await request(`/api/submissions/${item.id}/retry`); await refresh(); })}>Retry grading</button>}
      {item.finalGrade && <Grade value={item.finalGrade} final />}
    </section></div>
    {item.originalGrade && <details className="submission-details"><summary>Original AI grade</summary><Grade value={item.originalGrade} final={false} evidence /></details>}
    <details className="submission-details"><summary>Override history ({item.overrideHistory.length})</summary>{item.overrideHistory.length === 0 ? <p className="muted">No teacher corrections.</p> : <ol>{item.overrideHistory.map((entry) => <li key={entry.id}><strong>Revision {entry.revision} · {entry.teacherName}</strong><p className="field-hint">{new Date(entry.createdAt).toISOString()}</p><p>{entry.previousResult.totalScore} → {entry.result.totalScore} points · {entry.reason}</p><ul>{entry.result.criterionResults.filter((result) => entry.previousResult.criterionResults.find((previous) => previous.criterionId === result.criterionId)?.score !== result.score).map((result) => <li key={result.criterionId}>{contract?.criteria.find((criterion) => criterion.id === result.criterionId)?.description ?? result.criterionId}: {entry.previousResult.criterionResults.find((previous) => previous.criterionId === result.criterionId)?.score} → {result.score}</li>)}</ul><p>Previous feedback: {entry.previousResult.feedback}</p><p>Updated feedback: {entry.result.feedback}</p></li>)}</ol>}</details>
  </article>;
}
export function ReviewDeck({ items, assignments, contracts, request, refresh }: { items: SubmissionView[]; assignments: Practice[]; contracts: Question[]; request: Request; refresh: () => Promise<void> }) {
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirtyId, setDirtyId] = useState<string | null>(null);
  const cards = items.filter((item) => all || ["waiting_for_teacher", "permanent_failure", "retryable_failure"].includes(item.status)).sort((a, b) => {
    const priority = (item: SubmissionView) => item.failureCode ? 0 : (item.originalGrade?.confidence ?? 0) < 0.8 ? 1 : item.originalGrade?.totalScore !== assignments.flatMap((entry) => entry.problems).find((problem) => problem.id === item.questionVersionId)?.maxPoints ? 2 : 3;
    return priority(a) - priority(b) || a.id.localeCompare(b.id);
  });
  const index = Math.max(0, cards.findIndex((item) => item.id === selected));
  const current = cards[index];
  const blocked = Boolean(current && dirtyId === current.id);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (blocked || target?.closest("input, textarea, select, [contenteditable=true]") || event.ctrlKey || event.metaKey || event.altKey) return;
      const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : -1;
      if (next >= 0 && next < cards.length) { event.preventDefault(); setSelected(cards[next].id); }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, [cards, index, blocked]);
  const assignment = current && assignments.find((entry) => entry.id === current.assignmentVersionId);
  return <section className="panel review-deck" aria-label="Review deck"><div className="panel-topline"><h2>Review answers</h2><label className="review-filter">View <select aria-label="Review filter" disabled={blocked} value={all ? "all" : "pending"} onChange={(event) => { setAll(event.target.value === "all"); setSelected(null); }}><option value="pending">Awaiting approval / failed</option><option value="all">All answers</option></select></label></div>
    <div className="inline-actions"><button className="button button-small" disabled={blocked || index <= 0} onClick={() => setSelected(cards[index - 1].id)}>Previous</button><span className="field-hint" role="status">{cards.length ? `${index + 1} of ${cards.length}` : "No answers awaiting approval"}</span><button className="button button-small" disabled={blocked || index >= cards.length - 1} onClick={() => setSelected(cards[index + 1].id)}>Next</button></div>
    <p className="field-hint">Left/right arrows navigate outside fields. Ctrl/Cmd+Enter saves corrections. Each problem requires explicit teacher approval.</p>
    {current && assignment && <ReviewCard key={current.id} item={current} assignment={assignment} contract={contracts.find((entry) => entry.id === current.questionVersionId)} request={request} refresh={refresh} onDirty={(value) => setDirtyId(value ? current.id : null)} />}
  </section>;
}
