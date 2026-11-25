import { tokenize } from "./lexer";
import { CONSOLE_METHODS, JAVA_PRINT_METHODS, JAVA_STREAMS, RUST_MACROS, isRuleEnabled } from "./rules";
import { deletionEdit } from "./edits";
import type { Edit, Finding, Lang, Token } from "./types";

export interface ScanOptions {
  /** Rule id -> enabled. Missing ids are enabled. */
  rules?: Record<string, boolean>;
  /** Honour `pr-ready-ignore` / `pr-ready-ignore-file` comments (default true). */
  respectMarkers?: boolean;
}

const LINE_MARKER = /(?:^|[\s*/!])pr-ready-ignore(?![-\w])/;
const FILE_MARKER = /(?:^|[\s*/!])pr-ready-ignore-file(?![-\w])/;

export const IGNORE_LINE_MARKER = "pr-ready-ignore";
export const IGNORE_FILE_MARKER = "pr-ready-ignore-file";

const CONSOLE_SET = new Set<string>(CONSOLE_METHODS);
const JAVA_STREAM_SET = new Set<string>(JAVA_STREAMS);
const JAVA_PRINT_SET = new Set<string>(JAVA_PRINT_METHODS);
const RUST_MACRO_SET = new Set<string>(RUST_MACROS);

/** JS keywords after which an expression must follow (so a call there is not a statement). */
const JS_EXPR_KEYWORDS = new Set([
  "await", "typeof", "void", "new", "delete", "throw", "case", "in", "of", "instanceof", "extends", "yield", "return", "as", "satisfies",
]);
const CONTROL_KEYWORDS = new Set(["if", "while", "for", "with", "switch", "catch"]);
const RUST_KEYWORDS = new Set([
  "as", "if", "else", "match", "loop", "while", "for", "in", "move", "unsafe", "async", "await", "return", "break", "continue", "let", "ref", "mut",
]);

interface Candidate {
  ruleId: string;
  /** Index (into code tokens) of the first and last token of the call. */
  s: number;
  e: number;
  /** Index of the argument list's opening bracket, if any. */
  open?: number;
  manualReason?: string;
}

export function hasFileMarker(text: string, lang: Lang): boolean {
  return tokenize(text, lang).some((t) => t.kind === "comment" && FILE_MARKER.test(t.value));
}

export function scan(text: string, lang: Lang, opts: ScanOptions = {}): Finding[] {
  const respectMarkers = opts.respectMarkers !== false;
  const all = tokenize(text, lang);
  const comments = all.filter((t) => t.kind === "comment");
  if (respectMarkers && comments.some((c) => FILE_MARKER.test(c.value))) return [];

  const ct = all.filter((t) => t.kind !== "comment");
  const lines = lineStarts(text);
  const lineOf = (off: number) => lineAt(lines, off);
  const match = matchBrackets(ct);
  const ctx: Ctx = { text, lang, ct, match, lineOf };

  const candidates = lang === "js" ? findJs(ctx) : lang === "java" ? findJava(ctx) : findRust(ctx);

  const ignoredLines = new Set<number>();
  if (respectMarkers) {
    for (const c of comments) {
      if (!LINE_MARKER.test(c.value) || FILE_MARKER.test(c.value)) continue;
      const ln = lineOf(c.start);
      ignoredLines.add(ln);
      const before = text.slice(lines[ln], c.start);
      if (/^\s*$/.test(before)) ignoredLines.add(lineOf(c.end) + 1);
    }
  }

  const out: Finding[] = [];
  for (const cand of candidates) {
    if (!isRuleEnabled(cand.ruleId, opts.rules)) continue;
    const start = ct[cand.s].start;
    const end = ct[cand.e].end;
    const line = lineOf(start);
    if (ignoredLines.has(line)) continue;
    const endLine = lineOf(end);
    const finding: Finding = {
      ruleId: cand.ruleId,
      lang,
      start,
      end,
      line,
      character: start - lines[line],
      endLine,
      endCharacter: end - lines[endLine],
      text: text.slice(start, end),
      manual: true,
    };
    const res = cand.manualReason ? { reason: cand.manualReason } : planFix(ctx, cand);
    if ("edit" in res) {
      finding.manual = false;
      finding.fix = res.edit;
    } else {
      finding.reason = res.reason;
    }
    out.push(finding);
  }
  return out;
}

// ---------------------------------------------------------------- helpers

interface Ctx {
  text: string;
  lang: Lang;
  ct: Token[];
  match: Map<number, number>;
  lineOf: (off: number) => number;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13 && text.charCodeAt(i + 1) !== 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], off: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/** Maps the index of each bracket token to the index of its partner (both directions). */
