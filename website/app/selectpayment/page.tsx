"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { readStoredReferral } from "@/lib/api";

const PLAN_META: Record<string, { name: string; desc: string; price: string; period: string; badge: string }> = {
  monthly: {
    name: "Monthly Access",
    desc: "Full access to all macros and modules. Cancel anytime.",
    price: "$5",
    period: "per month",
    badge: "monthly",
  },
  "3month": {
    name: "3-Month Access",
    desc: "Full access for 3 months. One-time payment.",
    price: "$10",
    period: "3 months",
    badge: "3-month",
  },
  lifetime: {
    name: "Lifetime Access",
    desc: "One-time payment. Never pay again — full access forever.",
    price: "$25",
    period: "one-time",
    badge: "lifetime",
  },
};

const KF = `
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes modalIn {
    from { opacity: 0; transform: scale(0.94) translateY(12px); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;

function CanvasBg() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = 0, H = 0;
    let animId = 0;
    let t = 0;
    const mouse = { x: -9999, y: -9999 };
    const GRID = 52;
    type Dot = { x: number; y: number; bx: number; by: number; phase: number };
    let DOTS: Dot[] = [];

    function resize() {
      W = canvas!.width = window.innerWidth;
      H = canvas!.height = window.innerHeight;
      DOTS = [];
      for (let x = 0; x < W + GRID; x += GRID)
        for (let y = 0; y < H + GRID; y += GRID)
          DOTS.push({ x, y, bx: x, by: y, phase: Math.random() * Math.PI * 2 });
    }

    function lerp(a: number, b: number, tt: number) { return a + (b - a) * tt; }

    function frame(ts: number) {
      animId = requestAnimationFrame(frame);
      t = ts * 0.0005;
      ctx!.clearRect(0, 0, W, H);

      const rg = ctx!.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 450);
      rg.addColorStop(0, "rgba(124,58,237,0.12)");
      rg.addColorStop(1, "transparent");
      ctx!.fillStyle = rg;
      ctx!.fillRect(0, 0, W, H);

      for (const d of DOTS) {
        const dx = mouse.x - d.bx, dy = mouse.y - d.by;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const repel = Math.max(0, 1 - dist / 180);
        const tx = d.bx - dx * repel * 0.55 + Math.sin(t + d.phase) * 2.5;
        const ty = d.by - dy * repel * 0.55 + Math.cos(t + d.phase * 1.3) * 2.5;
        d.x = lerp(d.x, tx, 0.08);
        d.y = lerp(d.y, ty, 0.08);
      }

      ctx!.beginPath();
      for (let i = 0; i < DOTS.length; i++) {
        const a = DOTS[i];
        for (let j = i + 1; j < DOTS.length; j++) {
          const b = DOTS[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > GRID * 1.6) continue;
          const alpha = (1 - dist / (GRID * 1.6)) * 0.15;
          ctx!.strokeStyle = `rgba(124,58,237,${alpha})`;
          ctx!.lineWidth = 0.7;
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
        }
      }
      ctx!.stroke();

      for (const d of DOTS) {
        const dx = mouse.x - d.x, dy = mouse.y - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const glow = Math.max(0, 1 - dist / 200);
        const r = 0.8 + glow * 2;
        ctx!.beginPath();
        ctx!.arc(d.x, d.y, r, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(${lerp(80, 200, glow)},${lerp(60, 120, glow)},${lerp(180, 253, glow)},${0.25 + glow * 0.55})`;
        ctx!.fill();
      }
    }

    function onMouseMove(e: MouseEvent) { mouse.x = e.clientX; mouse.y = e.clientY; }

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouseMove);
    animId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, opacity: 0.85 }}
    />
  );
}

