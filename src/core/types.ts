export type Lang = "js" | "java" | "rust";

/** A replacement of text[start, end) by newText (offsets are UTF-16 indices into the file text). */
export interface Edit {
  start: number;
  end: number;
  newText: string;
}

export interface Finding {
  ruleId: string;
  lang: Lang;
  /** Extent of the debug call/statement itself (without trailing `;`). */
  start: number;
  end: number;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  text: string;
  /** True when automatic removal is not safe; only Ignore is offered. */
  manual: boolean;
  reason?: string;
  /** The edit that removes (or unwraps) the statement. Absent for manual findings. */
  fix?: Edit;
}

export type TokenKind = "ident" | "punct" | "string" | "template" | "regex" | "number" | "comment" | "lifetime";

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
  /** Source text of the token (for comments: the full comment including delimiters). */
  value: string;
}
