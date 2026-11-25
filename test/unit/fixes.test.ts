import { describe, it, expect } from "vitest";
import ts from "typescript";
import { scan } from "../../src/core/scanner";
import { applyEdits, fixAllEdits, ignoreLineEdit, ignoreFileEdit } from "../../src/core/fixes";
import type { Lang } from "../../src/core/types";

function fixOne(src: string, lang: Lang, index = 0): string {
  const fd = scan(src, lang)[index];
  expect(fd, "finding").toBeTruthy();
  expect(fd.fix, "fixable").toBeTruthy();
  return applyEdits(src, [fd.fix!]);
}
const fixAll = (src: string, lang: Lang) => applyEdits(src, fixAllEdits(src, scan(src, lang)));

function parsesAsTs(src: string, tsx = false): string[] {
  const out = ts.transpileModule(src, {
    reportDiagnostics: true,
    fileName: tsx ? "x.tsx" : "x.ts",
    compilerOptions: { jsx: ts.JsxEmit.Preserve },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("fix: js/ts", () => {
  it("deletes a statement alone on its line, including the line", () => {
    expect(fixOne("a();\n  console.log(x);\nb();\n", "js")).toBe("a();\nb();\n");
  });
  it("deletes a multi-line statement and all its lines", () => {
    expect(fixOne("a();\nconsole.log(\n  1,\n  2\n);\nb();\n", "js")).toBe("a();\nb();\n");
  });
  it("keeps CRLF line endings intact", () => {
    expect(fixOne("a();\r\nconsole.log(x);\r\nb();\r\n", "js")).toBe("a();\r\nb();\r\n");
  });
  it("deletes only the statement when the line has other code", () => {
    expect(fixOne("a(); console.log(x); b();\n", "js")).toBe("a(); b();\n");
    expect(fixOne("if (a) { console.log(x) }\n", "js")).toBe("if (a) { }\n");
  });
  it("handles a statement without semicolon (ASI)", () => {
    expect(fixOne("a()\nconsole.log(x)\nb()\n", "js")).toBe("a()\nb()\n");
  });
  it("deletes debugger;", () => {
    expect(fixOne("function f() {\n  debugger;\n  return 1;\n}\n", "js")).toBe("function f() {\n  return 1;\n}\n");
  });
  it("keeps a trailing comment on the line", () => {
    expect(fixOne("a();\nconsole.log(x); // why\n", "js")).toBe("a();\n// why\n");
  });
  it("fix-all output on a realistic TSX file still parses", () => {
    const src = [
      "import React from 'react';",
      "export function App({ items }: { items: string[] }) {",
      "  console.log('render', items);",
      "  const onClick = () => {",
      "    console.debug(`clicked ${items.length}`);",
      "    debugger;",
      "  };",
      "  if (items.length === 0) { console.warn('empty') }",
      "  console.table(",
      "    items.map((i) => ({ i, s: ')' })),",
      "  );",
      "  return <ul onClick={onClick}>{items.map((i) => <li key={i}>{i}</li>)}</ul>;",
      "}",
    ].join("\n");
    const out = fixAll(src, "js");
    expect(out).not.toMatch(/console\.|debugger/);
    expect(parsesAsTs(out, true)).toEqual([]);
  });
  it("fix-all on a TS file with mixed safe and manual findings parses and keeps manual ones", () => {
    const src = [
      "export async function run(xs: number[]): Promise<void> {",
      "  const log = (v: number) => console.log(v);",
      "  for (const x of xs) {",
      "    console.info('x', x); log(x);",
      "  }",
      "  const t = setTimeout(() => console.error('late'), 10)",
      "  console.time('t'); console.timeEnd('t')",
      "  console.assert(xs.length > 0, 'empty')",
      "}",
    ].join("\n");
    const out = fixAll(src, "js");
    expect(parsesAsTs(out)).toEqual([]);
    expect(out).toContain("console.log(v)");
    expect(out).toContain("console.error('late')");
    expect(out).not.toMatch(/console\.(info|time|timeEnd|assert)/);
  });
  it("manual findings carry no fix", () => {
    const fd = scan("const f = () => console.log(x);", "js")[0];
    expect(fd.manual).toBe(true);
    expect(fd.fix).toBeUndefined();
  });
});

describe("fix: java (exact output)", () => {
  it("removes statements, lines and printStackTrace", () => {
    const src = [
      "class A {",
      "    void f() {",
      "        int x = 1;",
      "        System.out.println(\"x = \" + x);",
      "        try { g(); } catch (Exception e) {",
      "            e.printStackTrace();",
      "            throw e;",
      "        }",
      "        System.err.printf(",
      "            \"%d%n\", x);",
      "        g(); System.out.print(x); h();",
      "    }",
      "}",
    ].join("\n");
    expect(fixAll(src, "java")).toBe([
      "class A {",
      "    void f() {",
      "        int x = 1;",
      "        try { g(); } catch (Exception e) {",
      "            throw e;",
      "        }",
      "        g(); h();",
      "    }",
      "}",
    ].join("\n"));
  });
  it("leaves lambdas alone in fix-all", () => {
    const src = "Runnable r = () -> System.out.println(1);\n";
    expect(fixAll(src, "java")).toBe(src);
  });
});

describe("fix: rust (exact output)", () => {
  it("removes print statements and lines", () => {
    const src = [
      "fn main() {",
      "    let x = 1;",
      "    println!(\"x = {}\", x);",
      "    eprintln!(",
      "        \"{}\",",
      "        r#\")\"#,",
      "    );",
      "    print!(\"a\"); eprint!(\"b\");",
      "}",
    ].join("\n");
    expect(fixAll(src, "rust")).toBe(["fn main() {", "    let x = 1;", "}"].join("\n"));
  });
  it("unwraps dbg! inside expressions", () => {
    expect(fixOne("let a = dbg!(x * 2) + 1;", "rust")).toBe("let a = (x * 2) + 1;");
    expect(fixOne("let a = dbg!(x * 2);", "rust")).toBe("let a = x * 2;");
    expect(fixOne("let a = dbg!(x + 1) * 2;", "rust")).toBe("let a = (x + 1) * 2;");
    expect(fixOne("foo(dbg!(y), 2);", "rust")).toBe("foo(y, 2);");
    expect(fixOne("let t = dbg!(a, b);", "rust")).toBe("let t = (a, b);");
    expect(fixOne("let t = dbg!(a,);", "rust")).toBe("let t = a;");
    expect(fixOne("let u = dbg!();", "rust")).toBe("let u = ();");
    expect(fixOne("let v = dbg!(\n    compute(\n        1,\n    )\n);", "rust")).toBe("let v = compute(\n        1,\n    );");
    expect(fixOne("let v = dbg!(x).len();", "rust")).toBe("let v = x.len();");
  });
  it("removes a dbg! statement", () => {
    expect(fixOne("fn f() {\n    dbg!(x);\n    g();\n}", "rust")).toBe("fn f() {\n    g();\n}");
  });
  it("replaces a print macro in a match arm with ()", () => {
    expect(fixOne("match x {\n    1 => println!(\"one\"),\n    _ => {}\n}", "rust")).toBe("match x {\n    1 => (),\n    _ => {}\n}");
  });
  it("fix-all with a dbg! nested in println! removes the outer statement only", () => {
    expect(fixAll("fn f() {\n    println!(\"{}\", dbg!(x));\n}", "rust")).toBe("fn f() {\n}");
  });
  it("removes a print macro that is the block's tail expression", () => {
    expect(fixOne("fn f() {\n    g();\n    println!(\"done\")\n}", "rust")).toBe("fn f() {\n    g();\n}");
  });
});

describe("ignore edits", () => {
  it("inserts // pr-ready-ignore above the statement with matching indentation", () => {
    const src = "fn f() {\n    println!(\"keep\");\n}";
    const fd = scan(src, "rust")[0];
    const out = applyEdits(src, [ignoreLineEdit(src, "rust", fd)]);
    expect(out).toBe("fn f() {\n    // pr-ready-ignore\n    println!(\"keep\");\n}");
    expect(scan(out, "rust")).toEqual([]);
  });
  it("uses CRLF when the file does", () => {
    const src = "a();\r\n  console.log(1);\r\n";
    const out = applyEdits(src, [ignoreLineEdit(src, "js", scan(src, "js")[0])]);
    expect(out).toBe("a();\r\n  // pr-ready-ignore\r\n  console.log(1);\r\n");
  });
  it("falls back to an inline block comment when the line starts inside a multi-line string", () => {
    const src = "const s = `a\nb`; console.log(s);";
    const out = applyEdits(src, [ignoreLineEdit(src, "js", scan(src, "js")[0])]);
    expect(out).toBe("const s = `a\nb`; /* pr-ready-ignore */ console.log(s);");
    expect(scan(out, "js")).toEqual([]);
  });
  it("inserts the file marker at the top, after a shebang", () => {
    expect(applyEdits("a();\n", [ignoreFileEdit("a();\n")])).toBe("// pr-ready-ignore-file\na();\n");
    expect(applyEdits("#!/usr/bin/env node\nconsole.log(1);\n", [ignoreFileEdit("#!/usr/bin/env node\nconsole.log(1);\n")]))
      .toBe("#!/usr/bin/env node\n// pr-ready-ignore-file\nconsole.log(1);\n");
  });
});
