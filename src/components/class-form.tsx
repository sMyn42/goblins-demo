"use client";
import { useActionState } from "react";
import { createClassAction } from "../app/actions";

export function ClassForm() {
  const [state, action, pending] = useActionState(createClassAction, { error: "" });
  return <form action={action} className="form-stack">
    <label>Class name<input name="name" required minLength={1} maxLength={100} /></label>
    <div aria-live="polite">{state.error && <p role="alert" className="error-message">{state.error}</p>}</div>
    <button className="button button-primary" disabled={pending}>{pending ? "Creating…" : "Create class"}</button>
  </form>;
}
