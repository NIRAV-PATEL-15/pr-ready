import type { Lang } from "./types";

const BY_EXT: Record<string, Lang> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  java: "java",
  rs: "rust",
};

export const SCANNED_EXTENSIONS = Object.keys(BY_EXT);

export function langForPath(p: string): Lang | undefined {
  const base = p.split(/[\\/]/).pop() ?? "";
  if (/\.d\.[mc]?ts$/i.test(base)) return undefined;
  const m = /\.([A-Za-z]+)$/.exec(base);
  return m ? BY_EXT[m[1].toLowerCase()] : undefined;
}

const BY_LANGUAGE_ID: Record<string, Lang> = {
  javascript: "js", javascriptreact: "js", typescript: "js", typescriptreact: "js",
  java: "java",
  rust: "rust",
};

export function langForLanguageId(id: string): Lang | undefined {
  return BY_LANGUAGE_ID[id];
}
