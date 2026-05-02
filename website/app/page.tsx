import { redirect } from "next/navigation";

/** Root / → serve the existing Zenith Macros marketing site from public/index.html */
export default function Home({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const ref = searchParams.ref;
  if (ref) {
    redirect(`/index.html?ref=${encodeURIComponent(Array.isArray(ref) ? ref[0] : ref)}`);
  }
  redirect("/index.html");
}
