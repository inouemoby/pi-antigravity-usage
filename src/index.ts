import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { fetchAntigravityUsage, quotaAccount, type AntigravityUsageData } from "./usage.ts";
export type { QuotaBucket, QuotaGroup, AntigravityUsageData } from "./usage.ts";

// ─── Constants ───────────────────────────────────────────────────
const PROVIDER_ID = "google-antigravity";
const CACHE_MS = 60_000;
const IDLE_REFRESH_MS = 30 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

function usageSeverity(usedPct: number, windowMs: number, resetMs: number): number {
  if (resetMs <= 0) return 0;
  const remainingMs = resetMs - Date.now();
  const elapsedMs = Math.max(0, windowMs - remainingMs);
  const elapsedRatio = elapsedMs / windowMs;
  const expectedPct = elapsedRatio * 100;

  if (usedPct > expectedPct * 1.5) return 2;
  if (usedPct > expectedPct) return 1;
  return 0;
}

// Authentication is resolved through Pi; this extension never writes auth.json.
function readAuth(): OAuthCredentials | null {
  const credential = readStoredCredential(PROVIDER_ID);
  return credential?.type === "oauth" ? credential : null;
}

// ─── Main Plugin Definition ──────────────────────────────────────
export default function piAntigravityUsage(pi: ExtensionAPI): void {
  const lifetime = new AbortController();
  let usageAccount: string | undefined;
  let pendingAccount: string | undefined;
  let usage: AntigravityUsageData | null = null;
  let usageError: string | null = null;
  let usagePromise: Promise<AntigravityUsageData> | null = null;
  let footerOn = false;
  let footerGeneration = 0;
  let _tui: any = null;
  let latestCtx: any = null;
  let agentBusy = false;
  let thinkingLevel = "off";
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function isAntigravity(ctx: any): boolean {
    return ctx?.model?.provider === PROVIDER_ID;
  }

  function getActivePool(modelId?: string): "gemini" | "claudeGpt" {
    const id = (modelId || "").toLowerCase();
    if (id.startsWith("claude") || id.startsWith("gpt-oss")) return "claudeGpt";
    return "gemini";
  }

  async function getUsage(force = false): Promise<AntigravityUsageData> {
    if (process.env.PI_OFFLINE !== undefined) throw new Error("Quota refresh is disabled in Pi offline mode");
    const account = quotaAccount(readAuth());
    if (!account) throw new Error("No Antigravity account/project; use /login google-antigravity");
    if (account !== usageAccount) { usage = null; usageError = null; usageAccount = account; }
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
    }, lifetime.signal).then(data => {
      if (quotaAccount(readAuth()) !== account) throw new Error("Antigravity account changed during quota refresh");
      usage = data; return data;
    }).finally(() => { if (usagePromise === promise) usagePromise = null; });
    pendingAccount = account; usagePromise = promise;
    return promise;
  }

  function requestRenderSafe(tui: any): void {
    try { tui?.requestRender?.(); } catch { /* footer may already be disposed */ }
  }

  function trigger() {
    setTimeout(() => requestRenderSafe(_tui), 0);
  }

  async function refresh(ctx: any) {
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

  function toggleFooter(ctx: any, force = false) {
    if (ctx?.mode !== "tui") return;
    if (isAntigravity(ctx) && readAuth()) {
      if (!footerOn || force) {
        ctx.ui.setFooter(buildFooter(ctx));
        footerOn = true;
      }
    } else {
      if (footerOn) {
        _tui = null;
        ctx.ui.setFooter(undefined as any);
        footerOn = false;
      }
    }
  }

  function buildFooter(ctx: any) {
    const generation = ++footerGeneration;
    return (tui: any, theme: any, fd: any) => {
      _tui = tui;
      const unsub = fd.onBranchChange(() => {
        if (generation === footerGeneration) requestRenderSafe(tui);
      });

      return {
        dispose: () => {
          try { unsub(); } catch { /* already disposed */ }
          if (generation === footerGeneration) {
            _tui = null;
            footerOn = false;
          }
        },
        invalidate() {},
        render(width: number): string[] {
          const sm = ctx.sessionManager;

          // ── Line 1: pwd ──
          const home = process.env.HOME || process.env.USERPROFILE || "";
          let pwd = ctx.cwd || sm?.getCwd?.() || "";
          if (home && pwd.startsWith(home)) pwd = "~" + pwd.slice(home.length);
          const branch = fd?.getGitBranch?.();
          if (branch) pwd += ` (${branch})`;
          const sname = sm?.getSessionName?.();
          if (sname) pwd += ` • ${sname}`;
          const ln1 = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

          // ── Line 2: stats ──
          let ti = 0, to = 0, tr = 0, tw = 0, tc = 0;
          for (const e of sm?.getEntries?.() || []) {
            if (e.type === "message" && e.message?.role === "assistant") {
              const u = (e.message as AssistantMessage).usage;
              if (u) {
                ti += u.input || 0;
                to += u.output || 0;
                tr += u.cacheRead || 0;
                tw += u.cacheWrite || 0;
                tc += u.cost?.total || 0;
              }
            }
          }

          const parts: string[] = [];
          const cachePartIndexes: number[] = [];
          const tokenPartIndexes: number[] = [];
          let costPartIndex = -1;

          if (ti) { tokenPartIndexes.push(parts.length); parts.push(`↑${formatTokens(ti)}`); }
          if (to) { tokenPartIndexes.push(parts.length); parts.push(`↓${formatTokens(to)}`); }
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

          // Context %
          const cu = ctx.getContextUsage?.();
          const cw = cu?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const raw = cu?.percent;
          const cp = raw !== null && raw !== undefined ? raw.toFixed(1) : "?";
          let cpStr: string;
          if (cp === "?") cpStr = `?/${formatTokens(cw)} (auto)`;
          else if (parseFloat(cp) > 90) cpStr = theme.fg("error", `${cp}%/${formatTokens(cw)} (auto)`);
          else if (parseFloat(cp) > 70) cpStr = theme.fg("warning", `${cp}%/${formatTokens(cw)} (auto)`);
          else cpStr = `${cp}%/${formatTokens(cw)} (auto)`;
          parts.push(cpStr);

          // Antigravity Usage
          let usageFull = "";
          let usageNoPrefix = "";
          let usageIdx = -1;

          if (usageError && usage) parts.push("AG:? (stale)");
          if (usage) {
            const pool = getActivePool(ctx.model?.id);
            const grp = pool === "claudeGpt" ? usage.claudeGpt : usage.gemini;
            if (grp) {
              const uParts: string[] = [];
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
            // Never fail silently: a temporary quota/API problem must be
            // distinguishable from a zero-usage result.
            usageIdx = parts.length;
            usageFull = "AG:?";
            usageNoPrefix = usageFull;
            parts.push(usageFull);
          }

          let left = parts.join(" ");

          // Right side: model & thinking info
          const m = ctx.model;
          let modelText = m?.id || "no-model";
          if (m?.reasoning) {
            const tl = thinkingLevel;
            modelText = tl === "off" ? `${modelText} • thinking off` : `${modelText} • ${tl}`;
          }
          const withProvider = m ? `(${m.provider}) ${modelText}` : modelText;
          let right = withProvider;

          // 省略顺序 (与 pi-codex-usage 一致): 供应商名 → 额度前缀 → 缓存计数 → 费用 → 累计 token
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
          // 累计 token 是最后一个可省略的统计项
          if (!fits() && tokenPartIndexes.length > 0) {
            for (const idx of tokenPartIndexes) parts[idx] = "";
            left = parts.filter(Boolean).join(" ");
          }

          const lw = visibleWidth(left);
          const rw = visibleWidth(right);
          let ln2: string;
          if (lw + 2 + rw <= width) {
            ln2 = left + " ".repeat(width - lw - rw) + right;
          } else if (lw + 2 < width) {
            ln2 = truncateToWidth(left + "  " + right, width, "");
          } else {
            ln2 = truncateToWidth(left, width, "...");
          }

          return [ln1, theme.fg("dim", ln2)];
        },
      };
    };
  }

  // ── Idle Timer ─────────────────────────────────────────────
  function startIdleTimer() {
    stopIdleTimer();
    if (latestCtx?.mode !== "tui" || process.env.PI_OFFLINE !== undefined) return;
    idleTimer = setInterval(async () => {
      if (agentBusy) return;
      const ctx = latestCtx;
      if (!ctx || !isAntigravity(ctx)) return;
      try {
        await getUsage();
        trigger();
      } catch (error) { usageError = error instanceof Error ? error.message : String(error); trigger(); }
    }, IDLE_REFRESH_MS);
    (idleTimer as any).unref?.();
  }

  function stopIdleTimer() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  // ── Events ─────────────────────────────────────────────────
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

  // 每条 assistant 消息结束 (含工具调用轮次) 都尝试刷新一次, 让单轮很长的任务
  // 中途也能及时看到用量变化; 同一个 CACHE_MS 窗口内最多发起一次 (含失败重试), 避免过快
  let lastMidRefreshAt = 0;
  pi.on("message_end", async (event: any, ctx: any) => {
    latestCtx = ctx;
    if (event?.message?.role !== "assistant") return;
    if (!isAntigravity(ctx) || !readAuth()) return;
    const now = Date.now();
    if (now - lastMidRefreshAt < CACHE_MS) return;
    lastMidRefreshAt = now;
    refresh(ctx);
  });

  pi.on("model_select", async (_e, ctx) => {
    latestCtx = ctx;
    if (isAntigravity(ctx)) {
      // Allow previous provider's footer unmount to finish first
      setTimeout(() => {
        const currentCtx = latestCtx;
        if (!currentCtx || !isAntigravity(currentCtx)) return;
        try {
          toggleFooter(currentCtx, true);
          if (readAuth()) refresh(currentCtx);
        } catch { /* session or footer was disposed */ }
      }, 0);
    } else {
      // Vacate immediately so the new provider can mount its footer
      toggleFooter(ctx);
      if (readAuth()) refresh(ctx);
    }
  });

  pi.on("thinking_level_select", async (event: any) => {
    thinkingLevel = event?.level || "off";
    trigger();
  });

  // ── Slash Command /antigravity ────────────────────────────────
  const showUsageDialog = async (ctx: any) => {
    try {
      latestCtx = ctx;
      const d = await getUsage(true);
      usageError = null;
      trigger();
      const bar = (pct: number) => {
        const p = Math.max(0, Math.min(100, pct));
        const filled = Math.round(p / 5);
        return "█".repeat(filled) + "░".repeat(20 - filled);
      };

      const lines = ["══ Google Antigravity Usage ══"];
      if (d.email) lines.push(`Account: ${d.email}`);

      if (d.gemini) {
        lines.push("");
        lines.push(`▸ ${d.gemini.displayName} (Flash, Pro):`);
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
        lines.push(`▸ ${d.claudeGpt.displayName} (Sonnet, Opus, GPT-OSS):`);
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
    } catch (err: any) {
      ctx.ui.notify(`Antigravity Usage: ${err.message}`, "error");
    }
  };

  pi.registerCommand("antigravity", {
    description: "Show Google Antigravity subscription usage and remaining limits",
    handler: async (_args, ctx) => showUsageDialog(ctx),
  });

}
