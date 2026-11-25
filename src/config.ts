import * as vscode from "vscode";
import { DEFAULT_IGNORE_PATHS } from "./core/glob";

export interface Settings {
  enableDiagnostics: boolean;
  rules: Record<string, boolean>;
  ignorePaths: string[];
  baseBranch: string;
}

export function readSettings(scope?: vscode.Uri): Settings {
  const c = vscode.workspace.getConfiguration("prReady", scope);
  const rules = c.get<Record<string, unknown>>("rules") ?? {};
  const cleanRules: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(rules)) if (typeof v === "boolean") cleanRules[k] = v;
  const user = (c.get<unknown[]>("ignorePaths") ?? []).filter((p): p is string => typeof p === "string");
  const useDefaults = c.get<boolean>("useDefaultExcludes", true);
  return {
    enableDiagnostics: c.get<boolean>("enableDiagnostics", true),
    rules: cleanRules,
    ignorePaths: [...(useDefaults ? DEFAULT_IGNORE_PATHS : []), ...user],
    baseBranch: (c.get<string>("baseBranch") ?? "").trim(),
  };
}
