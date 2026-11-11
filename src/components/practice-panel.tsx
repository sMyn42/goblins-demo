"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MultiAssignmentDraft, Question } from "../grading/contracts";
import type { Practice, SubmissionView } from "../grading/ports";
import type { RosterStudent } from "../core/contracts";
import { assignmentSummary, assignmentScoreLabel } from "../grading/summary";
import { AssignmentEditor } from "./assignment-editor";
import { StudentAnswer } from "./student-answer";
import { StudentAssignmentStatus } from "./student-assignment-status";
import { ReviewDeck } from "./review-deck";
import { RubricView, SubmissionActions, SubmissionEvidence, statuses } from "./submission-view";

type Overview = { assignments: Practice[]; gradingContracts: Question[]; submissions: SubmissionView[]; roster: RosterStudent[]; role: "teacher" | "student"; inference?: { ocr: string; grading: string } };
const assignmentURL = (id: string) => `/dashboard?assignment=${encodeURIComponent(id)}`;
const studentURL = (id: string) => `/dashboard?student=${encodeURIComponent(id)}`;
export const reviewURL = (assignment?: string, student?: string) => `/dashboard?${new URLSearchParams({ review: "1", ...(assignment ? { assignment } : {}), ...(student ? { student } : {}) })}`;
async function send(path: string, body?: unknown): Promise<{ revision?: number }> {
  const response = await fetch(path, { method: "POST", ...(body instanceof FormData ? { body } : body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Unable to save. Please retry.");
  return result;
}
function DraftVisibilityControl({ value, busy, update }: { value: boolean; busy: boolean; update: (visible: boolean) => Promise<boolean> }) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  return <label className="checkbox-label visibility-setting"><input type="checkbox" checked={optimistic ?? value} disabled={busy || optimistic !== null} onChange={async (event) => {
    const next = event.target.checked; setOptimistic(next);
    try { await update(next); } finally { setOptimistic(null); }
  }} />Show draft grades to students while awaiting teacher approval</label>;
}
function AssignmentStats({ assignment, submissions, roster }: { assignment: Practice; submissions: SubmissionView[]; roster: RosterStudent[] }) {
  const summaries = roster.map((student) => assignmentSummary(assignment, submissions.filter((item) => item.studentId === student.id)));
  const finalized = summaries.filter((item) => item.finalScore !== null);
  const average = finalized.length ? finalized.reduce((sum, item) => sum + item.finalScore!, 0) / finalized.length : null;
  const collected = summaries.filter((item) => item.submittedCount === item.totalProblems).length;
  const failed = summaries.filter((item) => item.failedCount > 0).length;
  const pending = submissions.filter((item) => item.status === "waiting_for_teacher").length;
  return <p className="field-hint">{collected} / {roster.length} students submitted all problems · {pending} problems awaiting approval · {finalized.length} finalized · {failed} failed{average !== null ? ` · Finalized average: ${average.toFixed(1)}` : ""}{finalized.length ? ` · Highest: ${Math.max(...finalized.map((item) => item.finalScore!))} · Lowest: ${Math.min(...finalized.map((item) => item.finalScore!))}` : ""}</p>;
}
export function PracticePanel({ initial, roster, selectedStudentId, selectedAssignmentId, review = false }: { initial: Overview; roster: RosterStudent[]; selectedStudentId?: string; selectedAssignmentId?: string; review?: boolean }) {
  const [overview, setOverview] = useState(initial);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const response = await fetch("/api/practice", { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to refresh status. Your saved work is not lost.");
    const data = await response.json();
    if (mounted.current) setOverview(data);
  }, []);
  useEffect(() => {
    mounted.current = true; let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await refresh(); } catch { /* Preserve last authoritative state on transient polling failures. */ } finally { if (!stopped) timer = setTimeout(poll, 2000); } };
    timer = setTimeout(poll, 2000); return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, [refresh]);
  const mutate = async (action: () => Promise<unknown>) => { setError(""); setPending(true); try { await action(); await refresh(); return true; } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to save."); return false; } finally { setPending(false); } };
  const { assignments, submissions, role } = overview;
  const teacher = role === "teacher", currentRoster = overview.roster ?? roster;
  const assignment = assignments.find((item) => item.id === selectedAssignmentId);
  const student = teacher ? currentRoster.find((item) => item.id === selectedStudentId) : undefined;
  const act = (path: string, body?: unknown) => { void mutate(() => send(path, body)); };
  const workFor = (item: Practice, studentId?: string) => submissions.filter((submission) => submission.assignmentVersionId === item.id && (!studentId || submission.studentId === studentId));
  const rowAction = (item: Practice, studentId: string) => {
    const work = workFor(item, studentId);
    return <div className="inline-actions">{item.problems.length === 1 && <SubmissionActions item={work[0]} pending={pending} act={act} />}{work.length > 0 && <Link href={reviewURL(item.id, studentId)}>Review problems</Link>}</div>;
  };
  const assignmentList = <section className="panel assignments-box" aria-labelledby="assignments-heading"><div className="panel-topline"><h2 id="assignments-heading">Assignments</h2><span className="field-hint">{assignments.length} published</span></div>
    {assignments.length === 0 ? <p className="muted">No assignment published yet.</p> : <ul className="workspace-list">{assignments.map((item) => {
      const work = workFor(item);
      return <li key={item.id}><h3><Link href={assignmentURL(item.id)}>{item.title}</Link></h3><p className="field-hint">{item.problems.length} problems · {item.maxPoints} points</p>{teacher ? <AssignmentStats assignment={item} submissions={work} roster={currentRoster} /> : <p className="field-hint">{statuses[assignmentSummary(item, work).status]}</p>}</li>;
    })}</ul>}
  </section>;
  const back = <Link className="back-link" href="/dashboard">Back to class</Link>;
  const invalidReview = (selectedAssignmentId && !assignment) || (selectedStudentId && !student);
  return <div className="class-workspace">
    {error && <p className="error-message" role="alert">{error}</p>}
    {teacher && overview.inference && (overview.inference.ocr === "mock" || overview.inference.grading === "mock") && <p className="credential-reminder">Test providers enabled. Results from these providers are simulations, not live grading.</p>}
    {review && teacher ? <>{back}{invalidReview ? <section className="panel"><h2>Review not found in this class</h2></section> : <ReviewDeck items={submissions.filter((item) => (!selectedAssignmentId || item.assignmentVersionId === selectedAssignmentId) && (!selectedStudentId || item.studentId === selectedStudentId))} assignments={assignments} contracts={overview.gradingContracts} request={send} refresh={refresh} />}</> : selectedStudentId ? <>{back}<section className="panel student-detail" aria-label="Student detail">
      {!student ? <h2>Student not found in this class</h2> : <><div className="panel-topline"><h2>{student.displayName}</h2><span className="field-hint">{student.username}</span></div><Link className="button button-small" href={reviewURL(undefined, student.id)}>Review pending answers</Link>
        <h3>Assignment progress</h3><div className="table-scroll"><table><thead><tr><th>Assignment</th><th>Status</th><th>Score</th><th>Action</th></tr></thead><tbody>{assignments.map((item) => {
          const summary = assignmentSummary(item, workFor(item, student.id));
          return <tr key={item.id}><td><Link href={assignmentURL(item.id)}>{item.title}</Link></td><td>{statuses[summary.status]} · {summary.submittedCount}/{summary.totalProblems} problems</td><td>{assignmentScoreLabel(summary)}</td><td>{rowAction(item, student.id)}</td></tr>;
        })}</tbody></table></div>
        {assignments.length === 0 && <p className="muted">No assignments published yet.</p>}
        {submissions.filter((item) => item.studentId === student.id).map((item) => { const entry = assignments.find((record) => record.id === item.assignmentVersionId); const problem = entry?.problems.find((record) => record.id === item.questionVersionId); return <SubmissionEvidence key={item.id} item={item} label={`${entry?.title ?? "Assignment"} · Problem ${(problem?.position ?? 0) + 1}`} />; })}
      </>}
    </section></> : selectedAssignmentId ? <>{back}<section className="panel assignment-detail" aria-label="Assignment detail">
      {!assignment ? <h2>Assignment not found in this class</h2> : <><div className="panel-topline"><h2>{assignment.title}</h2><span className="field-hint">{assignment.problems.length} problems · {assignment.maxPoints} points</span></div>
        {teacher ? <>
          <div className="inline-actions"><Link className="button button-primary" href={reviewURL(assignment.id)}>Review pending answers</Link></div>
          <DraftVisibilityControl value={assignment.showDraftGrades} busy={pending} update={(visible) => mutate(() => send(`/api/assignments/${assignment.id}/settings`, { showDraftGrades: visible }))} />
          <AssignmentStats assignment={assignment} submissions={workFor(assignment)} roster={currentRoster} />
          <div className="table-scroll"><table><thead><tr><th>Student</th><th>Status</th><th>Score</th><th>Action</th></tr></thead><tbody>{currentRoster.map((item) => { const summary = assignmentSummary(assignment, workFor(assignment, item.id)); return <tr key={item.id}><td><Link href={studentURL(item.id)}>{item.displayName}</Link></td><td>{statuses[summary.status]} · {summary.submittedCount}/{summary.totalProblems} problems</td><td>{assignmentScoreLabel(summary)}</td><td>{rowAction(assignment, item.id)}</td></tr>; })}</tbody></table></div>
          {currentRoster.length === 0 && <p className="muted">No students yet. Share the class join code.</p>}
          {assignment.problems.map((problem) => <section key={problem.id} className="published-problem" aria-label={`Problem ${problem.position + 1}`}><h3>Problem {problem.position + 1} · {problem.maxPoints} points</h3><p className="question-prompt">{problem.prompt}</p><RubricView contract={overview.gradingContracts.find((item) => item.id === problem.id)} />{submissions.filter((item) => item.questionVersionId === problem.id).map((item) => <SubmissionEvidence key={item.id} item={item} />)}</section>)}
        </> : <>
          <StudentAssignmentStatus assignment={assignment} work={workFor(assignment)} />
          {assignment.problems.map((problem) => {
            const submission = submissions.find((item) => item.questionVersionId === problem.id);
            return <section key={problem.id} className="published-problem" aria-label={`Problem ${problem.position + 1}`}><div className="panel-topline"><h3>Problem {problem.position + 1} · {problem.maxPoints} points</h3><p className="problem-status" role="status" data-testid="problem-status">{submission ? statuses[submission.status] : "Not submitted"}</p></div><p className="question-prompt">{problem.prompt}</p><StudentAnswer key={problem.id} practice={problem} submission={submission} pending={pending} submit={(body) => mutate(() => send("/api/submissions", body))} /></section>;
          })}
        </>}
      </>}
    </section></> : teacher ? <>
      <p className="workspace-review-link"><Link className="button button-small" href={reviewURL()}>Review pending answers</Link></p>
      <div className="teacher-workspace-grid"><section className="panel students-box" aria-labelledby="students-heading"><div className="panel-topline"><h2 id="students-heading">Students</h2><span className="field-hint">{currentRoster.length} enrolled</span></div>
        {currentRoster.length === 0 ? <p className="muted">No students yet. Share the class join code.</p> : <ul className="workspace-list">{currentRoster.map((item) => {
          const work = submissions.filter((submission) => submission.studentId === item.id);
          const collected = assignments.filter((entry) => { const summary = assignmentSummary(entry, work); return summary.submittedCount === summary.totalProblems; }).length;
          return <li key={item.id}><h3><Link href={studentURL(item.id)}>{item.displayName}</Link></h3><p className="field-hint">{item.username}</p><p className="field-hint">{collected} / {assignments.length} assignments submitted · {work.filter((submission) => submission.status === "waiting_for_teacher").length} problems awaiting approval</p></li>;
        })}</ul>}
      </section><div className="assignments-column">{assignmentList}<section className="panel publish-box" aria-label="Publish assignment"><AssignmentEditor key={editorRevision} pending={pending} publish={async (draft: MultiAssignmentDraft) => { if (await mutate(() => send("/api/practice", draft))) setEditorRevision((value) => value + 1); }} /></section></div></div>
    </> : assignmentList}
  </div>;
}
