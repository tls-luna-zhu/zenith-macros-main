"use client";

import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { CursorBg } from "@/components/CursorBg";

function SuccessInner() {
  const sp = useSearchParams();
  const sid = sp.get("session_id");
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!sid) {
      setState("ok");
      setMsg("Payment received. Your license will be linked to your account within moments.");
      return;
    }
    (async () => {
      const r = await apiFetch(`/api/checkout/verify-session?session_id=${encodeURIComponent(sid)}`);
      const j = await r.json();
      if (j.ok) {
        setState("ok");
        setMsg("Payment confirmed. Your license is now linked to your dashboard.");
      } else {
        setState("error");
        setMsg(j.error || "Could not verify session — contact support if you were charged.");
      }
    })();
  }, [sid]);

  return (
    <>
      <CursorBg />

      <div style={{
        position: "relative", zIndex: 1,
        minHeight: "100vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        padding: "2rem",
      }}>
        <div style={{
          width: "100%", maxWidth: 480,
          background: "rgba(14,12,22,0.9)",
          border: `1px solid ${state === "error" ? "rgba(248,113,113,0.3)" : "rgba(124,58,237,0.3)"}`,
          borderRadius: 24,
          backdropFilter: "blur(32px)",
          WebkitBackdropFilter: "blur(32px)",
          overflow: "hidden",
          textAlign: "center",
        }}>
          {/* Top accent bar */}
          <div style={{
            height: 4,
            background: state === "error"
              ? "linear-gradient(90deg, #ef4444, #f87171)"
              : state === "loading"
              ? "rgba(124,58,237,0.3)"
              : "linear-gradient(90deg, #7c3aed, #a855f7, #c084fc)",
          }} />

          <div style={{ padding: "3rem 2.5rem" }}>
            {/* Icon */}
            <div style={{ marginBottom: "1.75rem" }}>
              {state === "loading" ? (
                <div style={{
                  width: 72, height: 72, margin: "0 auto",
                  borderRadius: "50%",
                  border: "3px solid rgba(124,58,237,0.2)",
                  borderTop: "3px solid #a855f7",
                  animation: "spin 0.8s linear infinite",
                }} />
              ) : state === "ok" ? (
                <div style={{
                  width: 72, height: 72, margin: "0 auto",
                  borderRadius: "50%",
                  background: "rgba(124,58,237,0.12)",
                  border: "2px solid rgba(124,58,237,0.4)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  animation: "popIn 0.4s cubic-bezier(.2,.8,.2,1.4)",
                }}>
                  <svg viewBox="0 0 28 28" fill="none" width={32} height={32}>
                    <path d="M6 14l5 5 11-11" stroke="#a855f7" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              ) : (
                <div style={{
                  width: 72, height: 72, margin: "0 auto",
                  borderRadius: "50%",
                  background: "rgba(248,113,113,0.08)",
                  border: "2px solid rgba(248,113,113,0.35)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <svg viewBox="0 0 28 28" fill="none" width={28} height={28}>
                    <path d="M8 8l12 12M20 8L8 20" stroke="#f87171" strokeWidth={2} strokeLinecap="round" />
                  </svg>
                </div>
              )}
            </div>

            {/* Text */}
            <h1 style={{
              fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em",
              margin: "0 0 0.75rem",
            }}>
              {state === "loading" ? "Confirming…" : state === "ok" ? "You're all set." : "Something went wrong"}
            </h1>

            <p style={{
              fontSize: 14.5, color: "rgba(243,243,247,0.55)",
              lineHeight: 1.65, margin: "0 0 2rem",
            }}>
              {state === "loading" ? "Verifying your payment…" : msg}
            </p>

            {state === "ok" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Link href="/dashboard.html" style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  padding: "13px",
                  borderRadius: 12,
                  background: "linear-gradient(135deg, #7c3aed, #9333ea)",
                  color: "#fff", fontWeight: 700, fontSize: 14.5,
                  textDecoration: "none",
                  boxShadow: "0 4px 24px rgba(124,58,237,0.4)",
                }}>
                  Go to Dashboard
                  <svg viewBox="0 0 20 20" fill="none" width={15} height={15}>
                    <path d="M4 10h12M10 4l6 6-6 6" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>

                <Link href="/" style={{
                  display: "block",
                  padding: "11px",
                  borderRadius: 12,
                  border: "1px solid rgba(124,58,237,0.2)",
                  color: "rgba(243,243,247,0.45)",
                  fontSize: 13.5, textDecoration: "none",
                  textAlign: "center",
                }}>
                  Back to site
                </Link>
              </div>
            )}

            {state === "error" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <a href="https://discord.gg/tbT5Zjg7dE" target="_blank" rel="noopener noreferrer" style={{
                  display: "block",
                  padding: "12px",
                  borderRadius: 12,
                  background: "#5865F2",
                  color: "#fff", fontWeight: 700, fontSize: 14,
                  textDecoration: "none", textAlign: "center",
                }}>
                  Open Discord Support
                </a>
                <Link href="/selectpayment" style={{
                  display: "block", padding: "11px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "rgba(243,243,247,0.45)",
                  fontSize: 13, textDecoration: "none", textAlign: "center",
                }}>
                  Return to payment options
                </Link>
              </div>
            )}
          </div>
        </div>

        {state === "ok" && (
          <p style={{ marginTop: "1.5rem", fontSize: 12.5, color: "rgba(243,243,247,0.25)", textAlign: "center" }}>
            Your license is linked to your Discord account and visible in the dashboard.
          </p>
        )}
      </div>
    </>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", color: "rgba(243,243,247,0.4)" }}>
        Loading…
      </div>
    }>
      <SuccessInner />
    </Suspense>
  );
}
