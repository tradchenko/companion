import type { BackendModelInfo } from "../api.js";

export interface ModelOption {
  value: string;
  label: string;
  icon: string;
}

export interface ModeOption {
  value: string;
  label: string;
}

// ─── Icon assignment for dynamically fetched models ──────────────────────────

const MODEL_ICONS: Record<string, string> = {
  "codex": "\u2733",    // ✳ for codex-optimized models
  "max": "\u25A0",      // ■ for max/flagship
  "mini": "\u26A1",     // ⚡ for mini/fast
};

function pickIcon(slug: string, index: number): string {
  for (const [key, icon] of Object.entries(MODEL_ICONS)) {
    if (slug.includes(key)) return icon;
  }
  const fallback = ["\u25C6", "\u25CF", "\u25D5", "\u2726"]; // ◆ ● ◕ ✦
  return fallback[index % fallback.length];
}

/** Convert server model info to frontend ModelOption with icons. */
export function toModelOptions(models: BackendModelInfo[]): ModelOption[] {
  return models.map((m, i) => ({
    value: m.value,
    label: m.label || m.value,
    icon: pickIcon(m.value, i),
  }));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-opus-4-6", label: "Opus 4.6", icon: "" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", icon: "" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", icon: "" },
];

export const CODEX_MODELS: ModelOption[] = [
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", icon: "\u2733" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", icon: "\u25C6" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Max", icon: "\u25A0" },
  { value: "gpt-5.2", label: "GPT-5.2", icon: "\u25CF" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Mini", icon: "\u26A1" },
];

export const CLAUDE_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Agent" },
  { value: "plan", label: "Plan" },
];

export const CODEX_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Auto" },
  { value: "plan", label: "Plan" },
];

// Agent-specific modes: "plan" is excluded because agents are autonomous
// and cannot wait for human plan approval.
export const CLAUDE_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "acceptEdits", label: "Auto-Edit" },
  { value: "default", label: "Supervised" },
];

export const CODEX_AGENT_MODES: ModeOption[] = [
  { value: "bypassPermissions", label: "Full Auto" },
  { value: "default", label: "Supervised" },
];

// ─── Getters ─────────────────────────────────────────────────────────────────

export function getModelsForBackend(backend: string): ModelOption[] {
  if (backend === "codex") return CODEX_MODELS;
  if (backend === "claude") return CLAUDE_MODELS;
  return []; // ACP — модели загружаются динамически из API
}

export function getModesForBackend(backend: string): ModeOption[] {
  if (backend === "codex") return CODEX_MODES;
  if (backend === "claude") return CLAUDE_MODES;
  // ACP — режимы по умолчанию
  return [
    { value: "bypassPermissions", label: "Auto" },
    { value: "plan", label: "Plan" },
  ];
}

export function getAgentModesForBackend(backend: string): ModeOption[] {
  if (backend === "codex") return CODEX_AGENT_MODES;
  if (backend === "claude") return CLAUDE_AGENT_MODES;
  // ACP — режимы агентов по умолчанию
  return [
    { value: "bypassPermissions", label: "Full Auto" },
    { value: "default", label: "Supervised" },
  ];
}

export function getDefaultModel(backend: string): string {
  if (backend === "codex") return CODEX_MODELS[0].value;
  if (backend === "claude") return CLAUDE_MODELS[0].value;
  return ""; // ACP — будет установлена после загрузки моделей
}

export function getDefaultMode(backend: string): string {
  if (backend === "codex") return CODEX_MODES[0].value;
  return "bypassPermissions";
}

export function getDefaultAgentMode(backend: string): string {
  if (backend === "codex") return CODEX_AGENT_MODES[0].value;
  return CLAUDE_AGENT_MODES[0].value;
}

export function isAcpBackend(backend: string): boolean {
  return backend.startsWith("acp:");
}
