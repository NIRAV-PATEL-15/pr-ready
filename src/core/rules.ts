import type { Lang } from "./types";

export interface RuleInfo {
  id: string;
  lang: Lang;
  description: string;
}

export const CONSOLE_METHODS = [
  "log", "debug", "info", "warn", "error", "trace", "dir", "table", "time", "timeEnd", "group", "groupEnd", "count", "assert",
] as const;
export const JAVA_STREAMS = ["out", "err"] as const;
export const JAVA_PRINT_METHODS = ["print", "println", "printf"] as const;
export const RUST_MACROS = ["println", "print", "eprintln", "eprint", "dbg"] as const;

export const RULES: RuleInfo[] = [
  ...CONSOLE_METHODS.map((m) => ({ id: `console.${m}`, lang: "js" as const, description: `console.${m}(...) calls` })),
  { id: "debugger", lang: "js", description: "debugger statements" },
  ...JAVA_STREAMS.flatMap((s) =>
    JAVA_PRINT_METHODS.map((m) => ({ id: `System.${s}.${m}`, lang: "java" as const, description: `System.${s}.${m}(...) calls` })),
  ),
  { id: "printStackTrace", lang: "java", description: "<expr>.printStackTrace() calls" },
  ...RUST_MACROS.map((m) => ({ id: `${m}!`, lang: "rust" as const, description: `${m}!(...) macro invocations` })),
];

export function isRuleEnabled(ruleId: string, rules?: Record<string, boolean>): boolean {
  return rules?.[ruleId] !== false;
}
