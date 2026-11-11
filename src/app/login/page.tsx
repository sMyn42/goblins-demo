import { AuthForm } from "../../components/auth-form";

export default function LoginPage() {
  return <main id="main" className="auth-layout"><section className="panel auth-panel" aria-label="Sign in"><AuthForm mode="login" /></section></main>;
}
