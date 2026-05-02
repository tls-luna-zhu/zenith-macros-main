"use client";

import {
  EmbeddedCheckout as StripeEmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, API_BASE, readStoredReferral, writeStoredReferral } from "@/lib/api";

type Plan = "monthly" | "3month" | "lifetime";

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid rgba(124,58,237,0.25)",
  background: "rgba(7,7,9,0.7)",
  color: "#f3f3f7",
  fontSize: 13.5,
  outline: "none",
  fontFamily: "inherit",
};

const btnStyle: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "1px solid rgba(124,58,237,0.35)",
  background: "rgba(124,58,237,0.12)",
  color: "#c4b5fd",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
  fontFamily: "inherit",
};

export function EmbeddedCheckout({ plan, initialRef, initialPromoId, initialDiscountCents, noCodeField }: { plan: Plan; initialRef?: string; initialPromoId?: string; initialDiscountCents?: number; noCodeField?: boolean }) {
  const BASE_CENTS = plan === "monthly" ? 500 : plan === "3month" ? 1000 : 2500;

  const [code, setCode] = useState("");
  const [appliedRef, setAppliedRef] = useState("");
  const [appliedPromoId, setAppliedPromoId] = useState("");
  const [discountCents, setDiscountCents] = useState(initialDiscountCents || 0);
  const [codeMsg, setCodeMsg] = useState("");
  const [codeMsgOk, setCodeMsgOk] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [pk, setPk] = useState<string | null>(null);
  const [stripeErr, setStripeErr] = useState("");
  const [needLogin, setNeedLogin] = useState(false);
  const [loading, setLoading] = useState(true);

  const createSession = useCallback(async (ref: string, promoId: string) => {
    setStripeErr("");
    setNeedLogin(false);
    setLoading(true);
    setClientSecret(null);

    const body: Record<string, string> = { plan };
    if (ref) body.ref = ref;
    if (promoId) body.promo_id = promoId;

    const r = await apiFetch("/api/checkout-session", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const j = await r.json();

    if (r.status === 401 || j?.error === "unauthorized") {
      setNeedLogin(true);
      setLoading(false);
      return;
    }
    if (!r.ok || !j?.ok || !j?.client_secret) {
      setStripeErr(j?.error || "Could not start checkout");
      setLoading(false);
      return;
    }

    const cfgR = await apiFetch("/api/stripe-config");
    const cfg = await cfgR.json();
    if (!cfgR.ok || !cfg?.publishable_key) {
      setStripeErr("Stripe configuration missing");
      setLoading(false);
      return;
    }

    setPk(cfg.publishable_key);
    setClientSecret(j.client_secret);
    setLoading(false);
  }, [plan]);

  // initial load: pick up ref from prop or localStorage
  useEffect(() => {
    const stored = initialRef || readStoredReferral();
    if (stored) {
      setCode(stored);
      setAppliedRef(stored);
      writeStoredReferral(stored);
    }
    if (initialPromoId) {
      setAppliedPromoId(initialPromoId);
    }
    void createSession(stored, initialPromoId || "");
  }, [plan, initialRef, initialPromoId, createSession]);

  const stripePromise = useMemo(() => pk ? loadStripe(pk) : null, [pk]);

  async function applyCode() {
    const raw = code.trim();
    if (!raw) return;

    // Try coupon first (Stripe promo code)
    const couponR = await apiFetch("/api/validate-code", {
      method: "POST",
      body: JSON.stringify({ code: raw, type: "coupon" }),
    });
    const couponJ = await couponR.json();

    if (couponJ?.ok && couponJ.type === "stripe_coupon") {
      const disc = couponJ.discount || {};
      let saved = 0;
      if (disc.type === "percent") saved = Math.round(BASE_CENTS * disc.percent / 100);
      else if (disc.type === "amount") saved = disc.amount_off;
      setAppliedPromoId(couponJ.promo_id);
      setAppliedRef("");
      setDiscountCents(saved);
      setCodeMsg(`Coupon applied${saved ? ` — saves $${(saved / 100).toFixed(2)}` : ""}!`);
      setCodeMsgOk(true);
      void createSession("", couponJ.promo_id);
      return;
    }

    // Try referral (affiliate code)
    const refR = await apiFetch("/api/validate-code", {
      method: "POST",
      body: JSON.stringify({ code: raw, type: "referral" }),
    });
    const refJ = await refR.json();

    if (refJ?.ok && refJ.type === "referral") {
      setAppliedRef(raw.toLowerCase());
      setAppliedPromoId("");
      setDiscountCents(0);
      writeStoredReferral(raw.toLowerCase());
      setCodeMsg("Referral code applied — thank you!");
      setCodeMsgOk(true);
      void createSession(raw.toLowerCase(), "");
      return;
    }

    setCodeMsg(couponJ?.error || refJ?.error || "Code not found or expired.");
    setCodeMsgOk(false);
  }

  function clearCode() {
    setCode("");
    setAppliedRef("");
    setAppliedPromoId("");
    setDiscountCents(0);
    setCodeMsg("");
    writeStoredReferral("");
    void createSession("", "");
  }

  const finalCents = Math.max(50, BASE_CENTS - discountCents);

  return (
    <div style={{ background: "rgba(14,12,22,0.88)", border: "1px solid rgba(124,58,237,0.2)", borderRadius: 18, backdropFilter: "blur(24px)", overflow: "hidden" }}>
      <div style={{ padding: "1.5rem 1.75rem", borderBottom: "1px solid rgba(124,58,237,0.1)", background: "rgba(124,58,237,0.05)" }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>Payment</div>
        <div style={{ fontSize: 12.5, color: "rgba(243,243,247,0.4)", marginTop: 3 }}>All transactions are encrypted and secured by Stripe</div>
      </div>

      <div style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Discount code field — hidden when codes were entered in the previous step */}
        {!noCodeField && <div>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "rgba(243,243,247,0.4)", letterSpacing: "0.06em", textTransform: "uppercase" as const, display: "block", marginBottom: 7 }}>
            Referral / Coupon Code
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={inputStyle}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter code (optional)"
              onFocus={(e) => (e.target.style.borderColor = "rgba(167,139,250,0.5)")}
              onBlur={(e) => (e.target.style.borderColor = "rgba(124,58,237,0.25)")}
              onKeyDown={(e) => e.key === "Enter" && applyCode()}
            />
            <button type="button" style={btnStyle} onClick={applyCode}>Apply</button>
            {(appliedRef || appliedPromoId) && (
              <button type="button" style={{ ...btnStyle, background: "transparent", borderColor: "rgba(255,255,255,0.1)", color: "rgba(243,243,247,0.4)" }} onClick={clearCode}>Clear</button>
            )}
          </div>
          {codeMsg && <div style={{ fontSize: 12, marginTop: 5, color: codeMsgOk ? "#a7f3d0" : "#fca5a5" }}>{codeMsg}</div>}
        </div>}

        {/* Price preview */}
        <div style={{ padding: "12px 16px", borderRadius: 12, background: "rgba(124,58,237,0.07)", border: "1px solid rgba(124,58,237,0.2)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 13, color: "rgba(243,243,247,0.5)" }}>
            {discountCents > 0 ? (
              <span>
                <span style={{ textDecoration: "line-through", marginRight: 6, opacity: 0.5 }}>${(BASE_CENTS / 100).toFixed(2)}</span>
                <span style={{ color: "#a7f3d0", fontSize: 11, fontWeight: 600 }}>−${(discountCents / 100).toFixed(2)} off</span>
              </span>
            ) : "Amount due"}
          </div>
          <span style={{ fontSize: 18, fontWeight: 800, color: "#f3f3f7" }}>${(finalCents / 100).toFixed(2)} USD</span>
        </div>

        {/* Login prompt */}
        {needLogin && (
          <div style={{ padding: "1.25rem", borderRadius: 14, background: "rgba(124,58,237,0.07)", border: "1px solid rgba(124,58,237,0.3)", textAlign: "center" }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 12 }}>Sign in with Discord to continue</div>
            <a href={`${API_BASE}/auth/discord/start`} style={{ display: "inline-flex", alignItems: "center", padding: "11px 20px", borderRadius: 10, background: "#5865F2", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
              Login with Discord
            </a>
          </div>
        )}

        {stripeErr && (
          <div style={{ padding: "10px 14px", borderRadius: 10, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)", color: "#fca5a5", fontSize: 13 }}>
            {stripeErr}
          </div>
        )}

        {!needLogin && (
          loading && !clientSecret ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "rgba(243,243,247,0.35)", fontSize: 13, border: "1px solid rgba(124,58,237,0.12)", borderRadius: 14, background: "rgba(7,7,9,0.4)" }}>
              Loading secure payment form...
            </div>
          ) : stripePromise && clientSecret ? (
            <>
              <div style={{ borderRadius: 14, overflow: "hidden" }}>
                <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
                  <StripeEmbeddedCheckout />
                </EmbeddedCheckoutProvider>
              </div>
              <div style={{ textAlign: "center", paddingTop: 4 }}>
                <a
                  href={`/api/create-checkout?plan=${plan}${appliedRef ? `&ref=${encodeURIComponent(appliedRef)}` : ""}`}
                  style={{ fontSize: 12, color: "rgba(167,139,250,0.55)", textDecoration: "underline", cursor: "pointer" }}
                >
                  Use Stripe-hosted checkout page instead
                </a>
              </div>
            </>
          ) : null
        )}
      </div>
    </div>
  );
}
