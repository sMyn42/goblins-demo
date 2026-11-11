"use client";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main id="main" className="workspace"><section className="panel setup-panel"><h1>Unable to load</h1><p className="muted">The service is temporarily unavailable.</p><button className="button button-primary" onClick={reset}>Try again</button></section></main>;
}
