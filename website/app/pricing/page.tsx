import { redirect } from "next/navigation";

export default function PricingPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const ref = searchParams.ref;
  if (ref) {
    redirect(`/selectpayment?ref=${encodeURIComponent(Array.isArray(ref) ? ref[0] : ref)}`);
  }
  redirect("/selectpayment");
}
