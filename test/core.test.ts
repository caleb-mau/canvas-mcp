import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CanvasClient, toFormBody } from "../src/canvas";
import { normalizeBaseUrl } from "../src/config";
import { bearerTokenMatches } from "../src/http";
import { canvasToolAnnotations, resolveModuleItemContent } from "../src/server";
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
import {
  extractVideoUrls,
  signVideoDownload,
  verifyVideoDownloadToken,
} from "../src/video";

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


test("Canvas tool annotations classify reads and consequential writes", () => {
  assert.deepEqual(canvasToolAnnotations("canvas_get_assignment"), {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });

  assert.deepEqual(canvasToolAnnotations("canvas_submit_text"), {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  });

  assert.deepEqual(canvasToolAnnotations("canvas_submit_file"), {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });

  assert.deepEqual(canvasToolAnnotations("canvas_read_module"), {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });

  assert.deepEqual(canvasToolAnnotations("canvas_download_module_video"), {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  });

  assert.deepEqual(canvasToolAnnotations("canvas_mark_module_item"), {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });

  assert.throws(
    () => canvasToolAnnotations("unclassified_tool"),
    /Missing Canvas tool annotations/,
  );
});


test("module item content resolver follows Canvas API targets", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString(),
    );
    calls.push(url.toString());

    if (url.pathname === "/api/v1/courses/123/pages/unit-4-notes") {
      return Response.json({
        page_id: 44,
        url: "unit-4-notes",
        title: "Unit 4 Notes",
        body: "<p>Read these notes before class.</p>",
      });
    }

    throw new Error("Unexpected module resolver request: " + url);
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

    const resolved = await resolveModuleItemContent(
      client,
      "123",
      {
        id: 9,
        module_id: 7,
        type: "Page",
        title: "Unit 4 Notes",
        page_url: "unit-4-notes",
        url: "https://canvas.example.invalid/api/v1/courses/123/pages/unit-4-notes",
      },
    );

    assert.equal(resolved.resolved, true);
    assert.equal(resolved.kind, "Page");
    assert.equal(
      (resolved.content as Record<string, unknown>).title,
      "Unit 4 Notes",
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("module item resolver does not browse external module targets", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("External module target should not be fetched");
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

    const resolved = await resolveModuleItemContent(
      client,
      "123",
      {
        id: 10,
        module_id: 7,
        type: "ExternalUrl",
        title: "Reference website",
        external_url: "https://example.com/reference",
      },
    );

    assert.equal(resolved.resolved, false);
    assert.equal(resolved.kind, "ExternalUrl");
    assert.equal(resolved.external_url, "https://example.com/reference");
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("module video extraction finds YouTube embeds and direct video URLs", () => {
  const urls = extractVideoUrls({
    body: [
      '<iframe src="https://www.youtube.com/embed/abc123"></iframe>',
      '<a href="https://youtu.be/xyz789">watch</a>',
      '<video src="https://cdn.example.com/lesson.mp4"></video>',
      '<a href="https://example.com/not-video">not video</a>',
    ].join(""),
  });

  assert.deepEqual(urls, [
    "https://www.youtube.com/embed/abc123",
    "https://youtu.be/xyz789",
    "https://cdn.example.com/lesson.mp4",
  ]);
});

test("video download links use short lived signed stateless tokens", () => {
  const previous = process.env.MCP_AUTH_TOKEN;
  process.env.MCP_AUTH_TOKEN = "video-token-test-secret";

  try {
    const token = signVideoDownload({
      sourceUrl: "https://youtu.be/example",
      fileName: "Week 4 Lesson",
      maxHeight: 720,
    });

    const payload = verifyVideoDownloadToken(token);
    assert.ok(payload);
    assert.equal(payload?.source_url, "https://youtu.be/example");
    assert.equal(payload?.file_name, "Week 4 Lesson.mp4");
    assert.equal(payload?.max_height, 720);
    assert.ok((payload?.exp || 0) > Math.floor(Date.now() / 1000));

    const tampered = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    assert.equal(verifyVideoDownloadToken(tampered), null);
  } finally {
    if (previous === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = previous;
  }
});
