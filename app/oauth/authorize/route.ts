import {
  canonicalOrigin,
  issueAuthorizationCode,
  oauthResource,
  parseScope,
  validClientId,
  validCodeChallenge,
  validRedirectUri,
  verifyDeploymentSecret,
} from "../../../src/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] || char,
  );
}

function errorPage(message: string, status = 400): Response {
  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Canvas MCP authorization</title>
<style>
body{font-family:system-ui;background:#0a0a0a;color:#f5f5f5;margin:0;padding:40px}
main{max-width:640px;margin:8vh auto;border:1px solid #303030;border-radius:18px;padding:28px;background:#121212}
a{color:#fff}
code{background:#222;padding:2px 5px;border-radius:4px}
</style>
</head>
<body><main>
<h1>Authorization failed</h1>
<p>${escapeHtml(message)}</p>
</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

function readParams(url: URL) {
  return {
    responseType: url.searchParams.get("response_type") || "",
    clientId: url.searchParams.get("client_id") || "",
    redirectUri: url.searchParams.get("redirect_uri") || "",
    codeChallenge: url.searchParams.get("code_challenge") || "",
    codeChallengeMethod:
      url.searchParams.get("code_challenge_method") || "",
    state: url.searchParams.get("state") || "",
    resource: url.searchParams.get("resource") || "",
    scope: url.searchParams.get("scope") || "",
  };
}

function validateParams(
  origin: string,
  params: ReturnType<typeof readParams>,
): string | null {
  if (params.responseType !== "code") {
    return "Only the OAuth authorization code flow is supported.";
  }
  if (!validClientId(params.clientId)) {
    return "The OAuth client_id must be an HTTPS Client ID Metadata Document URL.";
  }
  if (!validRedirectUri(params.redirectUri, params.clientId)) {
    return "The OAuth redirect_uri is invalid.";
  }
  if (params.codeChallengeMethod !== "S256") {
    return "PKCE with S256 is required.";
  }
  if (!validCodeChallenge(params.codeChallenge)) {
    return "The PKCE code challenge is invalid.";
  }

  const resource = params.resource || oauthResource(origin);
  if (resource !== oauthResource(origin)) {
    return "The requested OAuth resource does not match this Canvas MCP deployment.";
  }

  return null;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = canonicalOrigin(request);
  const params = readParams(url);
  const validationError = validateParams(origin, params);
  if (validationError) return errorPage(validationError);

  const requestedScope = parseScope(params.scope).join(" ");

  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Canvas MCP</title>
<style>
body{font-family:system-ui;background:#0a0a0a;color:#f5f5f5;margin:0;padding:24px}
main{max-width:640px;margin:8vh auto;border:1px solid #303030;border-radius:20px;padding:30px;background:#121212;box-shadow:0 30px 90px #0008}
h1{margin-top:0;font-size:2rem}
p{color:#c8c8c8;line-height:1.6}
label{display:block;margin:22px 0 8px;font-weight:700}
input{width:100%;box-sizing:border-box;background:#080808;color:#fff;border:1px solid #444;border-radius:10px;padding:12px;font:inherit}
button{margin-top:18px;border:0;border-radius:10px;background:#fff;color:#111;padding:12px 16px;font:inherit;font-weight:800;cursor:pointer}
.small{font-size:.9rem;color:#8f8f8f}
code{background:#222;padding:2px 5px;border-radius:4px}
</style>
</head>
<body>
<main>
<h1>Authorize Canvas MCP</h1>
<p>
ChatGPT is asking to connect to this self hosted Canvas MCP.
Canvas authentication still uses the personal Canvas token stored on this server.
</p>
<p>
To prove you own this deployment, enter the same <code>MCP_AUTH_TOKEN</code>
you configured in the deployment environment.
</p>
<form method="post">
<input type="hidden" name="response_type" value="${escapeHtml(params.responseType)}">
<input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
<input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
<input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
<input type="hidden" name="code_challenge_method" value="${escapeHtml(params.codeChallengeMethod)}">
<input type="hidden" name="state" value="${escapeHtml(params.state)}">
<input type="hidden" name="resource" value="${escapeHtml(params.resource || oauthResource(origin))}">
<input type="hidden" name="scope" value="${escapeHtml(requestedScope)}">
<label for="deployment_token">MCP access token</label>
<input id="deployment_token" name="deployment_token" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Authorize ChatGPT</button>
</form>
<p class="small">
The token is checked by this deployment and is not sent to Canvas.
The resulting OAuth access token is limited to this MCP deployment.
</p>
</main>
</body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  const origin = canonicalOrigin(request);
  const form = await request.formData();

  const params = {
    responseType: String(form.get("response_type") || ""),
    clientId: String(form.get("client_id") || ""),
    redirectUri: String(form.get("redirect_uri") || ""),
    codeChallenge: String(form.get("code_challenge") || ""),
    codeChallengeMethod: String(form.get("code_challenge_method") || ""),
    state: String(form.get("state") || ""),
    resource: String(form.get("resource") || ""),
    scope: String(form.get("scope") || ""),
  };

  const validationError = validateParams(origin, params);
  if (validationError) return errorPage(validationError);

  const deploymentToken = String(form.get("deployment_token") || "");
  if (!verifyDeploymentSecret(deploymentToken)) {
    return errorPage("That MCP access token is not correct.", 401);
  }

  const scope = parseScope(params.scope);
  const resource = params.resource || oauthResource(origin);
  const code = issueAuthorizationCode({
    origin,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    resource,
    scope,
    codeChallenge: params.codeChallenge,
  });

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  redirect.searchParams.set("iss", origin);

  return Response.redirect(redirect, 303);
}
