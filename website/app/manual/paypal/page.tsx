"use client";

import Link from "next/link";
import { Suspense } from "react";
import { PremiumBg } from "@/components/PremiumBg";
import { useSearchParams } from "next/navigation";

const KF = `
  @keyframes pmFadeUp {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes pmFadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes pmCardGlow {
    0%, 100% { border-color: rgba(124,58,237,0.22); box-shadow: none; }
    50%      { border-color: rgba(167,139,250,0.4);  box-shadow: 0 0 30px rgba(124,58,237,0.10); }
  }
  @keyframes pmStepIn {
    from { opacity: 0; transform: translateX(-14px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes pmIconBob {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-4px); }
  }
`;

const ease = "cubic-bezier(0.22,1,0.36,1)";

function ManualPaypalContent() {
  const searchParams = useSearchParams();
  const plan  = searchParams.get("plan") || "monthly";
  const price = plan === "lifetime" ? "$25 (one-time)" : plan === "3month" ? "$10 (3 months)" : "$5/month";

  const steps = [
    "Open a ticket in our Discord server",
    `Tell staff your Discord tag and desired plan: ${plan} (${price})`,
    "Staff will send the PayPal payment link",
    "Once confirmed, your license is linked within minutes",
  ];

  return (
    <>
      <style>{KF}</style>
      <PremiumBg />

      {/* Nav */}
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
        display: "flex", alignItems: "center", padding: "0 2rem", height: 56,
        background: "rgba(6,5,15,0.75)",
        backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(124,58,237,0.12)",
        animation: `pmFadeIn 0.45s ease 0ms both`,
      }}>
        <a href={`/selectpayment?plan=${plan}`} style={{
          display: "flex", alignItems: "center", gap: 8,
          color: "rgba(243,243,247,0.45)", textDecoration: "none", fontSize: 13.5,
          transition: "color 0.2s",
        }}
          onMouseEnter={e => (e.currentTarget.style.color = "rgba(243,243,247,0.85)")}
          onMouseLeave={e => (e.currentTarget.style.color = "rgba(243,243,247,0.45)")}
        >
          <svg viewBox="0 0 20 20" fill="none" width={16} height={16}>
            <path d="M12 15l-5-5 5-5" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Payment options
        </a>
      </div>

      <div style={{
        position: "relative", zIndex: 1, minHeight: "100vh",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "5rem 2rem 2rem",
      }}>
        <div style={{
          width: "100%", maxWidth: 480,
          background: "rgba(12,10,20,0.92)",
          border: "1px solid rgba(124,58,237,0.22)",
          borderRadius: 22,
          backdropFilter: "blur(36px)", WebkitBackdropFilter: "blur(36px)",
          overflow: "hidden",
          animation: `pmFadeUp 0.7s ${ease} 80ms both, pmCardGlow 4.5s ease-in-out 1.5s infinite`,
          position: "relative",
        }}>
          {/* PayPal colour bar */}
          <div style={{
            height: 3,
            background: "linear-gradient(90deg, #003087, #009cde, #012169)",
            animation: `pmFadeIn 0.8s ease 500ms both`,
          }} />

          <div style={{ padding: "2.25rem 2rem" }}>

            {/* Icon */}
            <div style={{
              width: 52, height: 52, borderRadius: 14,
              background: "rgba(0,48,135,0.18)",
              border: "1px solid rgba(0,156,222,0.25)",
              display: "flex", alignItems: "center", justifyContent: "center",
              marginBottom: "1.5rem", fontSize: 24, fontWeight: 900, color: "#009cde",
              animation: `pmFadeUp 0.55s ${ease} 220ms both, pmIconBob 3.5s ease-in-out 1.5s infinite`,
            }}>
              P
            </div>

            <h1 style={{
              fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 0.5rem",
              animation: `pmFadeUp 0.5s ${ease} 280ms both`,
            }}>
              PayPal Payment
            </h1>
            <p style={{
              fontSize: 14, color: "rgba(243,243,247,0.48)", lineHeight: 1.65, margin: "0 0 1.75rem",
              animation: `pmFadeUp 0.5s ${ease} 330ms both`,
            }}>
              PayPal is handled manually through Discord. Follow the steps below to complete your {plan} plan purchase.
            </p>

            {/* Steps */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: "1.75rem" }}>
              {steps.map((text, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "flex-start", gap: 12,
                  animation: `pmStepIn 0.5s ${ease} ${380 + i * 80}ms both`,
                }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                    background: "rgba(124,58,237,0.15)",
                    border: "1px solid rgba(124,58,237,0.3)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11.5, fontWeight: 700, color: "#c4b5fd",
                    transition: "background 0.2s, border-color 0.2s",
                  }}>
                    {i + 1}
                  </div>
                  <div style={{ fontSize: 13.5, color: "rgba(243,243,247,0.68)", paddingTop: 4, lineHeight: 1.55 }}>
                    {text}
                  </div>
                </div>
              ))}
            </div>

            {/* CTA */}
            <a
              href="https://discord.gg/tbT5Zjg7dE"
              target="_blank" rel="noopener noreferrer"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                padding: "13px", borderRadius: 12,
                background: "#5865F2",
                color: "#fff", fontWeight: 700, fontSize: 14,
                textDecoration: "none",
                transition: "background 0.2s, transform 0.18s, box-shadow 0.2s",
                animation: `pmFadeUp 0.55s ${ease} ${380 + steps.length * 80}ms both`,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = "#4752c4";
                e.currentTarget.style.transform = "translateY(-2px)";
                e.currentTarget.style.boxShadow = "0 8px 24px rgba(88,101,242,0.35)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "#5865F2";
                e.currentTarget.style.transform = "translateY(0)";
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
                <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.04.032.055a19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z" />
              </svg>
              Open Discord
            </a>
          </div>
        </div>
      </div>
    </>
  );
}

export default function ManualPaypal() {
  return (
    <Suspense fallback={null}>
      <ManualPaypalContent />
    </Suspense>
  );
}
