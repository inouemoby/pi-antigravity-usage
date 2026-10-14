import { ANTIGRAVITY_ENDPOINT, buildAntigravityHarnessBootstrapHeaders, buildAntigravityLoadCodeAssistMetadata, parseRefreshParts, redactCredentialText } from "@cortexkit/antigravity-auth-core";
import type { OAuthCredentials } from "@earendil-works/pi-ai";

export interface QuotaBucket {
  window: string; usedPercent: number; remainingPercent: number; resetMs: number; resetsIn: string;
}
export interface QuotaGroup {
  displayName: string; key: "gemini" | "claudeGpt"; fiveHour?: QuotaBucket; weekly?: QuotaBucket;
}
export interface AntigravityUsageData {
  email?: string; gemini?: QuotaGroup; claudeGpt?: QuotaGroup; rawDescription?: string; _ts: number;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const humanDuration = (ms: number): string => {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};
export function quotaAccount(cred?: OAuthCredentials | null): string | undefined {
  if (!cred) return;
  const parts = parseRefreshParts(cred.refresh);
  const project = parts.managedProjectId || parts.projectId;
  const email = typeof cred.email === "string" ? cred.email.toLowerCase() : undefined;
  return project ? `${email ? `${email}|` : ""}${project}` : email;
}
export function parseBucket(raw: unknown): QuotaBucket | undefined {
  if (!record(raw)) return;
  const hint = `${raw.window ?? ""} ${raw.bucketId ?? ""} ${raw.displayName ?? ""}`.toLowerCase();
  const window = /5h|five\s*hour|5\s*hour/.test(hint) ? "5h" : /weekly|week/.test(hint) ? "weekly" : String(raw.window ?? "");
  const fraction = typeof raw.remainingFraction === "number" ? raw.remainingFraction : typeof raw.remainingPercent === "number" ? raw.remainingPercent / 100 : typeof raw.remainingPercentage === "number" ? raw.remainingPercentage / 100 : undefined;
  if (fraction === undefined || !Number.isFinite(fraction) || !window) return;
  const remaining = Math.max(0, Math.min(1, fraction));
  const reset = raw.resetTime ?? raw.resetAt ?? raw.reset;
  const resetMs = typeof reset === "string" || typeof reset === "number" ? new Date(reset).getTime() : 0;
  return { window, usedPercent: +((1 - remaining) * 100).toFixed(1), remainingPercent: +(remaining * 100).toFixed(1), resetMs: Number.isFinite(resetMs) ? resetMs : 0, resetsIn: resetMs ? humanDuration(resetMs - Date.now()) : "unknown" };
}
export function parseQuota(payload: unknown, email?: string): AntigravityUsageData {
  if (!record(payload) || !Array.isArray(payload.groups)) throw new Error("Google returned an invalid Antigravity quota response");
  const data: AntigravityUsageData = { email, _ts: Date.now() };
  for (const raw of payload.groups) {
    if (!record(raw)) continue;
    const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
    const name = String(raw.displayName ?? raw.name ?? "");
    const hint = `${name} ${raw.description ?? ""} ${buckets.filter(record).map(b => `${b.bucketId ?? ""} ${b.displayName ?? ""}`).join(" ")}`;
    const key = /claude|gpt|3p/i.test(hint) ? "claudeGpt" : /gemini/i.test(hint) ? "gemini" : undefined;
    if (!key) continue;
    const group: QuotaGroup = { displayName: name, key };
    for (const b of buckets) {
      const parsed = parseBucket(b);
      if (parsed?.window === "5h") group.fiveHour = parsed;
      if (parsed?.window === "weekly") group.weekly = parsed;
    }
    if (group.fiveHour || group.weekly) data[key] = group;
  }
  if (!data.gemini && !data.claudeGpt) throw new Error("Google returned no recognizable Antigravity quota buckets");
  if (typeof payload.description === "string") data.rawDescription = payload.description;
  return data;
}

export async function fetchAntigravityUsage(resolveAuth: () => Promise<OAuthCredentials>, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<AntigravityUsageData> {
  signal.throwIfAborted();
  const credential = await resolveAuth(); // Pi owns refresh, locking and persistence.
  signal.throwIfAborted();
  const parts = parseRefreshParts(credential.refresh);
  const project = parts.managedProjectId || parts.projectId;
  if (!project || !credential.access) throw new Error("Missing Antigravity login/project; use /login google-antigravity");
  try {
    // Same current consumer gateway and identity as the provider. Never silently
    // substitute another project's quota or an enterprise/sandbox quota view.
    const response = await fetcher(`${ANTIGRAVITY_ENDPOINT}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST", headers: { ...buildAntigravityHarnessBootstrapHeaders(credential.access), "Content-Type": "application/json", "Client-Metadata": JSON.stringify(buildAntigravityLoadCodeAssistMetadata()) },
      body: JSON.stringify({ project }), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 ? "Google rejected the current sign-in; use /login google-antigravity" : `Antigravity quota HTTP ${response.status}`);
    }
    return parseQuota(await response.json(), typeof credential.email === "string" ? credential.email : undefined);
  } catch (error) {
    throw new Error(redactCredentialText(error instanceof Error ? error.message : String(error), [credential.access, credential.refresh, parts.refreshToken]));
  }
}
