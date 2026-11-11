import { AuthForm } from "../../components/auth-form";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const role = (await searchParams).role === "teacher" ? "teacher" : "student";
  return <main id="main" className="auth-layout"><section className="panel auth-panel" aria-label="Create account"><AuthForm mode="register" role={role} /></section></main>;
}
