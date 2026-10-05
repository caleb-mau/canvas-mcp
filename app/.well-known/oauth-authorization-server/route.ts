import {
  authorizationServerMetadata,
  canonicalOrigin,
} from "../../../src/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const origin = canonicalOrigin(request);
  return Response.json(authorizationServerMetadata(origin), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
