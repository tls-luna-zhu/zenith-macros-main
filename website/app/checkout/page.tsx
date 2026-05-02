"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EmbeddedCheckout } from "@/components/EmbeddedCheckout";
import { apiFetch, readStoredReferral } from "@/lib/api";
import Link from "next/link";

type PlanInfo = { name: string; desc: string; price: string; amount: number; period: string; features: string[] };

const DEFAULT_PLAN_META: Record<string, PlanInfo> = {
  monthly: {
    name: "Monthly Access",
    desc: "Full access to all macros. Cancel anytime.",
    price: "$5",
    amount: 500,
    period: "/mo",
    features: [
      "All macro categories & modules",
      "Dashboard access & license management",
      "License linked to your Discord account",
      "Instant delivery after payment",
      "Cancel anytime from your dashboard",
    ],
  },
  "3month": {
    name: "3-Month Access",
    desc: "Full access for 3 months — one payment.",
    price: "$10",
    amount: 1000,
    period: "/ 3 months",
    features: [
      "All macro categories & modules",
      "Dashboard access & license management",
      "License linked to your Discord account",
      "Instant delivery after payment",
      "90-day access — no recurring charges",
    ],
  },
  lifetime: {
    name: "Lifetime Access",
    desc: "One-time payment — full access, forever.",
    price: "$25",
    amount: 2500,
    period: "one-time",
    features: [
      "All macro categories & modules",
      "Dashboard access & license management",
      "License linked to your Discord account",
      "Instant delivery after payment",
      "Lifetime access — one payment, forever",
    ],
  },
};

function usePlanMeta(): Record<string, PlanInfo> {
  const [meta, setMeta] = useState<Record<string, PlanInfo>>(DEFAULT_PLAN_META);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/pricing")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.ok || !data.plans) return;
        const plans = data.plans as Record<string, { name?: string; desc?: string; price?: string; amount?: number; period?: string }>;
        setMeta((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(plans)) {
            if (next[key]) {
              next[key] = {
                ...next[key],
                ...plans[key],
                features: next[key].features, // keep local features list
              };
            }
          }
          return next;
        });
      })
      .catch(() => {/* keep defaults */});
    return () => { cancelled = true; };
  }, []);

  return meta;
}

