import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export interface QuotaBucket {
    window: "5h" | "weekly" | string;
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
export default function piAntigravityUsage(pi: ExtensionAPI): void;