function matchBrackets(ct: Token[]): Map<number, number> {
  const m = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < ct.length; i++) {
    const t = ct[i];
    if (t.kind !== "punct") continue;
    if (OPEN[t.value]) stack.push(i);
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      // pop until a matching opener (tolerates stray brackets)
      for (let k = stack.length - 1; k >= 0; k--) {
        if (OPEN[ct[stack[k]].value] === t.value) {
          m.set(stack[k], i);
          m.set(i, stack[k]);
          stack.length = k;
          break;
        }
      }
    }
  }
  return m;
}

const isP = (t: Token | undefined, v: string) => !!t && t.kind === "punct" && t.value === v;
const isId = (t: Token | undefined, v?: string) => !!t && t.kind === "ident" && (v === undefined || t.value === v);

// ---------------------------------------------------------------- candidate finders

function findJs({ ct, match }: Ctx): Candidate[] {
  const out: Candidate[] = [];
  for (let k = 0; k < ct.length; k++) {
    const t = ct[k];
    if (t.kind !== "ident") continue;
    const prev = ct[k - 1];
    if (isP(prev, ".") || isP(prev, "?.")) continue;
    if (t.value === "debugger") {
      if (isP(ct[k + 1], ":")) continue;
      out.push({ ruleId: "debugger", s: k, e: k });
      continue;
    }
    if (t.value !== "console" || !isP(ct[k + 1], ".") || !isId(ct[k + 2]) || !CONSOLE_SET.has(ct[k + 2].value)) continue;
    let j = k + 3;
    if (isP(ct[j], "<")) j = skipTypeArgs(ct, j);
    if (!isP(ct[j], "(")) continue;
    const close = match.get(j);
    if (close === undefined) out.push({ ruleId: `console.${ct[k + 2].value}`, s: k, e: j, manualReason: "Could not find the end of the call." });
    else out.push({ ruleId: `console.${ct[k + 2].value}`, s: k, e: close, open: j });
  }
  return out;
}

/** Skips TypeScript type arguments `<...>` starting at index j; returns the index after `>` or j if not type args. */
function skipTypeArgs(ct: Token[], j: number): number {
  let depth = 0;
  for (let i = j; i < ct.length && i < j + 64; i++) {
    const t = ct[i];
    if (t.kind === "punct") {
      if (t.value === "<") depth++;
      else if (t.value === ">") { depth--; if (depth === 0) return i + 1; }
      else if (![",", ".", "[", "]", "|", "&", "{", "}", ":", ";", "(", ")", "=>", "?", "..."].includes(t.value)) return j;
    } else if (t.kind !== "ident" && t.kind !== "string" && t.kind !== "number") return j;
  }
  return j;
}

function findJava({ ct, match }: Ctx): Candidate[] {
  const out: Candidate[] = [];
  for (let k = 0; k < ct.length; k++) {
    const t = ct[k];
    if (t.kind !== "ident") continue;
    if (t.value === "System" && !isP(ct[k - 1], ".") && isP(ct[k + 1], ".") && isId(ct[k + 2]) && JAVA_STREAM_SET.has(ct[k + 2].value)) {
      const sep = ct[k + 3];
      const m = ct[k + 4];
      if (!isId(m) || !JAVA_PRINT_SET.has(m.value)) continue;
      const ruleId = `System.${ct[k + 2].value}.${m.value}`;
      if (isP(sep, "::")) { out.push({ ruleId, s: k, e: k + 4, manualReason: "Method references cannot be removed automatically." }); continue; }
      if (!isP(sep, ".") || !isP(ct[k + 5], "(")) continue;
      const close = match.get(k + 5);
      if (close === undefined) out.push({ ruleId, s: k, e: k + 5, manualReason: "Could not find the end of the call." });
      else out.push({ ruleId, s: k, e: close, open: k + 5 });
      continue;
    }
    if (t.value === "printStackTrace" && isP(ct[k - 1], ".") && isP(ct[k + 1], "(")) {
      const s = receiverStart(ct, match, k - 1);
      if (s === undefined) continue;
      const close = match.get(k + 1);
      if (close === undefined) out.push({ ruleId: "printStackTrace", s, e: k + 1, manualReason: "Could not find the end of the call." });
      else out.push({ ruleId: "printStackTrace", s, e: close, open: k + 1 });
    }
  }
  return out;
}

/** Walks back from the `.` before a method name over a postfix chain (`a.b(c)[d].e`) and returns its first token index. */
function receiverStart(ct: Token[], match: Map<number, number>, dot: number): number | undefined {
  let j = dot;
  for (;;) {
    const t = ct[j - 1];
    if (!t) break;
    if (isP(t, ")") || isP(t, "]")) {
      const o = match.get(j - 1);
      if (o === undefined) return undefined;
      j = o;
      continue;
    }
    if (t.kind === "ident" || t.kind === "string") {
      j = j - 1;
      if (isP(ct[j - 1], ".")) { j = j - 1; continue; }
      if (isId(ct[j - 1], "new")) j = j - 1;
      break;
    }
    break;
  }
  return j === dot ? undefined : j;
}