const KF = `
  @keyframes fadeIn {
    from { opacity: 0; transform: translateX(-16px); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes fadeInRight {
    from { opacity: 0; transform: translateX(16px); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (max-width: 767px) {
    .checkout-layout { flex-direction: column !important; }
    .checkout-sidebar {
      width: 100% !important;
      position: static !important;
      min-height: auto !important;
      border-right: none !important;
      border-bottom: 1px solid rgba(255,255,255,0.08) !important;
      padding: 32px 20px !important;
    }
    .checkout-main {
      padding: 32px 20px !important;
    }
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
    let lastFrameTime = 0;
    const FRAME_INTERVAL = 33; // ~30fps cap
    const mouse = { x: -9999, y: -9999 };
    const GRID = 52;
    const CONNECT_DIST = GRID * 1.6;
    const CELL_SIZE = CONNECT_DIST; // spatial grid cell size
    type Dot = { x: number; y: number; bx: number; by: number; phase: number; idx: number };
    let DOTS: Dot[] = [];
    let gridCols = 0;
    let gridRows = 0;
    let spatialGrid: Dot[][][] = [];

    function buildSpatialGrid() {
      gridCols = Math.ceil(W / CELL_SIZE) + 1;
      gridRows = Math.ceil(H / CELL_SIZE) + 1;
      spatialGrid = [];
      for (let c = 0; c < gridCols; c++) {
        spatialGrid[c] = [];
        for (let r = 0; r < gridRows; r++) {
          spatialGrid[c][r] = [];
        }
      }
      for (const d of DOTS) {
        const gc = Math.min(Math.max(0, Math.floor(d.x / CELL_SIZE)), gridCols - 1);
        const gr = Math.min(Math.max(0, Math.floor(d.y / CELL_SIZE)), gridRows - 1);
        spatialGrid[gc][gr].push(d);
      }
    }

    function resize() {
      W = canvas!.width = window.innerWidth;
      H = canvas!.height = window.innerHeight;
      DOTS = [];
      let idx = 0;
      for (let x = 0; x < W + GRID; x += GRID)
        for (let y = 0; y < H + GRID; y += GRID)
          DOTS.push({ x, y, bx: x, by: y, phase: Math.random() * Math.PI * 2, idx: idx++ });
    }

    function lerp(a: number, b: number, tt: number) { return a + (b - a) * tt; }

    function frame(ts: number) {
      animId = requestAnimationFrame(frame);
      if (ts - lastFrameTime < FRAME_INTERVAL) return;
      lastFrameTime = ts;
      t = ts * 0.0005;
      ctx!.clearRect(0, 0, W, H);

      const rg = ctx!.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, 420);
      rg.addColorStop(0, "rgba(124,58,237,0.1)");
      rg.addColorStop(1, "transparent");
      ctx!.fillStyle = rg;
      ctx!.fillRect(0, 0, W, H);

      for (const d of DOTS) {
        const dx = mouse.x - d.bx, dy = mouse.y - d.by;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const repel = Math.max(0, 1 - dist / 160);
        d.x = lerp(d.x, d.bx - dx * repel * 0.5 + Math.sin(t + d.phase) * 2, 0.08);
        d.y = lerp(d.y, d.by - dy * repel * 0.5 + Math.cos(t + d.phase * 1.3) * 2, 0.08);
      }

      // Rebuild spatial grid each frame with updated positions
      buildSpatialGrid();

      // Draw connections using spatial grid (only check adjacent cells)
      ctx!.lineWidth = 0.7;
      for (let gc = 0; gc < gridCols; gc++) {
        for (let gr = 0; gr < gridRows; gr++) {
          const cell = spatialGrid[gc][gr];
          // Check this cell and right/below/diagonal neighbors to avoid duplicate pairs
          for (let nc = gc; nc <= Math.min(gc + 1, gridCols - 1); nc++) {
            for (let nr = (nc === gc ? gr : Math.max(0, gr - 1)); nr <= Math.min(gr + 1, gridRows - 1); nr++) {
              const neighbor = spatialGrid[nc][nr];
              const sameCell = nc === gc && nr === gr;
              for (let i = 0; i < cell.length; i++) {
                const a = cell[i];
                const jStart = sameCell ? i + 1 : 0;
                for (let j = jStart; j < neighbor.length; j++) {
                  const b = neighbor[j];
                  const dx = a.x - b.x, dy = a.y - b.y;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  if (dist > CONNECT_DIST) continue;
                  ctx!.beginPath();
                  ctx!.strokeStyle = `rgba(124,58,237,${(1 - dist / CONNECT_DIST) * 0.12})`;
                  ctx!.moveTo(a.x, a.y);
                  ctx!.lineTo(b.x, b.y);
                  ctx!.stroke();
                }
              }
            }
          }
        }
      }

      for (const d of DOTS) {
        const dx = mouse.x - d.x, dy = mouse.y - d.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const glow = Math.max(0, 1 - dist / 200);
        ctx!.beginPath();
        ctx!.arc(d.x, d.y, 0.7 + glow * 1.8, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(${lerp(70, 180, glow)},${lerp(50, 100, glow)},${lerp(170, 240, glow)},${0.2 + glow * 0.5})`;
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
      style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, opacity: 0.65, willChange: "transform" }}
    />
  );
}

