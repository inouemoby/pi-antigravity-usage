// src/index.ts
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// src/usage.ts
import { ANTIGRAVITY_ENDPOINT, buildAntigravityHarnessBootstrapHeaders, buildAntigravityLoadCodeAssistMetadata, parseRefreshParts, redactCredentialText } from "@cortexkit/antigravity-auth-core";
var record = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var humanDuration = (ms) => {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 6e4), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};
function quotaAccount(cred) {
  if (!cred) return;
  const parts = parseRefreshParts(cred.refresh);
  const project = parts.managedProjectId || parts.projectId;
  const email = typeof cred.email === "string" ? cred.email.toLowerCase() : void 0;
  return project ? `${email ? `${email}|` : ""}${project}` : email;
}
function parseBucket(raw) {
  if (!record(raw)) return;
  const hint = `${raw.window ?? ""} ${raw.bucketId ?? ""} ${raw.displayName ?? ""}`.toLowerCase();
  const window = /5h|five\s*hour|5\s*hour/.test(hint) ? "5h" : /weekly|week/.test(hint) ? "weekly" : String(raw.window ?? "");
  const fraction = typeof raw.remainingFraction === "number" ? raw.remainingFraction : typeof raw.remainingPercent === "number" ? raw.remainingPercent / 100 : typeof raw.remainingPercentage === "number" ? raw.remainingPercentage / 100 : void 0;
  if (fraction === void 0 || !Number.isFinite(fraction) || !window) return;
  const remaining = Math.max(0, Math.min(1, fraction));
  const reset = raw.resetTime ?? raw.resetAt ?? raw.reset;
  const resetMs = typeof reset === "string" || typeof reset === "number" ? new Date(reset).getTime() : 0;
  return { window, usedPercent: +((1 - remaining) * 100).toFixed(1), remainingPercent: +(remaining * 100).toFixed(1), resetMs: Number.isFinite(resetMs) ? resetMs : 0, resetsIn: resetMs ? humanDuration(resetMs - Date.now()) : "unknown" };
}
function parseQuota(payload, email) {
  if (!record(payload) || !Array.isArray(payload.groups)) throw new Error("Google returned an invalid Antigravity quota response");
  const data = { email, _ts: Date.now() };
  for (const raw of payload.groups) {
    if (!record(raw)) continue;
    const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
    const name = String(raw.displayName ?? raw.name ?? "");
    const hint = `${name} ${raw.description ?? ""} ${buckets.filter(record).map((b) => `${b.bucketId ?? ""} ${b.displayName ?? ""}`).join(" ")}`;
    const key = /claude|gpt|3p/i.test(hint) ? "claudeGpt" : /gemini/i.test(hint) ? "gemini" : void 0;
    if (!key) continue;
    const group = { displayName: name, key };
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
async function fetchAntigravityUsage(resolveAuth, signal, fetcher = fetch) {
  signal.throwIfAborted();
  const credential = await resolveAuth();
  signal.throwIfAborted();
  const parts = parseRefreshParts(credential.refresh);
  const project = parts.managedProjectId || parts.projectId;
  if (!project || !credential.access) throw new Error("Missing Antigravity login/project; use /login google-antigravity");
  try {
    const response = await fetcher(`${ANTIGRAVITY_ENDPOINT}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers: { ...buildAntigravityHarnessBootstrapHeaders(credential.access), "Content-Type": "application/json", "Client-Metadata": JSON.stringify(buildAntigravityLoadCodeAssistMetadata()) },
      body: JSON.stringify({ project }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(8e3)])
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 ? "Google rejected the current sign-in; use /login google-antigravity" : `Antigravity quota HTTP ${response.status}`);
    }
    return parseQuota(await response.json(), typeof credential.email === "string" ? credential.email : void 0);
  } catch (error) {
    throw new Error(redactCredentialText(error instanceof Error ? error.message : String(error), [credential.access, credential.refresh, parts.refreshToken]));
  }
}

// src/index.ts
var PROVIDER_ID = "google-antigravity";
var CACHE_MS = 6e4;
var IDLE_REFRESH_MS = 5 * 60 * 1e3;
var FIVE_HOUR_MS = 5 * 60 * 60 * 1e3;
var WEEK_MS = 7 * 24 * 60 * 60 * 1e3;
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
function readAuth() {
  const credential = readStoredCredential(PROVIDER_ID);
  return credential?.type === "oauth" ? credential : null;
}
function piAntigravityUsage(pi) {
  const lifetime = new AbortController();
  let usageAccount;
  let pendingAccount;
  let usage = null;
  let usageError = null;
  let usagePromise = null;
  let footerOn = false;
  let footerGeneration = 0;
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
    if (process.env.PI_OFFLINE !== void 0) throw new Error("Quota refresh is disabled in Pi offline mode");
    const account = quotaAccount(readAuth());
    if (!account) throw new Error("No Antigravity account/project; use /login google-antigravity");
    if (account !== usageAccount) {
      usage = null;
      usageError = null;
      usageAccount = account;
    }
    if (!force && usage && Date.now() - usage._ts < CACHE_MS) return usage;
    if (usagePromise && pendingAccount === account) return usagePromise;
    const requestCtx = latestCtx;
    if (!requestCtx?.modelRegistry) throw new Error("Pi model registry is unavailable");
    const promise = fetchAntigravityUsage(async () => {
      const resolved = await requestCtx.modelRegistry.getProviderAuth(PROVIDER_ID);
      const credential = readAuth();
      if (!resolved?.auth.apiKey || !credential || credential.access !== resolved.auth.apiKey || quotaAccount(credential) !== account) {
        throw new Error("Antigravity account changed or is unavailable; retry after signing in");
      }
      return credential;
    }, lifetime.signal).then((data) => {
      if (quotaAccount(readAuth()) !== account) throw new Error("Antigravity account changed during quota refresh");
      usage = data;
      return data;
    }).finally(() => {
      if (usagePromise === promise) usagePromise = null;
    });
    pendingAccount = account;
    usagePromise = promise;
    return promise;
  }
  function requestRenderSafe(tui) {
    try {
      tui?.requestRender?.();
    } catch {
    }
  }
  function trigger() {
    setTimeout(() => requestRenderSafe(_tui), 0);
  }
  async function refresh(ctx) {
    if (!isAntigravity(ctx)) {
      usage = null;
      usageError = null;
      toggleFooter(ctx);
      return;
    }
    try {
      await getUsage();
      usageError = null;
      trigger();
    } catch (err) {
      usageError = err instanceof Error ? err.message : String(err);
      trigger();
    }
  }
  function toggleFooter(ctx, force = false) {
    if (ctx?.mode !== "tui") return;
    if (isAntigravity(ctx) && readAuth()) {
      if (!footerOn || force) {
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
    const generation = ++footerGeneration;
    return (tui, theme, fd) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => {
        if (generation === footerGeneration) requestRenderSafe(tui);
      });
      return {
        dispose: () => {
          try {
            unsub();
          } catch {
          }
          if (generation === footerGeneration) {
            _tui = null;
            footerOn = false;
          }
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
          if (usageError && usage) parts.push("AG:? (stale)");
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
              } else if (usageError) {
                usageIdx = parts.length;
                usageFull = "AG:?";
                usageNoPrefix = usageFull;
                parts.push(usageFull);
              }
            } else if (usageError) {
              usageIdx = parts.length;
              usageFull = "AG:?";
              usageNoPrefix = usageFull;
              parts.push(usageFull);
            }
          } else if (usageError) {
            usageIdx = parts.length;
            usageFull = "AG:?";
            usageNoPrefix = usageFull;
            parts.push(usageFull);
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
    if (latestCtx?.mode !== "tui" || process.env.PI_OFFLINE !== void 0) return;
    idleTimer = setInterval(async () => {
      if (agentBusy) return;
      const ctx = latestCtx;
      if (!ctx || !isAntigravity(ctx)) return;
      try {
        await getUsage();
        trigger();
      } catch (error) {
        usageError = error instanceof Error ? error.message : String(error);
        trigger();
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
    toggleFooter(ctx, true);
    if (readAuth()) refresh(ctx);
    startIdleTimer();
  });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    stopIdleTimer();
    latestCtx = null;
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
        const currentCtx = latestCtx;
        if (!currentCtx || !isAntigravity(currentCtx)) return;
        try {
          toggleFooter(currentCtx, true);
          if (readAuth()) refresh(currentCtx);
        } catch {
        }
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
      latestCtx = ctx;
      const d = await getUsage(true);
      usageError = null;
      trigger();
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
  pi.registerCommand("antigravity", {
    description: "Show Google Antigravity subscription usage and remaining limits",
    handler: async (_args, ctx) => showUsageDialog(ctx)
  });
}
export {
  piAntigravityUsage as default
};
//# sourceMappingURL=index.js.map