function findRust({ ct, match }: Ctx): Candidate[] {
  const out: Candidate[] = [];
  for (let k = 0; k < ct.length; k++) {
    const t = ct[k];
    if (t.kind !== "ident" || !RUST_MACRO_SET.has(t.value)) continue;
    if (!isP(ct[k + 1], "!")) continue;
    const open = ct[k + 2];
    if (!open || open.kind !== "punct" || !OPEN[open.value]) continue;
    let s = k;
    const prev = ct[k - 1];
    if (isP(prev, ".")) continue;
    if (isP(prev, "::")) {
      if (!isId(ct[k - 2], "std") || isP(ct[k - 3], "::")) continue;
      s = k - 2;
    }
    const ruleId = `${t.value}!`;
    const close = match.get(k + 2);
    if (close === undefined) out.push({ ruleId, s, e: k + 2, manualReason: "Could not find the end of the macro invocation." });
    else out.push({ ruleId, s, e: close, open: k + 2 });
  }
  return out;
}

// ---------------------------------------------------------------- fix planning

type Plan = { edit: Edit } | { reason: string };

const REASON_VALUE = "The call is part of a larger expression or its value is used, so removing it could break the code.";
const REASON_ARROW = "The call is the body of an arrow function; removing it would leave invalid syntax.";
const REASON_LAMBDA = "The call is the body of a lambda or closure; removing it would leave invalid syntax.";
const REASON_CONTROL = "The call is the body of an if/else/loop without braces; removing it would change which statement the condition controls.";
const REASON_ASI = "Removing it would change how the next line is parsed (no semicolon before the next statement).";
const REASON_LABEL = "The call follows a label or is inside an object or conditional expression.";

function planFix(ctx: Ctx, cand: Candidate): Plan {
  const { ct, lang } = ctx;
  const P = ct[cand.s - 1];
  const N = ct[cand.e + 1];
  const isDbg = cand.ruleId === "dbg!";

  const start = startKind(ctx, cand.s);
  if (start.kind === "stmt" || start.kind === "asi") {
    const endOk = statementEnds(ctx, cand, N);
    if (endOk) {
      const hasSemi = isP(N, ";");
      const stmtEndIdx = hasSemi ? cand.e + 1 : cand.e;
      if (start.kind === "asi") {
        const M = ct[stmtEndIdx + 1];
        if (M && continuesExpression(M)) return { reason: REASON_ASI };
      }
      return { edit: deletionEdit(ctx.text, ct[cand.s].start, ct[stmtEndIdx].end) };
    }
  }

  if (lang === "rust") {
    if (isDbg) return { edit: { start: ct[cand.s].start, end: ct[cand.e].end, newText: unwrapDbg(ctx, cand) } };
    if (isP(P, "=>") && (N === undefined || isP(N, ",") || isP(N, "}"))) {
      return { edit: { start: ct[cand.s].start, end: ct[cand.e].end, newText: "()" } };
    }
    if (isP(P, "|")) return { reason: REASON_LAMBDA };
    return { reason: start.kind === "control" ? REASON_CONTROL : REASON_VALUE };
  }
  if (start.kind === "control") return { reason: REASON_CONTROL };
  if (isP(P, "=>")) return { reason: REASON_ARROW };
  if (isP(P, "->")) return { reason: REASON_LAMBDA };
  if (isP(P, ":")) return { reason: REASON_LABEL };
  return { reason: REASON_VALUE };
}

type StartKind = { kind: "stmt" | "asi" | "control" | "expr" };

/** Classifies the position just before the token at index s. */
function startKind(ctx: Ctx, s: number): StartKind {
  const { ct, lang, match, lineOf } = ctx;
  const P = ct[s - 1];
  if (!P) return { kind: "stmt" };
  const earlierLine = lineOf(P.end) < lineOf(ct[s].start);
  if (P.kind === "punct") {
    if (P.value === ";" || P.value === "{" || P.value === "}") return { kind: "stmt" };
    if (P.value === ":" && lang !== "rust") return { kind: isCaseLabel(ct, s - 1) ? "stmt" : "expr" };
    if (P.value === ")") {
      const o = match.get(s - 1);
      if (o !== undefined && isId(ct[o - 1]) && CONTROL_KEYWORDS.has(ct[o - 1].value)) return { kind: "control" };
      return lang === "js" && earlierLine ? { kind: "asi" } : { kind: "expr" };
    }
    if (P.value === "]" && lang === "js" && earlierLine) return { kind: "asi" };
    return { kind: "expr" };
  }
  if (P.kind === "ident" && (P.value === "else" || P.value === "do")) return { kind: "control" };
  if (lang === "js" && earlierLine) {
    if (P.kind === "ident" && JS_EXPR_KEYWORDS.has(P.value)) return { kind: "expr" };
    return { kind: "asi" };
  }
  return { kind: "expr" };
}

