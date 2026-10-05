import assert from "node:assert/strict";
import test from "node:test";
import { toFormBody } from "../src/canvas.js";
import { normalizeBaseUrl } from "../src/config.js";
import { bearerTokenMatches } from "../src/http.js";

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
