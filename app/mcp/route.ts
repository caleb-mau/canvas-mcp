import { handleRemoteMcp } from "../../src/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  return handleRemoteMcp(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleRemoteMcp(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handleRemoteMcp(request);
}
