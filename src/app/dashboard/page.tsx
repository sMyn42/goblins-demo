import { Effect } from "effect";
import { redirect } from "next/navigation";
import { dashboard } from "../../core/classrooms";
import { sessionToken } from "../../server/session";
import { runtime } from "../../server/runtime";
import { ClassForm } from "../../components/class-form";
import { CopyCode } from "../../components/copy-code";
import { logoutAction } from "../actions";
import { practiceOverview } from "../../grading/application";
import { PracticePanel } from "../../components/practice-panel";

export const dynamic = "force-dynamic";
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ student?: string; assignment?: string; review?: string }> }) {
  const selected = await searchParams;
  const result = await runtime.runPromise(dashboard(await sessionToken()).pipe(Effect.either));
  if (result._tag === "Left") {
    if (result.left._tag === "Unauthenticated") redirect("/login");
    throw new Error("Your class is temporarily unavailable.");
  }
  const { user, classroom, roster } = result.right;
  const teacher = user.role === "teacher";
  const practice = classroom ? await runtime.runPromise(practiceOverview(await sessionToken())) : null;
  return <main id="main" className="workspace">
    <div className="workspace-heading"><div><p className="muted account-role">{teacher ? "Teacher" : "Student"}</p><h1>{user.displayName}</h1></div><form action={logoutAction}><button className="button button-small">Sign out</button></form></div>
    {!classroom ? <section className="panel setup-panel"><h2>{teacher ? "Create class" : "Class not found"}</h2>{teacher ? <ClassForm /> : <p className="muted">Ask your teacher for help.</p>}</section> : <>
      <section className="panel class-panel"><h2>{classroom.name}</h2>{teacher ? <><p className="field-hint">Class join code</p><CopyCode code={classroom.joinCode} /></> : <p className="muted">Class joined successfully.</p>}</section>
      {practice && <PracticePanel initial={practice} roster={roster} selectedStudentId={selected.student} selectedAssignmentId={selected.assignment} review={selected.review === "1"} />}
    </>}
  </main>;
}
