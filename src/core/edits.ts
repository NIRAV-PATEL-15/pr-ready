import type { Edit } from "./types";

/** Deletes text[start, end): whole lines when nothing else is on them, otherwise just the statement. */
export function deletionEdit(text: string, start: number, end: number): Edit {
  let ls = start;
  while (ls > 0 && text[ls - 1] !== "\n" && text[ls - 1] !== "\r") ls--;
  let le = end;
  while (le < text.length && text[le] !== "\n" && text[le] !== "\r") le++;
  const before = text.slice(ls, start);
  const after = text.slice(end, le);
  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) {
    let next = le;
    if (text[next] === "\r" && text[next + 1] === "\n") next += 2;
    else if (next < text.length) next += 1;
    else {
      // last line without a line break: remove the preceding break instead
      if (ls > 0) {
        ls -= text[ls - 1] === "\n" && text[ls - 2] === "\r" ? 2 : 1;
      }
    }
    return { start: ls, end: next, newText: "" };
  }
  if (/^[ \t]*$/.test(after)) {
    let s = start;
    while (s > ls && (text[s - 1] === " " || text[s - 1] === "\t")) s--;
    return { start: s, end: le, newText: "" };
  }
  let e = end;
  while (e < le && (text[e] === " " || text[e] === "\t")) e++;
  return { start, end: e, newText: "" };
}
