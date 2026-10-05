import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CanvasClient, toFormBody } from "../src/canvas";
import { confirmationRequired, normalizeBaseUrl } from "../src/config";
import { bearerTokenMatches } from "../src/http";
import {
  authorizationServerMetadata,
  CHATGPT_CIMD_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT,
  issueAccessToken,
  issueAuthorizationCode,
  oauthResource,
  protectedResourceMetadata,
  validClientId,
  validRedirectUri,
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
    assert.equal("grades" in roster[0], false);

    const expandedRoster = await client.teacherStudents("123", true);
    assert.equal("grades" in expandedRoster[0], true);
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


test("OAuth client validation is pinned to ChatGPT CIMD and callback", () => {
  assert.equal(validClientId(CHATGPT_CIMD_CLIENT_ID), true);
  assert.equal(validClientId("https://evil.example/client.json"), false);
  assert.equal(
    validRedirectUri(CHATGPT_OAUTH_REDIRECT, CHATGPT_CIMD_CLIENT_ID),
    true,
  );
  assert.equal(
    validRedirectUri("https://evil.example/callback", CHATGPT_CIMD_CLIENT_ID),
    false,
  );
});


test("remote Canvas submission files reject private network URLs", async () => {
  const client = new CanvasClient({
    baseUrl: "https://canvas.example.invalid",
    accessToken: "test-token",
    writeMode: "student",
    maxPages: 20,
    timeoutMs: 30000,
    redactionKey: "test-redaction-key",
  });

  await assert.rejects(
    () => client.uploadSubmissionFileReference("123", "456", {
      download_url: "https://127.0.0.1/private.pdf",
      file_id: "file_private",
      mime_type: "application/pdf",
      file_name: "private.pdf",
    }),
    /private or local network address/,
  );
});

test("remote file references download without Canvas credentials and upload to Canvas", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString(),
    );
    calls.push(url.toString());

    if (url.hostname === "93.184.216.34") {
      const headers = new Headers(init?.headers);
      assert.equal(headers.has("authorization"), false);
      return new Response("example pdf bytes", {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": "17",
        },
      });
    }

    if (
      url.hostname === "canvas.example.invalid" &&
      url.pathname.endsWith("/submissions/self/files")
    ) {
      return Response.json({
        upload_url: "https://uploads.example.invalid/upload",
        upload_params: {
          key: "canvas-upload-key",
        },
      });
    }

    if (url.hostname === "uploads.example.invalid") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "https://canvas.example.invalid/api/v1/files/777",
        },
      });
    }

    if (
      url.hostname === "canvas.example.invalid" &&
      url.pathname === "/api/v1/files/777"
    ) {
      return Response.json({
        id: 777,
        display_name: "essay.pdf",
        content_type: "application/pdf",
      });
    }

    throw new Error("Unexpected request in remote file test: " + url);
  };

  try {
    const client = new CanvasClient({
      baseUrl: "https://canvas.example.invalid",
      accessToken: "test-token",
      writeMode: "student",
      maxPages: 20,
      timeoutMs: 30000,
      redactionKey: "test-redaction-key",
    });

    const uploaded = await client.uploadSubmissionFileReference(
      "123",
      "456",
      {
        download_url: "https://93.184.216.34/essay.pdf",
        file_id: "file_test_123",
        mime_type: "application/pdf",
        file_name: "essay.pdf",
      },
    );

    assert.equal(uploaded.id, 777);
    assert.equal(calls[0], "https://93.184.216.34/essay.pdf");
    assert.ok(calls.some((url) => url.includes("/submissions/self/files")));
    assert.ok(calls.some((url) => url === "https://uploads.example.invalid/upload"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
