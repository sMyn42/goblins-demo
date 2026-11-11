"use client";
import { useState } from "react";
import { formatJoinCode } from "../core/join-codes";

export function CopyCode({ code }: { code: string }) {
  const [status, setStatus] = useState("");
  const formattedCode = formatJoinCode(code);
  return <div className="join-code-box"><code>{formattedCode}</code><button type="button" className="button button-small" onClick={async () => {
    try { await navigator.clipboard.writeText(formattedCode); setStatus("Copied"); } catch { setStatus("Select and copy the code."); }
  }}>Copy code</button><span className="field-hint" aria-live="polite">{status}</span></div>;
}
