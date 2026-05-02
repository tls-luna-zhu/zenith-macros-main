"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { writeStoredReferral } from "@/lib/api";

/** Captures ?rreferal= and /rreferal/[code] — stores locally for checkout. */
export function ReferralCapture() {
  const sp = useSearchParams();
  const pathname = usePathname();

  useEffect(() => {
    const q =
      sp.get("rreferal") ||
      sp.get("referral") ||
      sp.get("ref") ||
      "";
    if (q && /^[a-z0-9]{4,32}$/i.test(q.trim())) {
      writeStoredReferral(q.trim().toLowerCase());
    }
  }, [sp]);

  useEffect(() => {
    if (!pathname?.startsWith("/rreferal/")) return;
    const seg = pathname.slice("/rreferal/".length);
    if (seg && /^[a-z0-9]{4,32}$/i.test(seg)) {
      writeStoredReferral(seg.toLowerCase());
    }
  }, [pathname]);

  return null;
}