function isCaseLabel(ct: Token[], colon: number): boolean {
  for (let j = colon - 1; j >= 0 && j >= colon - 40; j--) {
    const t = ct[j];
    if (t.kind === "ident" && (t.value === "case" || t.value === "default")) return true;
    if (t.kind === "punct" && [";", "{", "}", "?", ":", ",", "=>", "->"].includes(t.value)) return false;
  }
  return false;
}

/** Whether a token at the start of a later line would continue the previous expression in JS. */
function continuesExpression(t: Token): boolean {
  if (t.kind === "template" || t.kind === "regex") return true;
  if (t.kind === "punct") return !["{", "}", ";", "!", "~", "@", "#"].includes(t.value);
  if (t.kind === "ident") return ["in", "instanceof", "of", "as", "satisfies"].includes(t.value);
  return false;
}

function statementEnds(ctx: Ctx, cand: Candidate, N: Token | undefined): boolean {
  const { lang, ct, lineOf } = ctx;
  if (isP(N, ";")) return true;
  if (lang === "java") return false;
  if (lang === "rust") {
    if (cand.ruleId === "dbg!") return false; // a tail `dbg!(x)` is the block's value
    if (N === undefined || isP(N, "}")) return true;
    return cand.open !== undefined && ct[cand.open].value === "{";
  }
  if (N === undefined || isP(N, "}")) return true;
  if (lineOf(N.start) > lineOf(ct[cand.e].end)) return !continuesExpression(N);
  return false;
}

/** Replacement text for `dbg!(args)` used as an expression. */
function unwrapDbg(ctx: Ctx, cand: Candidate): string {
  const { ct, text, match } = ctx;
  const open = cand.open!;
  const close = cand.e;
  // split top-level arguments
  const args: [number, number][] = [];
  let segStart = open + 1;
  for (let i = open + 1; i < close; i++) {
    const m = match.get(i);
    if (m !== undefined && m > i) { i = m; continue; }
    if (isP(ct[i], ",")) { args.push([segStart, i - 1]); segStart = i + 1; }
  }
  if (segStart < close) args.push([segStart, close - 1]);
  if (args.length === 0) return "()";
  const argText = (a: [number, number]) => text.slice(ct[a[0]].start, ct[a[1]].end);
  if (args.length > 1) return "(" + args.map(argText).join(", ") + ")";
  const inner = argText(args[0]);
  if (isAtomic(ct, match, args[0][0], args[0][1]) || freeContext(ct, cand)) return inner;
  return "(" + inner + ")";
}

/** A Rust postfix chain: path/literal/group followed by `.x`, `(…)`, `[…]`, `?`, `::`, `name!(…)`. */
function isAtomic(ct: Token[], match: Map<number, number>, a: number, b: number): boolean {
  for (let i = a; i <= b; i++) {
    const t = ct[i];
    if (t.kind === "ident") { if (RUST_KEYWORDS.has(t.value)) return false; continue; }
    if (t.kind === "string" || t.kind === "number") continue;
    if (t.kind !== "punct") return false;
    if (t.value === "(" || t.value === "[") { const m = match.get(i); if (m === undefined) return false; i = m; continue; }
    if (t.value === "." || t.value === "::" || t.value === "?") continue;
    if (t.value === "!" && isId(ct[i - 1]) && i > a && (isP(ct[i + 1], "(") || isP(ct[i + 1], "["))) continue;
    if (t.value === "<" && isP(ct[i - 1], "::")) {
      // turbofish ::<...>
      let depth = 0;
      for (; i <= b; i++) {
        if (isP(ct[i], "<")) depth++;
        else if (isP(ct[i], ">")) { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** Whether any expression can replace the dbg! call without parentheses. */
function freeContext(ct: Token[], cand: Candidate): boolean {
  const P = ct[cand.s - 1];
  const N = ct[cand.e + 1];
  const okBefore = !!P && P.kind === "punct" && ["(", ",", "[", "{", ";", "=", "=>"].includes(P.value) &&
    !(P.value === "=" && ct[cand.s - 2]?.kind === "punct" && ct[cand.s - 2].end === P.start);
  const okAfter = !N || (N.kind === "punct" && [")", ",", "]", ";", "}"].includes(N.value));
  return okBefore && okAfter;
}
