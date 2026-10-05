import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CanvasClient, toFormBody } from "../src/canvas";
import { confirmationRequired, normalizeBaseUrl } from "../src/config";
import { bearerTokenMatches } from "../src/http";
import {
  authorizationServerMetadata,
  issueAccessToken,
  issueAuthorizationCode,
  oauthResource,
  protectedResourceMetadata,
  verifyPkce,
  verifySignedToken,
} from "../src/oauth";

test("normalizeBaseUrl accepts a district hostname", () => {
  assert.equal(
    normalizeBaseUrl("school.instructure.com/profile/settings"),
    "https://school.instructure.com",
  );
});

test("normalizeBaseUrl removes Canvas paths", () => {
  assert.equal(
    normalizeBaseUrl("https://school.instructure.com/profile/settings?x=1"),
    "https://school.instructure.com",
  );
});

test("normalizeBaseUrl rejects insecure non local origins", () => {
  assert.throws(
    () => normalizeBaseUrl("http://school.instructure.com"),
    /HTTPS/,
  );
});

test("toFormBody creates Canvas bracket notation", () => {
  const body = toFormBody({
    submission: {
      submission_type: "online_upload",
      file_ids: [123, 456],
    },
    comment: { text_comment: "done" },
  });

  assert.deepEqual(body.getAll("submission[file_ids][]"), ["123", "456"]);
  assert.equal(body.get("submission[submission_type]"), "online_upload");
  assert.equal(body.get("comment[text_comment]"), "done");
});

test("bearerTokenMatches only accepts the configured bearer token", () => {
  assert.equal(bearerTokenMatches("Bearer abc123", "abc123"), true);
  assert.equal(bearerTokenMatches("bearer abc123", "abc123"), true);
  assert.equal(bearerTokenMatches("Bearer wrong", "abc123"), false);
  assert.equal(bearerTokenMatches(null, "abc123"), false);
});


test("teacher mode redacts roster identity fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([
    {
      id: 7001,
      user_id: 42,
      enrollment_state: "active",
      grades: { current_score: 93.5 },
      user: {
        id: 42,
        name: "Example Student",
        login_id: "example_login",
        sis_user_id: "EXAMPLE_SIS",
        email: "student@example.invalid"
      }
    }
  ]), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const client = new CanvasClient({
      baseUrl: "https://canvas.example.invalid",
      accessToken: "test-token",
      writeMode: "teacher",
      maxPages: 20,
      timeoutMs: 30000,
      redactionKey: "test-redaction-key"
    });

    const roster = await client.teacherStudents("123");
    const studentRef = String(roster[0].student_ref);
    assert.match(studentRef, /^student_/);
    assert.equal(await client.resolveStudentRef("123", studentRef), "42");
    assert.ok(!JSON.stringify(roster).includes("Example Student"));
    assert.ok(!JSON.stringify(roster).includes("example_login"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("teacher mode blocks account level writes", async () => {
  const client = new CanvasClient({
    baseUrl: "https://canvas.example.invalid",
    accessToken: "test-token",
    writeMode: "teacher",
    maxPages: 20,
    timeoutMs: 30000,
    redactionKey: "test-redaction-key"
  });

  await assert.rejects(
    () => client.put("/api/v1/accounts/1/courses/2", { course: { name: "Example" } }),
    /teacher blocks account-level or administrative mutation/
  );
});


test("explicit Canvas confirmation is on by default", () => {
  const previous = process.env.CANVAS_REQUIRE_CONFIRMATION;
  try {
    delete process.env.CANVAS_REQUIRE_CONFIRMATION;
    assert.equal(confirmationRequired(), true);

    process.env.CANVAS_REQUIRE_CONFIRMATION = "false";
    assert.equal(confirmationRequired(), false);

    process.env.CANVAS_REQUIRE_CONFIRMATION = "true";
    assert.equal(confirmationRequired(), true);
  } finally {
    if (previous === undefined) delete process.env.CANVAS_REQUIRE_CONFIRMATION;
    else process.env.CANVAS_REQUIRE_CONFIRMATION = previous;
  }
});


test("OAuth metadata advertises ChatGPT compatible PKCE flow", () => {
  const origin = "https://canvas-mcp.example.invalid";
  const resource = protectedResourceMetadata(origin);
  const auth = authorizationServerMetadata(origin);

  assert.equal(resource.resource, origin);
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.equal(auth.authorization_endpoint, origin + "/oauth/authorize");
  assert.equal(auth.token_endpoint, origin + "/oauth/token");
  assert.ok(auth.code_challenge_methods_supported.includes("S256"));
  assert.equal(auth.client_id_metadata_document_supported, true);
  assert.ok(auth.grant_types_supported.includes("refresh_token"));
});

test("OAuth authorization codes are bound to PKCE and the MCP resource", () => {
  const previous = process.env.MCP_AUTH_TOKEN;
  process.env.MCP_AUTH_TOKEN = "unit-test-mcp-secret";

  try {
    const origin = "https://canvas-mcp.example.invalid";
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");

    const code = issueAuthorizationCode({
      origin,
      clientId: "https://chatgpt.com/oauth/client.json",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      resource: oauthResource(origin),
      scope: ["mcp", "offline_access"],
      codeChallenge: challenge,
    });

    const payload = verifySignedToken(code, "code", origin);
    assert.ok(payload);
    assert.equal(payload?.aud, origin);
    assert.equal(payload?.client_id, "https://chatgpt.com/oauth/client.json");
    assert.equal(verifyPkce(verifier, challenge), true);
    assert.equal(verifyPkce(verifier + "wrong", challenge), false);

    const access = issueAccessToken({
      origin,
      clientId: "https://chatgpt.com/oauth/client.json",
      resource: origin,
      scope: ["mcp"],
    });
    assert.equal(verifySignedToken(access, "access", origin)?.aud, origin);
  } finally {
    if (previous === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = previous;
  }
});
