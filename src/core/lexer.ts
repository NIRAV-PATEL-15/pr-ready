import type { Lang, Token, TokenKind } from "./types";

/**
 * A small, forgiving tokenizer for JavaScript/TypeScript, Java and Rust.
 *
 * It only needs to be good enough to tell code from comments and string-like literals,
 * and to match brackets. It never throws: unterminated literals end at end of line
 * (single-line strings) or end of file (multi-line literals and block comments).
 */

const JS_PUNCT = ["...", "=>", "?.", "::"];
const JAVA_PUNCT = ["->", "::"];
const RUST_PUNCT = ["=>", "->", "::"];

/** Keywords after which a `/` starts a regular expression rather than a division. */
const JS_REGEX_AFTER_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 0x7f;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 0x7f;
const isDigit = (c: string) => c >= "0" && c <= "9";
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === " " || c === "﻿" || c === " " || c === " ";

export function tokenize(text: string, lang: Lang): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  const punct = lang === "js" ? JS_PUNCT : lang === "java" ? JAVA_PUNCT : RUST_PUNCT;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number) => tokens.push({ kind, start, end, value: text.slice(start, end) });

  /** Last token that is not a comment. */
  const prevSignificant = (): Token | undefined => {
    for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].kind !== "comment") return tokens[k];
    return undefined;
  };

  const lineEnd = (from: number) => {
    let j = from;
    while (j < n && text[j] !== "\n" && text[j] !== "\r") j++;
    return j;
  };

  /** Single-line quoted string (JS/Java). Ends at the closing quote or before a raw newline. */
  const skipLineString = (from: number, q: string) => {
    let j = from + 1;
    while (j < n) {
      const c = text[j];
      if (c === "\\") {
        // escape; a backslash-newline is a JS line continuation
        j += text[j + 1] === "\r" && text[j + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (c === q) return j + 1;
      if (c === "\n" || c === "\r") return j;
      j++;
    }
    return n;
  };

  /** Multi-line string with escapes that ends at `q` (Rust "..."). */
  const skipEscapedString = (from: number, q: string) => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === "\\") { j += 2; continue; }
      if (c === q) return j + 1;
      j++;
    }
    return n;
  };

  const skipBlockComment = (from: number, nested: boolean) => {
    let j = from + 2;
    let depth = 1;
    while (j < n) {
      if (nested && text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
      if (text[j] === "*" && text[j + 1] === "/") {
        depth--; j += 2;
        if (depth === 0) return j;
        continue;
      }
      j++;
    }
    return n;
  };

  /** JS template literal starting at the backtick; `${ ... }` bodies are skipped with brace matching. */
  const skipTemplate = (from: number): number => {
    let j = from + 1;
    while (j < n) {
      const c = text[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "`") return j + 1;
      if (c === "$" && text[j + 1] === "{") { j = skipJsCodeUntilBrace(j + 2); continue; }
      j++;
    }
    return n;
  };

  /** Skips JS code inside `${ ... }` and returns the index after the matching `}`. */
  const skipJsCodeUntilBrace = (from: number): number => {
    let j = from;
    let depth = 1;
    while (j < n) {
      const c = text[j];
      if (c === "'" || c === '"') { j = skipLineString(j, c); continue; }
      if (c === "`") { j = skipTemplate(j); continue; }
      if (c === "/" && text[j + 1] === "/") { j = lineEnd(j); continue; }
      if (c === "/" && text[j + 1] === "*") { j = skipBlockComment(j, false); continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return j + 1; }
      j++;
    }
    return n;
  };

  const skipRegex = (from: number): number => {
    let j = from + 1;
    let inClass = false;
    while (j < n) {
      const c = text[j];
      if (c === "\\") { j += 2; continue; }
      if (c === "\n" || c === "\r") return j; // not a valid regex; stop at the line end
      if (inClass) { if (c === "]") inClass = false; }
      else if (c === "[") inClass = true;
      else if (c === "/") { j++; while (j < n && isIdentPart(text[j])) j++; return j; }
      j++;
    }
    return n;
  };

  const jsRegexAllowed = (): boolean => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.kind === "punct") return !(p.value === ")" || p.value === "]" || p.value === "}");
    if (p.kind === "ident") return JS_REGEX_AFTER_KEYWORDS.has(p.value);
    return false;
  };

  /** Rust raw/byte/C string or byte char starting at `from` (an ident-start char). Returns end or -1. */
  const rustPrefixedLiteral = (from: number): number => {
    const m = /^(?:b|c)?r(#*)"/.exec(text.slice(from, from + 300));
    if (m) {
      const close = '"' + m[1];
      const idx = text.indexOf(close, from + m[0].length);
      return idx < 0 ? n : idx + close.length;
    }
    if ((text[from] === "b" || text[from] === "c") && text[from + 1] === '"') return skipEscapedString(from + 2, '"');
    if (text[from] === "b" && text[from + 1] === "'") return skipEscapedString(from + 2, "'");
    return -1;
  };

  while (i < n) {
    const c = text[i];
    if (isSpace(c)) { i++; continue; }

    // comments
    if (c === "/" && text[i + 1] === "/") { const e = lineEnd(i); push("comment", i, e); i = e; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = skipBlockComment(i, lang === "rust"); push("comment", i, e); i = e; continue; }

    // string-like literals
    if (lang === "js") {
      if (c === "'" || c === '"') { const e = skipLineString(i, c); push("string", i, e); i = e; continue; }
      if (c === "`") { const e = skipTemplate(i); push("template", i, e); i = e; continue; }
      if (c === "/" && jsRegexAllowed()) { const e = skipRegex(i); push("regex", i, e); i = e; continue; }
    } else if (lang === "java") {
      if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
        let j = i + 3;
        while (j < n && !(text[j] === '"' && text[j + 1] === '"' && text[j + 2] === '"')) j += text[j] === "\\" ? 2 : 1;
        const e = Math.min(n, j + 3);
        push("string", i, e); i = e; continue;
      }
      if (c === "'" || c === '"') { const e = skipLineString(i, c); push("string", i, e); i = e; continue; }
    } else {
      if (c === '"') { const e = skipEscapedString(i + 1, '"'); push("string", i, e); i = e; continue; }
      if (c === "'") {
        if (text[i + 1] === "\\") { const e = skipEscapedString(i + 1, "'"); push("string", i, e); i = e; continue; }
        const cp = text.codePointAt(i + 1);
        const w = cp !== undefined && cp > 0xffff ? 2 : 1;
        if (i + 1 < n && text[i + 1 + w] === "'") { push("string", i, i + 2 + w); i += 2 + w; continue; }
        let j = i + 1;
        while (j < n && isIdentPart(text[j])) j++;
        push(j > i + 1 ? "lifetime" : "punct", i, Math.max(j, i + 1));
        i = Math.max(j, i + 1);
        continue;
      }
      if (c === "r" || c === "b" || c === "c") {
        const e = rustPrefixedLiteral(i);
        if (e >= 0) { push("string", i, e); i = e; continue; }
      }
      if (c === "r" && text[i + 1] === "#" && i + 2 < n && isIdentStart(text[i + 2])) {
        let j = i + 2;
        while (j < n && isIdentPart(text[j])) j++;
        push("ident", i, j); i = j; continue;
      }
    }

    if (isIdentStart(c) && !(lang === "rust" && c === "$")) {
      let j = i + 1;
      while (j < n && isIdentPart(text[j]) && !(lang === "rust" && text[j] === "$")) j++;
      push("ident", i, j); i = j; continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isIdentPart(text[j]) || (text[j] === "." && isDigit(text[j + 1] ?? "")))) j++;
      push("number", i, j); i = j; continue;
    }

    const multi = punct.find((p) => text.startsWith(p, i) && !(p === "?." && isDigit(text[i + 2] ?? "")));
    const len = multi ? multi.length : 1;
    push("punct", i, i + len);
    i += len;
  }
  return tokens;
}
