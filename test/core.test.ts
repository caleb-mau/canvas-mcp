import assert from "node:assert/strict";
import test from "node:test";
import { CanvasClient, toFormBody } from "../src/canvas";
import { confirmationRequired, normalizeBaseUrl } from "../src/config";
import { bearerTokenMatches } from "../src/http";

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
