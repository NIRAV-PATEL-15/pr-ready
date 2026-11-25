import { describe, it, expect } from "vitest";
import { scan } from "../../src/core/scanner";
import { applyEdits, fixAllEdits } from "../../src/core/fixes";
import type { Lang } from "../../src/core/types";

const fixAll = (src: string, lang: Lang) => applyEdits(src, fixAllEdits(src, scan(src, lang)));
const one = (src: string, lang: Lang) => scan(src, lang)[0];

describe("edge cases: js", () => {
  it("removing a statement that relied on ASI is manual when the next line would join the previous one", () => {
    const fd = one("a = b\nconsole.log(x);\n(c)();", "js");
    expect(fd.manual).toBe(true);
    expect(fd.reason).toMatch(/next line/);
    expect(one("a = b\nconsole.log(x);\nc();", "js").manual).toBe(false);
  });
  it("a call followed on the next line by ( or [ or a template is manual", () => {
    expect(one("console.log(x)\n[1, 2].forEach(f)", "js").manual).toBe(true);
    expect(one("console.log(x)\n`t`", "js").manual).toBe(true);
  });
  it("case labels are statement positions", () => {
    expect(fixAll("switch (a) {\n  case 'x': console.log('x'); break;\n  default: console.log('d')\n}", "js"))
      .toBe("switch (a) {\n  case 'x': break;\n  default:\n}");
  });
  it("object values and labels are manual", () => {
    expect(one("x = { a: console.log(1) };", "js").manual).toBe(true);
    expect(one("loop: console.log(1);", "js").manual).toBe(true);
  });
  it("if without braces is manual, with braces is fine", () => {
    expect(one("if (x)\n  console.log(1);\nnext();", "js").reason).toMatch(/if\/else\/loop/);
    expect(fixAll("if (x) {\n  console.log(1);\n} else {\n  console.log(2);\n}", "js")).toBe("if (x) {\n} else {\n}");
  });
  it("a statement after a call on the previous line (no semicolon) is fixable", () => {
    expect(fixAll("foo()\nconsole.log(1)\nbar()", "js")).toBe("foo()\nbar()");
  });
  it("regex with a quote does not hide later code", () => {
    expect(scan("const r = /'/; console.log(r);", "js")).toHaveLength(1);
    expect(scan("const q = a / b; console.log('x'); const z = c / d;", "js")).toHaveLength(1);
  });
  it("apostrophes in JSX text only affect their own line", () => {
    expect(scan("const p = <p>Don't</p>;\nconsole.log(p);", "js")).toHaveLength(1);
  });
  it("does not flag console references that are not calls", () => {
    expect(scan("const log = console.log; const f = console.log.bind(console);", "js")).toEqual([]);
  });
  it("JSX expression container", () => {
    expect(fixAll("const a = <div>{console.log(x)}</div>;", "js")).toBe("const a = <div>{}</div>;");
    expect(one("const a = <b onClick={() => console.log(1)} />;", "js").manual).toBe(true);
  });
});

describe("edge cases: java", () => {
  it("catch block on one line", () => {
    expect(fixAll("try { f(); } catch (Exception e) { e.printStackTrace(); }", "java")).toBe("try { f(); } catch (Exception e) { }");
  });
  it("switch rule arrow is manual, block body is fine", () => {
    expect(one("switch (x) { case 1 -> System.out.println(1); default -> {} }", "java").manual).toBe(true);
    expect(fixAll("switch (x) {\n  case 1 -> {\n    System.out.println(1);\n  }\n}", "java")).toBe("switch (x) {\n  case 1 -> {\n  }\n}");
  });
  it("classic switch case label is fine", () => {
    expect(fixAll("switch (x) {\n  case 1: System.out.println(1); break;\n}", "java")).toBe("switch (x) {\n  case 1: break;\n}");
  });
  it("this.field.printStackTrace() and array element receivers", () => {
    expect(scan("this.err.printStackTrace(); errs[0].printStackTrace();", "java").map((f) => f.text)).toEqual(["this.err.printStackTrace()", "errs[0].printStackTrace()"]);
  });
  it("annotations and generics do not confuse detection", () => {
    const src = "@Override\npublic <T> void f(List<T> xs) {\n    System.out.println(xs);\n}";
    expect(fixAll(src, "java")).toBe("@Override\npublic <T> void f(List<T> xs) {\n}");
  });
});

describe("edge cases: rust", () => {
  it("print macro as the whole block of an if/else", () => {
    expect(fixAll('if c { println!("x") } else { y() }', "rust")).toBe("if c { } else { y() }");
  });
  it("dbg! as a function's tail expression is unwrapped, not removed", () => {
    expect(fixAll("fn f() -> i32 {\n    dbg!(1 + 2)\n}", "rust")).toBe("fn f() -> i32 {\n    1 + 2\n}");
  });
  it("dbg! with operators around it", () => {
    expect(fixAll("let x = dbg!(a)?;", "rust")).toBe("let x = a?;");
    expect(fixAll("let x = &dbg!(v);", "rust")).toBe("let x = &v;");
    expect(fixAll("let x = -dbg!(a + b);", "rust")).toBe("let x = -(a + b);");
    expect(fixAll("let x = y == dbg!(a == b);", "rust")).toBe("let x = y == (a == b);");
    expect(fixAll("let x = dbg!(a as u8);", "rust")).toBe("let x = a as u8;");
    expect(fixAll("let x = dbg!(a as u8) + 1;", "rust")).toBe("let x = (a as u8) + 1;");
  });
  it("lifetimes and chars around macros", () => {
    const src = "fn f<'a>(s: &'a str) -> char {\n    println!(\"{}\", s);\n    'x'\n}";
    expect(fixAll(src, "rust")).toBe("fn f<'a>(s: &'a str) -> char {\n    'x'\n}");
  });
  it("macro_rules bodies are scanned like code", () => {
    expect(scan("macro_rules! m { ($x:expr) => { println!(\"{}\", $x) }; }", "rust")).toHaveLength(1);
  });
  it("other paths are not flagged", () => {
    expect(scan('log::println!("x"); core::dbg!(x);', "rust")).toEqual([]);
  });
});
