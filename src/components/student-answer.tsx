"use client";
import { useId, useRef, useState } from "react";
import type { PracticeProblem, SubmissionView } from "../grading/ports";
import { AnswerCanvas, type CanvasHandle } from "./answer-canvas";
import { Grade } from "./submission-view";

export function StudentAnswer({ practice, submission, pending, submit }: { practice: PracticeProblem; submission: SubmissionView | undefined; pending: boolean; submit: (body: unknown) => Promise<boolean> }) {
  const fieldId = useId();
  const [format, setFormat] = useState<"typed" | "image">("typed");
  const [text, setText] = useState("");
  const [drawn, setDrawn] = useState(false);
  const canvas = useRef<CanvasHandle>(null);
  const key = useRef<string | null>(null);
  const [localError, setLocalError] = useState("");
  if (submission) return <div className="student-result">{submission.failureCode && <p className="field-error">Processing failed. This is not a zero grade. Ask your teacher to retry.</p>}
    {submission.source.type === "typed" ? <pre className="answer-text">{submission.source.text}</pre> : <a href={`/api/submissions/${submission.id}/image`} target="_blank" rel="noreferrer">View your original work</a>}
    {submission.finalGrade ? <Grade value={submission.finalGrade} final /> : submission.draftGrade ? <Grade value={submission.draftGrade} final={false} /> : submission.status === "waiting_for_teacher" ? <p className="field-hint">Your grade will appear after teacher approval.</p> : null}
  </div>;
  return <form className="form-stack" onSubmit={async (event) => {
    event.preventDefault(); setLocalError("");
    key.current ??= crypto.randomUUID();
    if (format === "typed") { await submit({ questionId: practice.id, idempotencyKey: key.current, text }); return; }
    if (!canvas.current || !drawn) { setLocalError("Write an answer first."); return; }
    try {
      const form = new FormData(); form.set("questionId", practice.id); form.set("idempotencyKey", key.current); form.set("image", await canvas.current.image(), "answer.png");
      await submit(form);
    } catch { setLocalError("Unable to save the drawing. Your work has not been cleared; please retry."); }
  }}>
    <div className="inline-actions" role="group" aria-label="Answer format"><button type="button" className={`button button-small ${format === "typed" ? "button-primary" : ""}`} onClick={() => setFormat("typed")}>Type answer</button><button type="button" className={`button button-small ${format === "image" ? "button-primary" : ""}`} onClick={() => setFormat("image")}>Write answer</button></div>
    <div hidden={format !== "typed"} className="field-group"><label htmlFor={`${fieldId}-work`}>Your work</label><textarea id={`${fieldId}-work`} rows={6} maxLength={10000} required={format === "typed"} value={text} onChange={(event) => setText(event.target.value)} /></div>
    <div hidden={format !== "image"}><AnswerCanvas ref={canvas} onDraw={setDrawn} /></div>
    <p className="credential-reminder">One attempt per problem. Your original work is saved before processing. Grades remain provisional until your teacher approves them.</p>
    {localError && <p className="error-message" role="alert">{localError}</p>}
    <button className="button button-primary" disabled={pending || (format === "image" && !drawn)}>{pending ? "Saving…" : "Submit answer"}</button>
  </form>;
}