function SelectPaymentContent() {
  const searchParams = useSearchParams();
  const rawPlan = searchParams.get("plan") || "monthly";
  const plan = ["monthly", "3month", "lifetime"].includes(rawPlan) ? rawPlan : "monthly";
  const urlRef = searchParams.get("ref") || "";

  // Merge URL ref with sessionStorage — URL wins if present, else fall back to stored ref
  const [ref, setRef] = useState(urlRef);
  useEffect(() => {
    if (!ref) {
      const s = readStoredReferral(); if (s) setRef(s);
    }
  }, []);

  const meta = PLAN_META[plan] || PLAN_META.monthly;

  // Auth gate
  useEffect(() => {
    fetch("/api/dashboard/me", { credentials: "include" })
      .then((r) => {
        if (r.status === 401) {
          const next = `/selectpayment?plan=${plan}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
          window.location.href = "/auth/discord/start?next=" + encodeURIComponent(next);
        }
      })
      .catch(() => {});
  }, [plan]);

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMethod, setModalMethod] = useState<"paypal" | "crypto" | null>(null);

  function handleStripe() {
    // Always read sessionStorage at click time as final fallback
    let activeRef = ref;
    if (!activeRef) { activeRef = readStoredReferral(); }
    let url = `/checkout?plan=${encodeURIComponent(plan)}`;
    if (activeRef) url += `&ref=${encodeURIComponent(activeRef)}`;
    window.location.href = url;
  }

  function openModal(method: "paypal" | "crypto") {
    setModalMethod(method);
    setModalOpen(true);
  }

  function closeModal() { setModalOpen(false); }

  const modalLabel = modalMethod === "paypal" ? "PayPal" : "Cryptocurrency";

  return (
    <>
      <style>{KF}</style>
      <CanvasBg />

      {/* Nav */}
      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 10,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 32px",
        background: "rgba(8,8,16,0.75)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#f0f0f5", fontWeight: 700, fontSize: 16, letterSpacing: "-0.3px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-transparent.png" alt="Zenith" style={{ width: 28, height: 28, borderRadius: 6 }} />
          Zenith Macros
        </a>
        <a
          href="/#pricing"
          style={{
            display: "flex", alignItems: "center", gap: 6,
            textDecoration: "none", color: "rgba(240,240,245,0.55)",
            fontSize: 13, fontWeight: 500,
            padding: "6px 12px", borderRadius: 8,
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(255,255,255,0.04)",
            transition: "color 0.2s, border-color 0.2s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#f0f0f5"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(240,240,245,0.55)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width={14} height={14}>
            <path d="M10 12L6 8l4-4" />
          </svg>
          Back to pricing
        </a>
      </nav>

      {/* Page */}
      <main style={{
        position: "relative", zIndex: 1, minHeight: "100vh",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        padding: "40px 20px",
      }}>
        <div style={{
          width: "100%", maxWidth: 520,
          opacity: 0, transform: "translateY(24px)",
          animation: "fadeUp 0.5s ease forwards 0.1s",
        }}>

          {/* Plan summary */}
          <div style={{
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 16, padding: 24, marginBottom: 20,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(240,240,245,0.28)", marginBottom: 6 }}>
                Selected plan
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.5px", color: "#f0f0f5" }}>
                {meta.name}
              </div>
              <div style={{ fontSize: 13, color: "rgba(240,240,245,0.55)", marginTop: 4 }}>
                {meta.desc}
              </div>
              <span style={{
                display: "inline-block",
                padding: "3px 10px", borderRadius: 20,
                fontSize: 11, fontWeight: 600,
                textTransform: "uppercase", letterSpacing: "0.05em",
                marginTop: 8,
                ...(meta.badge === "monthly"
                  ? { background: "rgba(59,130,246,0.15)", color: "#93c5fd", border: "1px solid rgba(59,130,246,0.25)" }
                  : meta.badge === "3-month"
                  ? { background: "rgba(16,185,129,0.15)", color: "#6ee7b7", border: "1px solid rgba(16,185,129,0.25)" }
                  : { background: "rgba(124,58,237,0.15)", color: "#c4b5fd", border: "1px solid rgba(124,58,237,0.25)" }),
              }}>
                {meta.badge}
              </span>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-1px", color: "#f0f0f5" }}>{meta.price}</div>
              <div style={{ fontSize: 12, color: "rgba(240,240,245,0.28)", marginTop: 2 }}>{meta.period}</div>
            </div>
          </div>

          {/* Section label */}
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(240,240,245,0.28)", marginBottom: 12 }}>
            Choose a payment method
          </div>

          {/* Payment buttons */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Stripe */}
            <button
              onClick={handleStripe}
              style={{
                display: "flex", alignItems: "center", gap: 16,
                width: "100%", padding: "18px 20px",
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 14, cursor: "pointer", textAlign: "left",
                color: "#f0f0f5", transition: "all 0.2s ease", position: "relative", overflow: "hidden",
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = "rgba(124,58,237,0.5)";
                el.style.transform = "translateY(-1px)";
                el.style.boxShadow = "0 0 24px rgba(99,91,255,0.2)";
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = "rgba(255,255,255,0.08)";
                el.style.transform = "none";
                el.style.boxShadow = "none";
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logos/stripe.png" alt="Stripe" style={{ width: 48, height: 32, objectFit: "contain", flexShrink: 0, filter: "brightness(1.1)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Credit / Debit Card</div>
                <div style={{ fontSize: 12, color: "rgba(240,240,245,0.55)", marginTop: 2 }}>Powered by Stripe — secure, instant</div>
              </div>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width={16} height={16} style={{ color: "rgba(240,240,245,0.28)", flexShrink: 0, transition: "transform 0.2s" }}>
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>

            {/* PayPal */}
            <button
              onClick={() => openModal("paypal")}
              style={{
                display: "flex", alignItems: "center", gap: 16,
                width: "100%", padding: "18px 20px",
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 14, cursor: "pointer", textAlign: "left",
                color: "#f0f0f5", transition: "all 0.2s ease", position: "relative", overflow: "hidden",
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = "rgba(124,58,237,0.5)";
                el.style.transform = "translateY(-1px)";
                el.style.boxShadow = "0 0 24px rgba(0,112,192,0.2)";
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = "rgba(255,255,255,0.08)";
                el.style.transform = "none";
                el.style.boxShadow = "none";
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logos/paypal.png" alt="PayPal" style={{ width: 48, height: 32, objectFit: "contain", flexShrink: 0, filter: "brightness(1.1)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>PayPal</div>
                <div style={{ fontSize: 12, color: "rgba(240,240,245,0.55)", marginTop: 2 }}>Pay with your PayPal balance or card</div>
              </div>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width={16} height={16} style={{ color: "rgba(240,240,245,0.28)", flexShrink: 0 }}>
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>

            {/* Crypto */}
            <button
              onClick={() => openModal("crypto")}
              style={{
                display: "flex", alignItems: "center", gap: 16,
                width: "100%", padding: "18px 20px",
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 14, cursor: "pointer", textAlign: "left",
                color: "#f0f0f5", transition: "all 0.2s ease", position: "relative", overflow: "hidden",
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = "rgba(124,58,237,0.5)";
                el.style.transform = "translateY(-1px)";
                el.style.boxShadow = "0 0 24px rgba(247,147,26,0.2)";
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = "rgba(255,255,255,0.08)";
                el.style.transform = "none";
                el.style.boxShadow = "none";
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logos/crypto.png" alt="Crypto" style={{ width: 48, height: 32, objectFit: "contain", flexShrink: 0, filter: "brightness(1.1)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Cryptocurrency</div>
                <div style={{ fontSize: 12, color: "rgba(240,240,245,0.55)", marginTop: 2 }}>Bitcoin, Ethereum, and more</div>
              </div>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width={16} height={16} style={{ color: "rgba(240,240,245,0.28)", flexShrink: 0 }}>
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>
          </div>

          {/* Footer note */}
          <p style={{ marginTop: 20, textAlign: "center", fontSize: 12, color: "rgba(240,240,245,0.28)", lineHeight: 1.6 }}>
            All payments are secure and processed through trusted providers.<br />
            By purchasing you agree to our{" "}
            <a href="/terms.html" style={{ color: "rgba(240,240,245,0.55)", textDecoration: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#f0f0f5")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(240,240,245,0.55)")}>
              Terms of Service
            </a>{" "}and{" "}
            <a href="/refund.html" style={{ color: "rgba(240,240,245,0.55)", textDecoration: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#f0f0f5")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(240,240,245,0.55)")}>
              Refund Policy
            </a>.
          </p>
        </div>
      </main>

      {/* Modal overlay */}
      {modalOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(0,0,0,0.65)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          }}
        >
          <div style={{
            background: "#0f0f1c", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 20, padding: "36px 32px",
            maxWidth: 440, width: "100%", position: "relative",
            boxShadow: "0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,58,237,0.15)",
            animation: "modalIn 0.25s cubic-bezier(0.34,1.3,0.64,1) forwards",
          }}>
            <div style={{
              width: 52, height: 52, borderRadius: 14,
              background: "rgba(124,58,237,0.12)", border: "1px solid rgba(124,58,237,0.25)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 20px",
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width={24} height={24} style={{ color: "#a855f7" }}>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.3px", color: "#f0f0f5", textAlign: "center", marginBottom: 10 }}>
              Pay with {modalLabel}
            </div>
            <div style={{ fontSize: 14, color: "rgba(240,240,245,0.55)", textAlign: "center", lineHeight: 1.65, marginBottom: 24 }}>
              To pay via <strong style={{ color: "#f0f0f5" }}>{modalLabel}</strong>, open a support ticket in our Discord server. A team member will send you a payment link and set up your license manually.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <a
                href="https://discord.gg/zenithmacros"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  padding: "13px 20px", borderRadius: 12,
                  background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
                  color: "#fff", fontSize: 14, fontWeight: 600,
                  textDecoration: "none",
                  boxShadow: "0 4px 16px rgba(124,58,237,0.35)",
                  transition: "opacity 0.2s, transform 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.9"; e.currentTarget.style.transform = "translateY(-1px)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "none"; }}
              >
                <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.033.057a19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
                </svg>
                Open Discord ticket
              </a>
              <button
                onClick={closeModal}
                style={{
                  padding: "11px 20px", borderRadius: 12,
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                  color: "rgba(240,240,245,0.55)", fontSize: 14, fontWeight: 500,
                  cursor: "pointer", textAlign: "center", transition: "all 0.2s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "#f0f0f5"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(240,240,245,0.55)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; }}
              >
                Go back
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function SelectPayment() {
  return (
    <Suspense fallback={null}>
      <SelectPaymentContent />
    </Suspense>
  );
}
