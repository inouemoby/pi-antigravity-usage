// src/index.ts
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { refreshAntigravityToken } from "@cortexkit/antigravity-auth-core";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
var PROVIDER_ID = "google-antigravity";
var CACHE_MS = 6e4;
var IDLE_REFRESH_MS = 5 * 60 * 1e3;
var FIVE_HOUR_MS = 5 * 60 * 60 * 1e3;
var WEEK_MS = 7 * 24 * 60 * 60 * 1e3;
var REFRESH_MARGIN_MS = 60 * 1e3;
var ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com"
];
function humanDuration(untilMs) {
  if (untilMs <= 0) return "now";
  const m = Math.floor(untilMs / 6e4);
  const d = Math.floor(m / 1440);
  const h = Math.floor(m % 1440 / 60);
  const mins = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
}
function formatTokens(count) {
  if (count < 1e3) return String(count);
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}
function usageSeverity(usedPct, windowMs, resetMs) {
  if (resetMs <= 0) return 0;
  const remainingMs = resetMs - Date.now();
  const elapsedMs = Math.max(0, windowMs - remainingMs);
  const elapsedRatio = elapsedMs / windowMs;
  const expectedPct = elapsedRatio * 100;
  if (usedPct >= 100) return 2;
  if (usedPct > expectedPct * 1.5) return 2;
  if (usedPct > expectedPct) return 1;
  return 0;
}
function getPiAuthPath() {
  const home = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi/agent");
  return path.resolve(home, "auth.json");
}
function readAuth() {
  try {
    const cred = readStoredCredential(PROVIDER_ID);
    if (cred?.type === "oauth" && cred.access && cred.refresh) {
      return cred;
    }
  } catch {
  }
  try {
    const p = getPiAuthPath();
    if (fs.existsSync(p)) {
      const all = JSON.parse(fs.readFileSync(p, "utf-8"));
      const cred = all[PROVIDER_ID];
      if (cred?.type === "oauth" && cred.access && cred.refresh) {
        return cred;
      }
    }
  } catch {
  }
  return null;
}
function writeBackAuth(cred) {
  try {
    const p = getPiAuthPath();
    if (!fs.existsSync(p)) return;
    const all = JSON.parse(fs.readFileSync(p, "utf-8"));
    all[PROVIDER_ID] = {
      ...all[PROVIDER_ID],
      ...cred
    };
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf-8");
    fs.renameSync(tmp, p);
  } catch {
  }
}
var _refreshPromise = null;
async function ensureFreshAuth(cred) {
  const now = Date.now();
  const expires = cred.expires ?? 0;
  if (expires > 0 && now < expires - REFRESH_MARGIN_MS) {
    return cred;
  }
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const refreshStr = cred.refresh || "";
      const rawRefresh = refreshStr.split("|")[0];
      if (!rawRefresh) return cred;
      const next = await refreshAntigravityToken(rawRefresh);
      const suffix = refreshStr.includes("|") ? refreshStr.slice(refreshStr.indexOf("|")) : "";
      const updated = {
        ...cred,
        access: next.access,
        refresh: `${next.refresh}${suffix}`,
        expires: next.expires
      };
      writeBackAuth(updated);
      return updated;
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}
function parseBucket(b) {
  if (!b || typeof b.remainingFraction !== "number") return void 0;
  const remainingFraction = Math.max(0, Math.min(1, b.remainingFraction));
  const remainingPercent = +(remainingFraction * 100).toFixed(1);
  const usedPercent = +((1 - remainingFraction) * 100).toFixed(1);
  const resetMs = b.resetTime ? new Date(b.resetTime).getTime() : 0;
  const window = b.window === "5h" ? "5h" : b.window === "weekly" ? "weekly" : String(b.window || "");
  return {
    window,
    usedPercent,
    remainingPercent,
    resetMs,
    resetsIn: resetMs > 0 ? humanDuration(resetMs - Date.now()) : "unknown"
  };
}
async function fetchAntigravityUsage() {
  const rawCred = readAuth();
  if (!rawCred || !rawCred.access || !rawCred.refresh) {
    throw new Error("No Google Antigravity credentials found. Run /login to authenticate.");
  }
  const cred = await ensureFreshAuth(rawCred);
  const project = (cred.refresh || "").split("|")[1] || "aicode-consumers";
  const headers = {
    Authorization: `Bearer ${cred.access}`,
    "Content-Type": "application/json",
    "User-Agent": "antigravity/cli/1.1.24 (aidev_client; os_type=windows; arch=amd64; cl=974782877; auth_method=consumer)",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY" })
  };
  let lastError;
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers,
        body: JSON.stringify({ project }),
        signal: AbortSignal.timeout(8e3)
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        continue;
      }
      const data = await res.json();
      let geminiGroup;
      let claudeGptGroup;
      for (const g of data.groups || []) {
        const name = String(g.displayName || "");
        const isGemini = /gemini/i.test(name) || /gemini/i.test(String(g.description || ""));
        const isClaudeGpt = /claude|gpt|3p/i.test(name) || /claude|gpt/i.test(String(g.description || ""));
        const group = {
          displayName: name,
          key: isClaudeGpt ? "claudeGpt" : "gemini"
        };
        for (const b of g.buckets || []) {
          const parsed = parseBucket(b);
          if (!parsed) continue;
          if (parsed.window === "5h") group.fiveHour = parsed;
          else if (parsed.window === "weekly") group.weekly = parsed;
        }
        if (isClaudeGpt) claudeGptGroup = group;
        else if (isGemini) geminiGroup = group;
      }
      return {
        email: cred.email,
        gemini: geminiGroup,
        claudeGpt: claudeGptGroup,
        rawDescription: data.description,
        _ts: Date.now()
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError || new Error("Failed to fetch Antigravity quota from Google");
}
function piAntigravityUsage(pi) {
  let usage = null;
  let usagePromise = null;
  let footerOn = false;
  let _tui = null;
  let latestCtx = null;
  let agentBusy = false;
  let thinkingLevel = "off";
  let idleTimer = null;
  function isAntigravity(ctx) {
    return ctx?.model?.provider === PROVIDER_ID;
  }
  function getActivePool(modelId) {
    const id = (modelId || "").toLowerCase();
    if (id.startsWith("claude") || id.startsWith("gpt-oss")) return "claudeGpt";
    return "gemini";
  }
  async function getUsage(force = false) {
    if (!force && usage && Date.now() - usage._ts < CACHE_MS) {
      return usage;
    }
    if (usagePromise) return usagePromise;
    usagePromise = fetchAntigravityUsage().then((data) => {
      usage = data;
      return data;
    }).finally(() => {
      usagePromise = null;
    });
    return usagePromise;
  }
  function trigger() {
    setTimeout(() => {
      try {
        _tui?.requestRender?.();
      } catch {
      }
    }, 0);
  }
  async function refresh(ctx) {
    if (!isAntigravity(ctx)) {
      if (usage) {
        usage = null;
        toggleFooter(ctx);
      }
      return;
    }
    try {
      await getUsage();
      trigger();
    } catch {
    }
  }
  function toggleFooter(ctx) {
    if (isAntigravity(ctx) && readAuth()) {
      if (!footerOn) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else {
      if (footerOn) {
        _tui = null;
        ctx.ui.setFooter(void 0);
        footerOn = false;
      }
    }
  }
  function buildFooter(ctx) {
    return (tui, theme, fd) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => tui.requestRender());
      return {
        dispose: () => {
          unsub();
          _tui = null;
          footerOn = false;
        },
        invalidate() {
        },
        render(width) {
          const sm = ctx.sessionManager;
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm?.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd?.getGitBranch?.();
          if (branch) pwd += ` (${branch})`;
          const sname = sm?.getSessionName?.();
          if (sname) pwd += ` \u2022 ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm?.getEntries?.() || []) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = e.message.usage;
              if (u) {
                ti += u.input || 0;
                to += u.output || 0;
                tr += u.cacheRead || 0;
                tw += u.cacheWrite || 0;
                tc += u.cost?.total || 0;
              }
            }
          }
          const parts = [];
          const cachePartIndexes = [];
          let costPartIndex = -1;
          if (ti) parts.push(`\u2191${formatTokens(ti)}`);
          if (to) parts.push(`\u2193${formatTokens(to)}`);
          if (tr) {
            cachePartIndexes.push(parts.length);
            parts.push(`R${formatTokens(tr)}`);
          }
          if (tw) {
            cachePartIndexes.push(parts.length);
            parts.push(`W${formatTokens(tw)}`);
          }
          if (tc) {
            costPartIndex = parts.length;
            parts.push(`$${tc.toFixed(3)}`);
          }
          const cu = ctx.getContextUsage?.();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== void 0 ? raw.toFixed(1) : "?";
          let cpStr;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);
          let usageFull = "";
          let usageNoPrefix = "";
          let usageIdx = -1;
          if (usage) {
            const pool = getActivePool(ctx.model?.id);
            const grp = pool === "claudeGpt" ? usage.claudeGpt : usage.gemini;
            if (grp) {
              const uParts = [];
              if (grp.fiveHour) {
                const sev = usageSeverity(grp.fiveHour.usedPercent, FIVE_HOUR_MS, grp.fiveHour.resetMs);
                const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
                uParts.push(`${flag}5h:${grp.fiveHour.usedPercent.toFixed(1)}%`);
              }
              if (grp.weekly) {
                const sev = usageSeverity(grp.weekly.usedPercent, WEEK_MS, grp.weekly.resetMs);
                const flag = sev === 2 ? "!!" : sev === 1 ? "!" : "";
                uParts.push(`${flag}Wk:${grp.weekly.usedPercent.toFixed(1)}%`);
              }
              if (uParts.length > 0) {
                const poolTag = pool === "claudeGpt" ? "[Claude] " : "";
                usageFull = `${poolTag}${uParts.join(" ")}`;
                usageNoPrefix = uParts.join(" ");
                usageIdx = parts.length;
                parts.push(usageFull);
              }
            }
          }
          let left = parts.join(" ");
          const m = ctx.model;
          let modelText = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            modelText = tl === "off" ? `${modelText} \u2022 thinking off` : `${modelText} \u2022 ${tl}`;
          }
          const withProvider = m ? `(${m.provider}) ${modelText}` : modelText;
          let right = withProvider;
          if (visibleWidth(left) + 2 + visibleWidth(right) > width) {
            right = modelText;
          }
          const fits = () => visibleWidth(left) + 2 + visibleWidth(right) <= width;
          if (!fits() && usageIdx >= 0 && usageNoPrefix !== usageFull) {
            parts[usageIdx] = usageNoPrefix;
            left = parts.join(" ");
          }
          if (!fits()) {
            for (const idx of cachePartIndexes) parts[idx] = "";
            left = parts.filter(Boolean).join(" ");
          }
          if (!fits() && costPartIndex >= 0) {
            parts[costPartIndex] = "";
            left = parts.filter(Boolean).join(" ");
          }
          const lw = visibleWidth(left);
          const rw = visibleWidth(right);
          let ln2;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }
          return [ln1, theme.fg("dim", ln2)];
        }
      };
    };
  }
  function startIdleTimer() {
    stopIdleTimer();
    idleTimer = setInterval(async () => {
      if (agentBusy) return;
      const ctx = latestCtx;
      if (!ctx || !isAntigravity(ctx)) return;
      try {
        await getUsage();
        trigger();
      } catch {
      }
    }, IDLE_REFRESH_MS);
    idleTimer.unref?.();
  }
  function stopIdleTimer() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }
  pi.on("session_start", async (_e, ctx) => {
    latestCtx = ctx;
    thinkingLevel = pi.getThinkingLevel?.() || "off";
    footerOn = false;
    toggleFooter(ctx);
    if (readAuth()) refresh(ctx);
    startIdleTimer();
  });
  pi.on("session_shutdown", async () => {
    stopIdleTimer();
  });
  pi.on("agent_start", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = true;
  });
  pi.on("agent_end", async (_e, ctx) => {
    latestCtx = ctx;
    agentBusy = false;
    if (readAuth()) refresh(ctx);
  });
  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (isAntigravity(ctx)) {
      setTimeout(() => {
        toggleFooter(ctx);
        if (readAuth()) refresh(ctx);
      }, 0);
    } else {
      toggleFooter(ctx);
      if (readAuth()) refresh(ctx);
    }
  });
  pi.on("thinking_level_select", async (event) => {
    thinkingLevel = event?.level || "off";
    trigger();
  });
  const showUsageDialog = async (ctx) => {
    try {
      const d = await getUsage(true);
      const bar = (pct) => {
        const p = Math.max(0, Math.min(100, pct));
        const filled = Math.round(p / 5);
        return "\u2588".repeat(filled) + "\u2591".repeat(20 - filled);
      };
      const lines = ["\u2550\u2550 Google Antigravity Usage \u2550\u2550"];
      if (d.email) lines.push(`Account: ${d.email}`);
      if (d.gemini) {
        lines.push("");
        lines.push(`\u25B8 ${d.gemini.displayName} (Flash, Pro):`);
        if (d.gemini.fiveHour) {
          const b = d.gemini.fiveHour;
          lines.push(`  5h   [${bar(b.usedPercent)}]  ${b.usedPercent.toFixed(1)}% used (${b.remainingPercent.toFixed(1)}% left)  resets in ${b.resetsIn}`);
        }
        if (d.gemini.weekly) {
          const b = d.gemini.weekly;
          lines.push(`  Wk   [${bar(b.usedPercent)}]  ${b.usedPercent.toFixed(1)}% used (${b.remainingPercent.toFixed(1)}% left)  resets in ${b.resetsIn}`);
        }
      }
      if (d.claudeGpt) {
        lines.push("");
        lines.push(`\u25B8 ${d.claudeGpt.displayName} (Sonnet, Opus, GPT-OSS):`);
        if (d.claudeGpt.fiveHour) {
          const b = d.claudeGpt.fiveHour;
          lines.push(`  5h   [${bar(b.usedPercent)}]  ${b.usedPercent.toFixed(1)}% used (${b.remainingPercent.toFixed(1)}% left)  resets in ${b.resetsIn}`);
        }
        if (d.claudeGpt.weekly) {
          const b = d.claudeGpt.weekly;
          lines.push(`  Wk   [${bar(b.usedPercent)}]  ${b.usedPercent.toFixed(1)}% used (${b.remainingPercent.toFixed(1)}% left)  resets in ${b.resetsIn}`);
        }
      }
      lines.push("");
      lines.push(`(Refreshed at: ${new Date(d._ts).toLocaleTimeString()})`);
      ctx.ui.notify(lines.join("\n"), "info");
    } catch (err) {
      ctx.ui.notify(`Antigravity Usage: ${err.message}`, "error");
    }
  };
  pi.registerCommand("antigravity-usage", {
    description: "Show Google Antigravity subscription usage and remaining limits",
    handler: async (_args, ctx) => showUsageDialog(ctx)
  });
  pi.registerCommand("antigravity", {
    description: "Show Google Antigravity subscription usage (alias for /antigravity-usage)",
    handler: async (_args, ctx) => showUsageDialog(ctx)
  });
  pi.registerTool({
    name: "antigravity_usage",
    label: "Antigravity Usage",
    description: "Get current Google Antigravity / Google AI plan quota and usage status.",
    parameters: Type.Object({}),
    async execute() {
      try {
        const d = await getUsage();
        const formatBucket = (b) => b ? {
          usedPercent: b.usedPercent,
          remainingPercent: b.remainingPercent,
          resetsIn: b.resetsIn,
          resetTime: new Date(b.resetMs).toISOString()
        } : null;
        const result = {
          gemini: d.gemini ? {
            fiveHour: formatBucket(d.gemini.fiveHour),
            weekly: formatBucket(d.gemini.weekly)
          } : null,
          claudeAndGpt: d.claudeGpt ? {
            fiveHour: formatBucket(d.claudeGpt.fiveHour),
            weekly: formatBucket(d.claudeGpt.weekly)
          } : null,
          refreshedAt: new Date(d._ts).toISOString()
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], details: void 0, isError: true };
      }
    }
  });
}
export {
  piAntigravityUsage as default
};
//# sourceMappingURL=index.js.map
