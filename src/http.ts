import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server";
import { canonicalOrigin, oauthResource, validMcpBearer } from "./oauth";

const handler = createMcpHandler(() => createServer());

export function bearerTokenMatches(header: string | null, expectedToken: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return match[1] === expectedToken;
}

function bearerValue(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export async function handleRemoteMcp(request: Request): Promise<Response> {
  const expectedToken = process.env.MCP_AUTH_TOKEN?.trim();

  if (!expectedToken) {
    return Response.json(
      {
        error: "MCP_AUTH_TOKEN is not configured on this deployment.",
      },
      { status: 503 },
    );
  }

  const origin = canonicalOrigin(request);
  const authorization = request.headers.get("authorization");
  const bearer = bearerValue(authorization);

  if (!bearer || !validMcpBearer(bearer, origin)) {
    const resourceMetadata =
      origin + "/.well-known/oauth-protected-resource";
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer resource_metadata="' +
            resourceMetadata +
            '", scope="mcp", error="invalid_token", error_description="OAuth authorization is required"',
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return handler.fetch(request, {
    authInfo: {
      token: bearer,
      clientId: "oauth-or-self-hosted-client",
      scopes: ["mcp"],
      extra: {
        resource: oauthResource(origin),
      },
    },
  });
}
