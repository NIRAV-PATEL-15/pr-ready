import { deletionEdit } from "./edits";
import { tokenize } from "./lexer";
import { IGNORE_FILE_MARKER, IGNORE_LINE_MARKER } from "./scanner";
import type { Edit, Finding, Lang } from "./types";

/** Applies non-overlapping edits to text. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

/**
 * Combines the fixes of all fixable findings into a non-overlapping edit list.
 * Overlapping deletions are merged; an edit nested inside another (e.g. `dbg!` inside a removed
 * `println!`) is dropped in favour of the outer one.
 */
export function fixAllEdits(text: string, findings: readonly Finding[]): Edit[] {
  const edits = findings.filter((f) => f.fix).map((f) => ({ ...f.fix! }));
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Edit[] = [];
  for (const e of edits) {
    const last = out[out.length - 1];
    if (last && e.start < last.end) {
      if (e.end <= last.end) continue; // contained
      if (last.newText === "" && e.newText === "") { last.end = e.end; continue; }
      continue; // conflicting partial overlap: keep the first, the rest can be fixed on a re-scan
    }
    out.push(e);
  }
  // Deletions separated only by spaces/tabs on the same line become one; if that empties the line, drop the line.
  const merged: Edit[] = [];
  for (const e of out) {
    const last = merged[merged.length - 1];
    if (last && last.newText === "" && e.newText === "" && /^[ \t]*$/.test(text.slice(last.end, e.start))) {
      last.end = e.end;
      continue;
    }
    merged.push(e);
  }
  const isLineBreak = (c: string | undefined) => c === "\n" || c === "\r";
  return merged.map((e) =>
    e.newText === "" && !isLineBreak(text[e.end - 1]) && !isLineBreak(text[e.start]) ? deletionEdit(text, e.start, e.end) : e,
  );
}

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Inserts `// pr-ready-ignore` on its own line above the finding (or inline when that is impossible). */
export function ignoreLineEdit(text: string, lang: Lang, finding: Finding): Edit {
  let ls = finding.start;
  while (ls > 0 && text[ls - 1] !== "\n" && text[ls - 1] !== "\r") ls--;
  const insideToken = tokenize(text, lang).some((t) => t.start < ls && t.end > ls);
  if (insideToken) return { start: finding.start, end: finding.start, newText: `/* ${IGNORE_LINE_MARKER} */ ` };
  const indent = /^[ \t]*/.exec(text.slice(ls))![0];
  return { start: ls, end: ls, newText: `${indent}// ${IGNORE_LINE_MARKER}${eolOf(text)}` };
}

/** Inserts `// pr-ready-ignore-file` at the top of the file (after a shebang line). */
export function ignoreFileEdit(text: string): Edit {
  let at = 0;
  if (text.startsWith("#!") && !text.startsWith("#![")) {
    const nl = text.indexOf("\n");
    at = nl < 0 ? text.length : nl + 1;
    if (nl < 0) return { start: at, end: at, newText: `${eolOf(text)}// ${IGNORE_FILE_MARKER}${eolOf(text)}` };
  }
  return { start: at, end: at, newText: `// ${IGNORE_FILE_MARKER}${eolOf(text)}` };
}
