"use client";
import { useId, useRef, useState } from "react";
import type { MultiAssignmentDraft, ProblemDraft, Question } from "../grading/contracts";
import { COMPLETE_WORK, PRACTICE_CRITERIA, PRACTICE_PROMPT } from "../grading/fixtures";

type EditorProblem = Omit<ProblemDraft, "approved"> & { clientId: string; approved: boolean; open: boolean };
const createProblem = (seed: boolean): EditorProblem => ({
  clientId: crypto.randomUUID(), prompt: seed ? PRACTICE_PROMPT : "", expectedAnswers: seed ? ["x = 4", "4"] : [], teacherSolution: seed ? COMPLETE_WORK : "", gradingInstructions: "", maxPoints: 10,
  criteria: PRACTICE_CRITERIA.map((criterion) => ({ ...criterion, fullCredit: seed ? criterion.fullCredit : criterion.id === "final-answer" ? "Matches an accepted answer." : "Valid reasoning with sufficient work.", acceptedAlternatives: seed ? [...criterion.acceptedAlternatives] : [], ...(criterion.evaluator ? { evaluator: { ...criterion.evaluator, answers: seed ? [...criterion.evaluator.answers] : [] } } : {}) })),
  approved: false, open: true,
});
function ProblemEditor({ problem, index, update, remove, moveUp, removable }: { problem: EditorProblem; index: number; update: (patch: Partial<EditorProblem>, content?: boolean) => void; remove: () => void; moveUp: () => void; removable: boolean }) {
  const fieldId = useId();
  const fields = useRef<HTMLFieldSetElement>(null);
  const [error, setError] = useState("");
  const sum = problem.criteria.reduce((total, criterion) => total + criterion.maxPoints, 0);
  const criterionUpdate = (n: number, patch: Partial<Question["criteria"][number]>) => update({ criteria: problem.criteria.map((criterion, i) => i === n ? { ...criterion, ...patch } : criterion) });
  return <details className="problem-editor" open={problem.open} onToggle={(event) => { if (event.currentTarget.open !== problem.open) update({ open: event.currentTarget.open }, false); }}>
    <summary>Problem {index + 1} · {problem.approved ? "Rubric approved" : "Needs rubric approval"}<span className="field-hint">{problem.maxPoints} points</span></summary>
    <fieldset ref={fields} disabled={problem.approved} className="problem-fields form-stack">
      <div className="field-group"><label htmlFor={`${fieldId}-question`}>Question</label><textarea id={`${fieldId}-question`} value={problem.prompt} onChange={(e) => update({ prompt: e.target.value })} required maxLength={5000} rows={2} /></div>
      <div className="field-group"><label htmlFor={`${fieldId}-answers`}>Expected answers, one per line</label><textarea id={`${fieldId}-answers`} value={problem.expectedAnswers.join("\n")} onChange={(e) => update({ expectedAnswers: e.target.value.split("\n"), criteria: problem.criteria.map((criterion) => criterion.evaluator ? { ...criterion, evaluator: { ...criterion.evaluator, answers: [...e.target.value.split("\n").map((text) => text.trim()).filter(Boolean), ...criterion.acceptedAlternatives.filter(Boolean)] } } : criterion) })} required rows={2} /></div>
      <div className="field-group"><label htmlFor={`${fieldId}-solution`}>Teacher solution</label><textarea id={`${fieldId}-solution`} value={problem.teacherSolution} onChange={(e) => update({ teacherSolution: e.target.value })} required maxLength={10000} rows={3} /></div>
      <div className="field-group"><label htmlFor={`${fieldId}-instructions`}>Grading instructions</label><textarea id={`${fieldId}-instructions`} value={problem.gradingInstructions ?? ""} onChange={(e) => update({ gradingInstructions: e.target.value })} maxLength={5000} rows={2} /></div>
      <label>Maximum points<input type="number" value={problem.maxPoints} onChange={(e) => update({ maxPoints: Number(e.target.value) })} min={1} max={1000} required /></label>
      <h3>Rubric</h3>
      {problem.criteria.map((criterion, n) => <fieldset key={criterion.id} className="criterion-editor"><legend>Criterion {n + 1}</legend>
        <label>Description<input value={criterion.description} required onChange={(e) => criterionUpdate(n, { description: e.target.value })} /></label>
        <label>Points<input type="number" min={0.5} step={0.5} max={1000} required value={criterion.maxPoints} onChange={(e) => criterionUpdate(n, { maxPoints: Number(e.target.value) })} /></label>
        <label>Full-credit condition<input value={criterion.fullCredit} required onChange={(e) => criterionUpdate(n, { fullCredit: e.target.value })} /></label>
        <label>Partial-credit condition<input value={criterion.partialCredit} onChange={(e) => criterionUpdate(n, { partialCredit: e.target.value })} /></label>
        <div className="field-group"><label htmlFor={`${fieldId}-alternatives-${n}`}>Accepted alternatives, one per line</label><textarea id={`${fieldId}-alternatives-${n}`} rows={2} value={criterion.acceptedAlternatives.join("\n")} onChange={(e) => criterionUpdate(n, { acceptedAlternatives: e.target.value.split("\n"), ...(criterion.evaluator ? { evaluator: { ...criterion.evaluator, answers: [...problem.expectedAnswers.filter(Boolean), ...e.target.value.split("\n").filter(Boolean)] } } : {}) })} /></div>
        <label>Evaluation<select value={criterion.method} onChange={(e) => {
          const method = e.target.value as "ai" | "hybrid" | "deterministic";
          criterionUpdate(n, { method, evaluator: method === "ai" ? undefined : { type: "accepted_answers", answers: [...problem.expectedAnswers.filter(Boolean), ...criterion.acceptedAlternatives.filter(Boolean)] } });
        }}><option value="ai">AI judgment</option><option value="hybrid">Hybrid: accepted answer and AI</option><option value="deterministic">Accepted answer check</option></select></label>
        <div className="inline-actions"><button type="button" className="button button-small" disabled={n === 0} onClick={() => { const items = [...problem.criteria]; [items[n - 1], items[n]] = [items[n], items[n - 1]]; update({ criteria: items }); }}>Move up</button><button type="button" className="button button-small" disabled={problem.criteria.length === 1} onClick={() => update({ criteria: problem.criteria.filter((_, i) => i !== n) })}>Remove criterion</button></div>
      </fieldset>)}
      <button type="button" className="button button-small" disabled={problem.criteria.length >= 20} onClick={() => update({ criteria: [...problem.criteria, { id: crypto.randomUUID(), description: "", maxPoints: 1, method: "ai", fullCredit: "", partialCredit: "", acceptedAlternatives: [], reviewPolicy: "teacher_required" }] })}>Add criterion</button>
      <p className={sum === problem.maxPoints ? "field-hint" : "field-hint field-error"}>Rubric total: {sum} / {problem.maxPoints}</p>
    </fieldset>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="inline-actions problem-actions">
      {problem.approved ? <button type="button" className="button button-small" onClick={() => { setError(""); update({ approved: false, open: true }, false); }}>Edit problem {index + 1}</button> : <button type="button" className="button button-primary" disabled={sum !== problem.maxPoints} onClick={() => {
        const inputs = fields.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
        if (inputs && [...inputs].some((input) => !input.reportValidity())) return;
        if (!problem.prompt.trim() || !problem.teacherSolution.trim() || !problem.expectedAnswers.some((text) => text.trim()) || problem.criteria.some((criterion) => !criterion.description.trim() || !criterion.fullCredit.trim())) { setError("Complete the question, expected answers, solution and rubric first."); return; }
        setError(""); update({ approved: true, open: false }, false);
      }}>Approve rubric for problem {index + 1}</button>}
      <button type="button" className="button button-small" disabled={index === 0} onClick={moveUp}>Move problem up</button>
      <button type="button" className="button button-small" disabled={!removable} onClick={remove}>Remove problem</button>
    </div>
  </details>;
}
export function AssignmentEditor({ publish, pending }: { publish: (draft: MultiAssignmentDraft) => Promise<void>; pending: boolean }) {
  const publicationKey = useRef<string | null>(null);
  const [title, setTitle] = useState("Algebra practice");
  const [problems, setProblems] = useState<EditorProblem[]>(() => [createProblem(true)]);
  const [showDraftGrades, setShowDraftGrades] = useState(false);
  const approved = problems.every((problem) => problem.approved);
  return <form className="form-stack assignment-editor" onSubmit={async (event) => {
    event.preventDefault(); if (!approved) return;
    publicationKey.current ??= crypto.randomUUID();
    await publish({ publicationKey: publicationKey.current, title, showDraftGrades, problems: problems.map((problem) => ({ prompt: problem.prompt, expectedAnswers: problem.expectedAnswers.map((text) => text.trim()).filter(Boolean), teacherSolution: problem.teacherSolution, gradingInstructions: problem.gradingInstructions ?? "", maxPoints: problem.maxPoints, criteria: problem.criteria, approved: true })) });
  }}>
    <h2>Publish an assignment</h2>
    <p className="field-hint">Approve each problem’s rubric before publishing. Approved problems collapse; editing requires re-approval. Published definitions cannot be edited.</p>
    <label>Assignment title<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} /></label>
    {problems.map((problem, index) => <ProblemEditor key={problem.clientId} problem={problem} index={index} removable={problems.length > 1} update={(patch, content = true) => setProblems((items) => items.map((item) => item.clientId === problem.clientId ? { ...item, ...patch, ...(content ? { approved: false } : {}) } : item))} remove={() => setProblems((items) => items.filter((item) => item.clientId !== problem.clientId))} moveUp={() => setProblems((items) => { const moved = [...items]; [moved[index - 1], moved[index]] = [moved[index], moved[index - 1]]; return moved; })} />)}
    <button type="button" className="button" disabled={pending || problems.length >= 30} onClick={() => setProblems([...problems, createProblem(false)])}>Add problem</button>
    <p className="field-hint">{problems.length} problems · {problems.reduce((sum, problem) => sum + problem.maxPoints, 0)} total points · {problems.filter((problem) => problem.approved).length} rubrics approved</p>
    <label className="checkbox-label"><input type="checkbox" checked={showDraftGrades} onChange={(e) => setShowDraftGrades(e.target.checked)} />Show draft grades to students while awaiting teacher approval</label>
    <button className="button button-primary" disabled={pending || !approved}>{pending ? "Publishing…" : "Publish assignment"}</button>
  </form>;
}
