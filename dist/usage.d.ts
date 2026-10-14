import type { OAuthCredentials } from "@earendil-works/pi-ai";
export interface QuotaBucket {
    window: string;
    usedPercent: number;
    remainingPercent: number;
    resetMs: number;
    resetsIn: string;
}
export interface QuotaGroup {
    displayName: string;
    key: "gemini" | "claudeGpt";
    fiveHour?: QuotaBucket;
    weekly?: QuotaBucket;
}
export interface AntigravityUsageData {
    email?: string;
    gemini?: QuotaGroup;
    claudeGpt?: QuotaGroup;
    rawDescription?: string;
    _ts: number;
}
export declare function quotaAccount(cred?: OAuthCredentials | null): string | undefined;
export declare function parseBucket(raw: unknown): QuotaBucket | undefined;
export declare function parseQuota(payload: unknown, email?: string): AntigravityUsageData;
export declare function fetchAntigravityUsage(resolveAuth: () => Promise<OAuthCredentials>, signal: AbortSignal, fetcher?: typeof fetch): Promise<AntigravityUsageData>;
