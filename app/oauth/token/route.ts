import {
  canonicalOrigin,
  oauthResource,
  parseScope,
  tokenResponse,
  verifyPkce,
  verifySignedToken,
} from "../../../src/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    {
      error,
      error_description: description,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  const origin = canonicalOrigin(request);
  const form = await request.formData();
  const grantType = String(form.get("grant_type") || "");

  if (grantType === "authorization_code") {
    const code = String(form.get("code") || "");
    const clientId = String(form.get("client_id") || "");
    const redirectUri = String(form.get("redirect_uri") || "");
    const codeVerifier = String(form.get("code_verifier") || "");
    const resource =
      String(form.get("resource") || "") || oauthResource(origin);

    const payload = verifySignedToken(code, "code", origin);
    if (!payload) {
      return oauthError(
        "invalid_grant",
        "The authorization code is invalid or expired.",
      );
    }

    if (
      payload.client_id !== clientId ||
      payload.redirect_uri !== redirectUri ||
      payload.aud !== resource ||
      !payload.code_challenge ||
      !verifyPkce(codeVerifier, payload.code_challenge)
    ) {
      return oauthError(
        "invalid_grant",
        "The authorization code, redirect URI, resource, client, or PKCE verifier did not match.",
      );
    }

    const scope = parseScope(payload.scope);
    return Response.json(
      tokenResponse({
        origin,
        clientId,
        resource,
        scope,
      }),
      {
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      },
    );
  }

  if (grantType === "refresh_token") {
    const refreshToken = String(form.get("refresh_token") || "");
    const requestedClientId = String(form.get("client_id") || "");
    const requestedResource =
      String(form.get("resource") || "") || oauthResource(origin);

    const payload = verifySignedToken(refreshToken, "refresh", origin);
    if (!payload) {
      return oauthError(
        "invalid_grant",
        "The refresh token is invalid or expired.",
      );
    }

    if (
      (requestedClientId && payload.client_id !== requestedClientId) ||
      payload.aud !== requestedResource
    ) {
      return oauthError(
        "invalid_grant",
        "The refresh token does not belong to this client or resource.",
      );
    }

    return Response.json(
      tokenResponse({
        origin,
        clientId: payload.client_id,
        resource: payload.aud,
        scope: parseScope(payload.scope),
      }),
      {
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      },
    );
  }

  return oauthError(
    "unsupported_grant_type",
    "Use authorization_code or refresh_token.",
  );
}