function CodeEntryStep({
  plan,
  initialRef,
  onContinue,
  baseCents,
}: {
  plan: "monthly" | "3month" | "lifetime";
  initialRef?: string;
  onContinue: (ref: string, promoId: string, discountCents: number) => void;
  baseCents: number;
}) {
  const [refCode, setRefCode] = useState(initialRef || "");
  const [refLocked, setRefLocked] = useState(false);
  const [couponCode, setCouponCode] = useState("");
  const [refStatus, setRefStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [couponStatus, setCouponStatus] = useState<{ ok: boolean; msg: string; promoId?: string; discountCents?: number } | null>(null);
  const [refChecking, setRefChecking] = useState(false);
  const [couponChecking, setCouponChecking] = useState(false);

  // On mount: read localStorage if no initialRef, then auto-verify and lock the field
  const _autoCheckedRef = useRef(false);
  useEffect(() => {
    const run = async (code: string) => {
      if (!code || _autoCheckedRef.current) return;
      _autoCheckedRef.current = true;
      setRefLocked(true);
      setRefStatus({ ok: true, msg: "Referral code saved automatically." });
    };
    const code = initialRef || readStoredReferral();
    if (code) { setRefCode(code); run(code); }
  }, []);

  async function checkRef() {
    const raw = refCode.trim();
    if (!raw) { setRefStatus({ ok: false, msg: "Enter a referral code first." }); return; }
    setRefChecking(true);
    setRefStatus(null);
    try {
      const r = await apiFetch("/api/validate-code", { method: "POST", body: JSON.stringify({ code: raw, type: "referral" }) });
      const j = await r.json();
      if (j?.ok) {
        setRefStatus({ ok: true, msg: `Referral code "${j.code || raw}" accepted.` });
      } else {
        setRefStatus({ ok: false, msg: j?.error || "Invalid referral code." });
      }
    } catch {
      setRefStatus({ ok: false, msg: "Network error. Try again." });
    } finally {
      setRefChecking(false);
    }
  }

  async function applyCoupon() {
    const raw = couponCode.trim().toUpperCase();
    if (!raw) { setCouponStatus({ ok: false, msg: "Enter a coupon code first." }); return; }
    setCouponChecking(true);
    setCouponStatus(null);
    try {
      const r = await apiFetch("/api/validate-code", { method: "POST", body: JSON.stringify({ code: raw, type: "coupon" }) });
      const j = await r.json();
      if (j?.ok) {
        const disc = j.discount || {};
        let saved = 0;
        const BASE = baseCents;
        if (disc.type === "percent") saved = Math.round(BASE * disc.percent / 100);
        else if (disc.type === "amount") saved = disc.amount_off;
        const discLabel = disc.type === "percent" ? `${disc.percent}% off` : disc.type === "amount" ? `$${(disc.amount_off / 100).toFixed(2)} off` : "Discount applied";
        setCouponStatus({ ok: true, msg: `Coupon applied — ${discLabel}`, promoId: j.promo_id, discountCents: saved });
      } else {
        setCouponStatus({ ok: false, msg: j?.error || "Invalid coupon code." });
      }
    } catch {
      setCouponStatus({ ok: false, msg: "Network error. Try again." });
    } finally {
      setCouponChecking(false);
    }
  }

  function handleContinue() {
    // Pass ref if it was verified (auto or manual); never silently drop a pre-filled code
    const ref = refStatus?.ok ? refCode.trim().toLowerCase() : refStatus === null && refCode.trim() ? refCode.trim().toLowerCase() : "";
    const promoId = couponStatus?.ok ? couponStatus.promoId || "" : "";
    const discountCents = couponStatus?.ok ? couponStatus.discountCents || 0 : 0;
    onContinue(ref, promoId, discountCents);
  }

  const BASE_CENTS = baseCents;
  const discountCents = couponStatus?.ok ? couponStatus.discountCents || 0 : 0;
  const finalCents = Math.max(50, BASE_CENTS - discountCents);

  const codeBtnBase: React.CSSProperties = {
    padding: "10px 16px", borderRadius: 10,
    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
    color: "rgba(240,240,245,0.55)", fontSize: 12, fontWeight: 600,
    cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap",
    fontFamily: "inherit",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Referral code */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(240,240,245,0.28)" }}>
          Referral code
        </div>
        <div style={{ fontSize: 12, color: "rgba(240,240,245,0.28)", marginTop: -2 }}>
          {refLocked ? "Applied from referral link" : "Enter a friend\u2019s referral code if you have one"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{
            flex: 1, display: "flex", alignItems: "center", gap: 8,
            background: refLocked ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)",
            border: refLocked ? "1px solid rgba(34,197,94,0.25)" : "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10, padding: "10px 14px", transition: "border-color 0.2s",
            opacity: refLocked ? 0.7 : 1,
          }}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" width={14} height={14} style={{ color: refLocked ? "#86efac" : "rgba(240,240,245,0.28)", flexShrink: 0 }}>
              {refLocked
                ? <path d="M2 7l3 3 7-6" />
                : <path d="M7 1l1.8 3.6L13 5.3l-3 2.9.7 4.1L7 10.4 3.3 12.3l.7-4.1-3-2.9 4.2-.6z" />}
            </svg>
            <input
              type="text"
              value={refCode}
              onChange={refLocked ? undefined : (e) => { setRefCode(e.target.value); setRefStatus(null); }}
              readOnly={refLocked}
              placeholder="e.g. zen123abc"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={refLocked ? undefined : (e) => e.key === "Enter" && checkRef()}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: refLocked ? "rgba(240,240,245,0.45)" : "#f0f0f5",
                fontSize: 13, fontWeight: 500, letterSpacing: "0.05em", minWidth: 0,
                cursor: refLocked ? "default" : "text",
              }}
            />
          </div>
          {!refLocked && (
            <button
              type="button"
              onClick={checkRef}
              disabled={refChecking}
              style={{
                ...codeBtnBase,
                ...(refStatus?.ok ? { color: "#86efac", borderColor: "rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.06)", pointerEvents: "none" } : {}),
                ...(refStatus && !refStatus.ok ? { color: "#fca5a5", borderColor: "rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)" } : {}),
              }}
            >
              {refChecking ? "Checking…" : refStatus?.ok ? "✓ Applied" : "Check"}
            </button>
          )}
        </div>
        {refStatus && (
          <div style={{ fontSize: 11, color: refStatus.ok ? "#86efac" : "#fca5a5", lineHeight: 1.5 }}>
            {refStatus.msg}
          </div>
        )}
      </div>

      {/* Coupon code */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(240,240,245,0.28)" }}>
          Coupon code
        </div>
        <div style={{ fontSize: 12, color: "rgba(240,240,245,0.28)", marginTop: -2 }}>
          Enter a Stripe coupon code for a discount
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{
            flex: 1, display: "flex", alignItems: "center", gap: 8,
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 10, padding: "10px 14px", transition: "border-color 0.2s",
          }}>
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" width={14} height={14} style={{ color: "rgba(240,240,245,0.28)", flexShrink: 0 }}>
              <rect x="1" y="4" width="12" height="6" rx="1.5" />
              <path d="M5 4V3a2 2 0 0 1 4 0v1" />
              <circle cx="7" cy="7" r="1" />
            </svg>
            <input
              type="text"
              value={couponCode}
              onChange={(e) => { setCouponCode(e.target.value); setCouponStatus(null); }}
              placeholder="e.g. SAVE10"
              maxLength={32}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && applyCoupon()}
              style={{
                flex: 1, background: "none", border: "none", outline: "none",
                color: "#f0f0f5", fontSize: 13, fontWeight: 500, letterSpacing: "0.05em", minWidth: 0,
              }}
            />
          </div>
          <button
            type="button"
            onClick={applyCoupon}
            disabled={couponChecking}
            style={{
              ...codeBtnBase,
              ...(couponStatus?.ok ? { color: "#86efac", borderColor: "rgba(34,197,94,0.3)", background: "rgba(34,197,94,0.06)", pointerEvents: "none" } : {}),
              ...(couponStatus && !couponStatus.ok ? { color: "#fca5a5", borderColor: "rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)" } : {}),
            }}
          >
            {couponChecking ? "Checking…" : couponStatus?.ok ? "✓ Applied" : "Apply"}
          </button>
        </div>
        {couponStatus && (
          <div style={{ fontSize: 11, color: couponStatus.ok ? "#86efac" : "#fca5a5", lineHeight: 1.5 }}>
            {couponStatus.msg}
          </div>
        )}
      </div>

      {/* Price preview */}
      <div style={{
        padding: "12px 16px", borderRadius: 12,
        background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ fontSize: 13, color: "rgba(240,240,245,0.55)" }}>
          {discountCents > 0 ? (
            <>
              <span style={{ textDecoration: "line-through", marginRight: 6, opacity: 0.5 }}>
                ${(BASE_CENTS / 100).toFixed(2)}
              </span>
              <span style={{ color: "#86efac", fontSize: 11, fontWeight: 600 }}>
                −${(discountCents / 100).toFixed(2)} off
              </span>
            </>
          ) : "Amount due"}
        </div>
        <span style={{ fontSize: 18, fontWeight: 800, color: "#f0f0f5" }}>
          ${(finalCents / 100).toFixed(2)} USD
        </span>
      </div>

      {/* Continue button */}
      <button
        type="button"
        onClick={handleContinue}
        style={{
          width: "100%", padding: 14, borderRadius: 12,
          background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
          color: "#fff", fontSize: 15, fontWeight: 700,
          border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          boxShadow: "0 4px 20px rgba(124,58,237,0.3)", fontFamily: "inherit",
          transition: "opacity 0.2s, transform 0.15s, box-shadow 0.2s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.92"; e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 8px 28px rgba(124,58,237,0.4)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 4px 20px rgba(124,58,237,0.3)"; }}
      >
        <svg width={15} height={15} viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 7.5h9M8 3l4 4.5-4 4.5" />
        </svg>
        Continue to payment
      </button>

      <div style={{ textAlign: "center", fontSize: 11, color: "rgba(240,240,245,0.28)" }}>
        You can skip codes and continue directly
      </div>
    </div>
  );
}

