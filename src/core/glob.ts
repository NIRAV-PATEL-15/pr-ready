/** Minimal glob matching for workspace-relative paths: `**`, `*`, `?`, `{a,b}` and `[...]`. */

export const DEFAULT_IGNORE_PATHS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/.git/**",
];

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegStart = i === 0 || glob[i - 1] === "/";
        const atSegEnd = i + 2 >= glob.length || glob[i + 2] === "/";
        if (atSegStart && atSegEnd) {
          if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } // "**/" = zero or more directories
          else { re += ".*"; i += 1; }
          continue;
        }
        re += "[^/]*"; i += 1; continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { re += "(?:"; inGroup++; }
    else if (c === "}" && inGroup) { re += ")"; inGroup--; }
    else if (c === "," && inGroup) re += "|";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i + 1) {
        let body = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
        if (body[0] === "!") body = "^" + body.slice(1);
        re += "[" + body + "]";
        i = close;
      } else re += "\\[";
    } else re += c.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

const cache = new Map<string, RegExp>();

export function isPathIgnored(relPath: string, patterns: readonly string[]): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const base = p.slice(p.lastIndexOf("/") + 1);
  for (const raw of patterns) {
    const g = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!g) continue;
    let re = cache.get(g);
    if (!re) { re = globToRegExp(g); cache.set(g, re); }
    if (re.test(p)) return true;
    if (!g.includes("/") && re.test(base)) return true;
  }
  return false;
}
