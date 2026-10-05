import { handleRemoteMcp } from "../../src/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  const response = await handleRemoteMcp(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
