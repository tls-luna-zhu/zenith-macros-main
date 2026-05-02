import { NextRequest } from "next/server";

const API_TARGET = (process.env.API_PROXY_TARGET || "http://127.0.0.1:5000").replace(/\/$/, "");

async function proxy(req: NextRequest, ctx: { params: { path: string[] } }) {
  const path = Array.isArray(ctx.params.path) ? ctx.params.path : [];
  const joined = path.join("/");
  const qs = req.nextUrl.search || "";
  const url = `${API_TARGET}/auth/${joined}${qs}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("expect");
  headers.set("accept-encoding", "identity");

  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(url, {
    method,
    headers,
    body,
    redirect: "manual",
  });

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-length");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export async function GET(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx);
}
export async function POST(req: NextRequest, ctx: { params: { path: string[] } }) {
  return proxy(req, ctx);
}
