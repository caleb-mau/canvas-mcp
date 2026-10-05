import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const MCP_SCOPE = "mcp";
export const OFFLINE_SCOPE = "offline_access";
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const CODE_TTL_SECONDS = 90;

type TokenType = "code" | "access" | "refresh";

export interface OAuthTokenPayload {
  v: 1;
  typ: TokenType;
  iss: string;
  aud: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  nonce: string;
  redirect_uri?: string;
  code_challenge?: string;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function hmac(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function oauthSecret(): string {
  const secret = process.env.MCP_AUTH_TOKEN?.trim();
  if (!secret) throw new Error("MCP_AUTH_TOKEN is not configured.");
  return secret;
}

export function canonicalOrigin(request: Request): string {
  const configured = process.env.MCP_PUBLIC_ORIGIN?.trim();
  if (configured) return new URL(configured).origin;
  return new URL(request.url).origin;
}

export function oauthResource(origin: string): string {
  return origin;
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: oauthResource(origin),
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE, OFFLINE_SCOPE],
    resource_documentation: origin,
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE, OFFLINE_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function parseScope(scope: string | null | undefined): string[] {
  const requested = (scope || MCP_SCOPE)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const unique = [...new Set(requested)];
  if (!unique.includes(MCP_SCOPE)) unique.unshift(MCP_SCOPE);

  return unique.filter((item) => item === MCP_SCOPE || item === OFFLINE_SCOPE);
}

function token(
  typ: TokenType,
  origin: string,
  clientId: string,
  resource: string,
  scope: string[],
  extra: Pick<OAuthTokenPayload, "redirect_uri" | "code_challenge"> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const ttl =
    typ === "code"
      ? CODE_TTL_SECONDS
      : typ === "access"
        ? ACCESS_TTL_SECONDS
        : REFRESH_TTL_SECONDS;

  const payload: OAuthTokenPayload = {
    v: 1,
    typ,
    iss: origin,
    aud: resource,
    client_id: clientId,
    scope: scope.join(" "),
    iat: now,
    exp: now + ttl,
    nonce: randomBytes(16).toString("base64url"),
    ...extra,
  };

  const encoded = base64urlJson(payload);
  return encoded + "." + hmac(encoded, oauthSecret());
}

export function issueAuthorizationCode(args: {
  origin: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string[];
  codeChallenge: string;
}): string {
  return token(
    "code",
    args.origin,
    args.clientId,
    args.resource,
    args.scope,
    {
      redirect_uri: args.redirectUri,
      code_challenge: args.codeChallenge,
    },
  );
}

export function issueAccessToken(args: {
  origin: string;
  clientId: string;
  resource: string;
  scope: string[];
}): string {
  return token(
    "access",
    args.origin,
    args.clientId,
    args.resource,
    args.scope,
  );
}

export function issueRefreshToken(args: {
  origin: string;
  clientId: string;
  resource: string;
  scope: string[];
}): string {
  return token(
    "refresh",
    args.origin,
    args.clientId,
    args.resource,
    args.scope,
  );
}

export function verifySignedToken(
  raw: string,
  expectedType: TokenType,
  origin: string,
): OAuthTokenPayload | null {
  const [encoded, signature, ...rest] = raw.split(".");
  if (!encoded || !signature || rest.length) return null;

  const expected = hmac(encoded, oauthSecret());
  if (!safeEqualText(signature, expected)) return null;

  let payload: OAuthTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as OAuthTokenPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    payload.v !== 1 ||
    payload.typ !== expectedType ||
    payload.iss !== origin ||
    typeof payload.aud !== "string" ||
    typeof payload.client_id !== "string" ||
    typeof payload.scope !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp <= now
  ) {
    return null;
  }

  return payload;
}

export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  const computed = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return safeEqualText(computed, codeChallenge);
}

export function verifyDeploymentSecret(value: string): boolean {
  return safeEqualText(value, oauthSecret());
}

export function validClientId(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function validCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

export function tokenResponse(args: {
  origin: string;
  clientId: string;
  resource: string;
  scope: string[];
}) {
  return {
    token_type: "Bearer",
    access_token: issueAccessToken(args),
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: issueRefreshToken(args),
    scope: args.scope.join(" "),
  };
}

export function validMcpBearer(
  bearer: string,
  origin: string,
): boolean {
  const rawSecret = process.env.MCP_AUTH_TOKEN?.trim();
  if (rawSecret && safeEqualText(bearer, rawSecret)) return true;

  const payload = verifySignedToken(bearer, "access", origin);
  if (!payload) return false;
  if (payload.aud !== oauthResource(origin)) return false;

  const scopes = payload.scope.split(/\s+/);
  return scopes.includes(MCP_SCOPE);
}
