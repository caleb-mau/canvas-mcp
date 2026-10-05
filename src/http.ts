import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server";

const handler = createMcpHandler(() => createServer());

export function bearerTokenMatches(header: string | null, expectedToken: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  const provided = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(provided, expected);
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

  const authorization = request.headers.get("authorization");
  if (!bearerTokenMatches(authorization, expectedToken)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="canvas-mcp"',
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return handler.fetch(request, {
    authInfo: {
      token: expectedToken,
      clientId: "self-hosted-mcp-client",
      scopes: ["mcp"],
    },
  });
}