function CheckoutInner({ plan, initialRef, planMeta }: { plan: "monthly" | "3month" | "lifetime"; initialRef?: string; planMeta: Record<string, PlanInfo> }) {
  const [step, setStep] = useState<"codes" | "payment">("codes");
  const [payRef, setPayRef] = useState(initialRef || "");
  const [payPromoId, setPayPromoId] = useState("");
  const [appliedDiscountCents, setAppliedDiscountCents] = useState(0);

  const meta = planMeta[plan];
  const finalCents = Math.max(50, meta.amount - appliedDiscountCents);
  const displayPrice = appliedDiscountCents > 0
    ? `$${(finalCents / 100).toFixed(2)}`
    : meta.price;

  function handleContinue(ref: string, promoId: string, discountCents: number) {
    setPayRef(ref);
    setPayPromoId(promoId);
    setAppliedDiscountCents(discountCents);
    setStep("payment");
  }

  return (
    <div className="checkout-layout" style={{
      display: "flex",
      alignItems: "flex-start",
      minHeight: "calc(100vh - 64px)",
    }}>
      {/* Left panel */}
      <aside className="checkout-sidebar" style={{
        width: 400, flexShrink: 0,
        padding: "52px 44px",
        borderRight: "1px solid rgba(255,255,255,0.08)",
        display: "flex", flexDirection: "column", gap: 26,
        opacity: 0, transform: "translateX(-16px)",
        animation: "fadeIn 0.5s ease forwards 0.1s",
        position: "sticky", top: 64, minHeight: "calc(100vh - 64px)",
      }}>
        {/* Secure badge */}
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "4px 10px", borderRadius: 20,
          fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
          background: "rgba(124,58,237,0.1)", border: "1px solid rgba(124,58,237,0.25)", color: "#c4b5fd",
          width: "fit-content",
        }}>
          <svg viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" width={11} height={11}>
            <path d="M5.5 1L2 2.8v3.5C2 8.2 3.5 9.8 5.5 10.2 7.5 9.8 9 8.2 9 6.3V2.8z" />
          </svg>
          Secure checkout
        </div>

        {/* Plan card */}
        <div style={{
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 16, padding: 24,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(240,240,245,0.28)", marginBottom: 8 }}>
            You&apos;re purchasing
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.4px", color: "#f0f0f5", marginBottom: 4 }}>
            {meta.name}
          </div>
          <div style={{ fontSize: 13, color: "rgba(240,240,245,0.55)", lineHeight: 1.5 }}>
            {meta.desc}
          </div>
          <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.08)", margin: "16px 0" }} />
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              {appliedDiscountCents > 0 && (
                <span style={{ fontSize: 20, fontWeight: 600, color: "rgba(240,240,245,0.28)", textDecoration: "line-through" }}>{meta.price}</span>
              )}
              <span style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-1px", color: appliedDiscountCents > 0 ? "#86efac" : "#f0f0f5" }}>{displayPrice}</span>
            </div>
            <span style={{ fontSize: 13, color: "rgba(240,240,245,0.28)" }}>{meta.period}</span>
          </div>
        </div>

        {/* What's included */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(240,240,245,0.28)", marginBottom: 10 }}>
            What&apos;s included
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {meta.features.map((f) => (
              <li key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "rgba(240,240,245,0.55)" }}>
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" width={14} height={14} style={{ color: "#7c3aed", flexShrink: 0 }}>
                  <path d="M2 7l3 3 7-6" />
                </svg>
                {f}
              </li>
            ))}
          </ul>
        </div>

        {/* Trust items */}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {[
            { icon: <><rect x="2" y="5" width="9" height="7" rx="1.5" /><path d="M4.5 5V3.5a2 2 0 0 1 4 0V5" /></>, text: "256-bit TLS encryption" },
            { icon: <><circle cx="6.5" cy="6.5" r="5" /><path d="M4.5 6.5l1.5 1.5 3-3" /></>, text: "PCI DSS compliant via Stripe" },
            { icon: <path d="M6.5 1L8.1 4.2 11.7 4.8 9.1 7.3 9.7 11 6.5 9.3 3.3 11 3.9 7.3 1.3 4.8 4.9 4.2z" />, text: "Instant license delivery" },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "rgba(240,240,245,0.28)" }}>
              <svg viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" width={13} height={13}>
                {item.icon}
              </svg>
              {item.text}
            </div>
          ))}
        </div>
      </aside>

      {/* Right panel */}
      <main className="checkout-main" style={{
        flex: 1, padding: "52px 44px",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        opacity: 0, transform: "translateX(16px)",
        animation: "fadeInRight 0.5s ease forwards 0.2s",
      }}>
        <div style={{ width: "100%", maxWidth: 480 }}>
          {step === "codes" ? (
            <CodeEntryStep plan={plan} initialRef={initialRef} onContinue={handleContinue} baseCents={meta.amount} />
          ) : (
            <EmbeddedCheckout plan={plan} initialRef={payRef} initialPromoId={payPromoId} initialDiscountCents={appliedDiscountCents} noCodeField />
          )}
        </div>
      </main>
    </div>
  );
}

