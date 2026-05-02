"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  EmbeddedCheckout as StripeEmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { apiFetch } from "@/lib/api";
import Link from "next/link";

type ProductInfo = { id: string; name: string; description: string; price_cents: number; badge: string };

function StandaloneCheckoutInner({ productIds }: { productIds: string[] }) {
  const [products, setProducts]          = useState<ProductInfo[]>([]);
  const [clientSecret, setClientSecret]  = useState<string | null>(null);
  const [pk, setPk]                      = useState<string | null>(null);
  const [loading, setLoading]            = useState(true);
  const [error, setError]                = useState("");
  const [needLogin, setNeedLogin]        = useState(false);
  const [alreadyOwned, setAlreadyOwned]  = useState(false);

  const createSession = useCallback(async (pids: string[]) => {
    setLoading(true);
    setError("");

    const r = await apiFetch("/api/checkout-standalone", {
      method: "POST",
      body: JSON.stringify({ product_ids: pids }),
    });
    const j = await r.json();

    if (r.status === 401) { setNeedLogin(true); setLoading(false); return; }
    if (r.status === 409) { setAlreadyOwned(true); setLoading(false); return; }
    if (!r.ok || !j?.ok || !j?.client_secret) {
      setError(j?.error || "Could not start checkout");
      setLoading(false);
      return;
    }

    const cfgR = await apiFetch("/api/stripe-config");
    const cfg  = await cfgR.json();
    if (!cfgR.ok || !cfg?.publishable_key) {
      setError("Stripe configuration missing");
      setLoading(false);
      return;
    }

    setPk(cfg.publishable_key);
    setClientSecret(j.client_secret);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!productIds.length) { setError("No product specified"); setLoading(false); return; }

    fetch("/api/products")
      .then(r => r.json())
      .then(d => {
        const all: ProductInfo[] = d?.items || [];
        const found = productIds.map(pid => all.find(p => p.id === pid)).filter(Boolean) as ProductInfo[];
        const missing = productIds.filter(pid => !all.find(p => p.id === pid));
        if (missing.length) { setError(`Product not found: ${missing.join(', ')}`); setLoading(false); return; }
        setProducts(found);
        createSession(productIds);
      })
      .catch(() => { setError("Could not load product info"); setLoading(false); });
  }, [productIds, createSession]);

  const stripePromise = useMemo(() => pk ? loadStripe(pk) : null, [pk]);

  const totalCents = products.reduce((s, p) => s + p.price_cents, 0);
  const totalPrice = `$${(totalCents / 100).toFixed(2)}`;

  return (
    <div style={{ display: "flex", alignItems: "flex-start", minHeight: "calc(100vh - 64px)" }}>

      {/* Left panel */}
      <aside style={{
        width: 380, flexShrink: 0,
        padding: "52px 40px",
        borderRight: "1px solid rgba(255,255,255,0.08)",
        display: "flex", flexDirection: "column", gap: 24,
        position: "sticky", top: 64, minHeight: "calc(100vh - 64px)",
      }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", background: "rgba(124,58,237,0.1)", border: "1px solid rgba(124,58,237,0.25)", color: "#c4b5fd", width: "fit-content" }}>
          <svg viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" width={11} height={11}><path d="M5.5 1L2 2.8v3.5C2 8.2 3.5 9.8 5.5 10.2 7.5 9.8 9 8.2 9 6.3V2.8z" /></svg>
          Secure checkout
        </div>

        {/* Product card(s) */}
        <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(240,240,245,0.28)", marginBottom: 10 }}>
            {products.length > 1 ? "You're purchasing" : "You're purchasing"}
          </div>
          {products.length > 0 ? (
            <>
              {products.map((product, i) => (
                <div key={product.id} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: i < products.length - 1 ? 12 : 16 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, color: "#c4b5fd", flexShrink: 0 }}>
                    {product.badge}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#f0f0f5" }}>{product.name}</div>
                    <div style={{ fontSize: 12, color: "rgba(240,240,245,0.4)", marginTop: 1 }}>${(product.price_cents / 100).toFixed(2)} · one-time</div>
                  </div>
                </div>
              ))}
              <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.08)", margin: "0 0 14px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, color: "rgba(240,240,245,0.4)" }}>Total · one-time</span>
                <span style={{ fontSize: 28, fontWeight: 800, color: "#f0f0f5", letterSpacing: "-1px" }}>{totalPrice}</span>
              </div>
            </>
          ) : (
            <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(240,240,245,0.3)", fontSize: 13 }}>Loading…</div>
          )}
        </div>

        {/* Features */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {["Works with your existing Zenith Macros key", "Instant access after payment", "Lightweight standalone app — no hub required"].map(f => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "rgba(240,240,245,0.45)" }}>
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" width={14} height={14} style={{ color: "#7c3aed", flexShrink: 0 }}><path d="M2 7l3 3 7-6" /></svg>
              {f}
            </div>
          ))}
        </div>
      </aside>

      {/* Right panel */}
      <main style={{ flex: 1, padding: "52px 44px", display: "flex", alignItems: "flex-start", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 480 }}>

          {needLogin && (
            <div style={{ padding: "2rem", borderRadius: 16, background: "rgba(124,58,237,0.07)", border: "1px solid rgba(124,58,237,0.25)", textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Sign in to purchase</div>
              <div style={{ fontSize: 13, color: "rgba(240,240,245,0.5)", marginBottom: 20 }}>You need to be logged in with Discord to buy an Individual Macro.</div>
              <a href="/api/auth/discord/start" style={{ display: "inline-flex", alignItems: "center", padding: "11px 22px", borderRadius: 10, background: "#5865F2", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
                Login with Discord
              </a>
            </div>
          )}

          {alreadyOwned && (
            <div style={{ padding: "2rem", borderRadius: 16, background: "rgba(34,197,94,0.07)", border: "1px solid rgba(34,197,94,0.2)", textAlign: "center" }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#86efac", marginBottom: 8 }}>Already owned</div>
              <div style={{ fontSize: 13, color: "rgba(240,240,245,0.5)", marginBottom: 20 }}>You already own this macro. Head to your dashboard to download it.</div>
              <a href="/dashboard.html" style={{ display: "inline-flex", alignItems: "center", padding: "10px 20px", borderRadius: 10, background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.3)", color: "#c4b5fd", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>
                Go to Dashboard
              </a>
            </div>
          )}

          {error && !needLogin && !alreadyOwned && (
            <div style={{ padding: "14px 18px", borderRadius: 12, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)", color: "#fca5a5", fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}

          {loading && !error && !needLogin && !alreadyOwned && (
            <div style={{ padding: "3rem", textAlign: "center", color: "rgba(240,240,245,0.3)", fontSize: 13, border: "1px solid rgba(124,58,237,0.12)", borderRadius: 14, background: "rgba(7,7,9,0.4)" }}>
              Loading secure payment form…
            </div>
          )}

          {stripePromise && clientSecret && (
            <div style={{ borderRadius: 14, overflow: "hidden" }}>
              <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
                <StripeEmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function StandaloneCheckoutContent() {
  const searchParams = useSearchParams();
  const raw          = searchParams.get("product_id") || "";
  const productIds   = raw.split(",").map(s => s.trim()).filter(Boolean);

  return (
    <>
      <style>{`body{background:#080810;color:#f0f0f5;font-family:inherit}`}</style>
      <div style={{ position: "fixed", inset: 0, background: "#080810", zIndex: -1 }} />

      {/* Nav */}
      <nav style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 32px", background: "rgba(8,8,16,0.9)", backdropFilter: "blur(14px)", borderBottom: "1px solid rgba(255,255,255,0.08)", height: 64 }}>
        <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", color: "#f0f0f5", fontWeight: 700, fontSize: 16 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-transparent.png" alt="Zenith" style={{ width: 28, height: 28, borderRadius: 6 }} />
          Zenith Macros
        </a>
        <Link href="/dashboard.html" style={{ display: "flex", alignItems: "center", gap: 6, textDecoration: "none", color: "rgba(240,240,245,0.55)", fontSize: 13, fontWeight: 500, padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.04)" }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width={14} height={14}><path d="M10 12L6 8l4-4" /></svg>
          Back to dashboard
        </Link>
      </nav>

      <div style={{ paddingTop: 64, position: "relative", zIndex: 1 }}>
        <StandaloneCheckoutInner productIds={productIds} />
      </div>
    </>
  );
}

export default function CheckoutStandalonePage() {
  return (
    <Suspense fallback={null}>
      <StandaloneCheckoutContent />
    </Suspense>
  );
}
