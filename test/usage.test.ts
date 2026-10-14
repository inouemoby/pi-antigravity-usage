import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTIGRAVITY_ENDPOINT } from "@cortexkit/antigravity-auth-core";
import { fetchAntigravityUsage, parseBucket, parseQuota, quotaAccount } from "../src/usage.ts";
const auth = { access: "access-secret", refresh: "refresh-secret|base-project|managed-project", expires: Date.now() + 60000 };
const quota = () => ({ groups: [{ displayName: "Gemini models", buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.75, resetTime: new Date(Date.now() + 60000).toISOString() }, { bucketId: "gemini-weekly", remainingPercent: 90 }] }, { displayName: "Claude and GPT", buckets: [{ window: "weekly", remainingFraction: 0.5 }] }] });
test("parses quota pools, alternate percentage fields and windows", () => {
  const result = parseQuota(quota());
  assert.equal(result.gemini?.fiveHour?.usedPercent, 25);
  assert.equal(result.gemini?.weekly?.usedPercent, 10);
  assert.equal(result.claudeGpt?.weekly?.usedPercent, 50);
});
test("invalid or absent buckets are unknown, never zero usage", () => {
  for (const p of [{}, { groups: [] }, { groups: [{ displayName: "Gemini", buckets: [] }] }]) assert.throws(() => parseQuota(p));
  assert.equal(parseBucket({ window: "5h", remainingFraction: NaN }), undefined);
});
test("bucket percentages are clamped, invalid reset times are unknown", () => {
  const result = parseBucket({ window: "5h", remainingFraction: 4, resetTime: "invalid" });
  assert.equal(result?.usedPercent, 0); assert.equal(result?.resetMs, 0); assert.equal(result?.resetsIn, "unknown");
});
test("delegates authentication and uses current identity and managed project only", async () => {
  let resolved = 0, url = "", body: Record<string, unknown> = {};
  const result = await fetchAntigravityUsage(async () => { resolved++; return auth; }, new AbortController().signal, async (input, init) => {
    url = String(input); body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers); assert.equal(headers.get("Authorization"), "Bearer access-secret");
    assert.ok(!headers.get("User-Agent")?.includes("1.1.24"));
    return Response.json(quota());
  });
  assert.equal(resolved, 1); assert.equal(result.gemini?.fiveHour?.remainingPercent, 75);
  assert.equal(url, `${ANTIGRAVITY_ENDPOINT}/v1internal:retrieveUserQuotaSummary`);
  assert.equal(body.project, "managed-project");
});
test("missing project is refused rather than querying a made-up quota project", async () => {
  let called = false;
  await assert.rejects(fetchAntigravityUsage(async () => ({ ...auth, refresh: "refresh-secret" }), new AbortController().signal, async () => { called = true; return Response.json(quota()); }), /Missing/);
  assert.equal(called, false);
});
test("HTTP errors do not leak response payload or invoke an unsafe refresh", async () => {
  let calls = 0;
  await assert.rejects(fetchAntigravityUsage(async () => auth, new AbortController().signal, async () => { calls++; return new Response("access-secret", { status: 401 }); }), /rejected the current sign-in/);
  assert.equal(calls, 1);
});
test("transport errors redact credentials", async () => {
  await assert.rejects(fetchAntigravityUsage(async () => auth, new AbortController().signal, async () => { throw new Error("access-secret refresh-secret"); }), error => error instanceof Error && !error.message.includes("access-secret") && !error.message.includes("refresh-secret"));
});
test("cancelled quota reads do not resolve auth or perform a network request", async () => {
  let calls = 0;
  await assert.rejects(fetchAntigravityUsage(async () => { calls++; return auth; }, AbortSignal.abort()));
  assert.equal(calls, 0);
});
test("account cache keys are non-secret and use managed identity", () => {
  assert.equal(quotaAccount(auth), "managed-project");
  assert.equal(quotaAccount({ ...auth, refresh: "secret|base" }), "base");
});