function CheckoutPageContent() {
  const searchParams = useSearchParams();
  const rawPlan = searchParams.get("plan") || "monthly";
  const plan = (["monthly", "3month", "lifetime"] as const).includes(rawPlan as "monthly" | "3month" | "lifetime") ? (rawPlan as "monthly" | "3month" | "lifetime") : "monthly";
  const initialRef = searchParams.get("ref") || "";
  const planMeta = usePlanMeta();

  return (
    <>
      <style>{KF}</style>
      <CanvasBg />

      {/* body bg */}
      <div style={{ position: "fixed", inset: 0, background: "#080810", zIndex: -1 }} />

      {/* Nav */}
      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 10,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 32px",
        background: "rgba(8,8,16,0.85)", backdropFilter: "blur(14px)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        height: 64,
      }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#f0f0f5", fontWeight: 700, fontSize: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-transparent.png" alt="Zenith" style={{ width: 28, height: 28, borderRadius: 6 }} />
          Zenith Macros
        </a>
        <Link
          href={`/selectpayment?plan=${plan}`}
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
          Back to payment
        </Link>
      </nav>

      {/* Layout */}
      <div style={{ position: "relative", zIndex: 1, paddingTop: 64 }}>
        <CheckoutInner plan={plan} initialRef={initialRef} planMeta={planMeta} />
      </div>
    </>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense fallback={null}>
      <CheckoutPageContent />
    </Suspense>
  );
}
