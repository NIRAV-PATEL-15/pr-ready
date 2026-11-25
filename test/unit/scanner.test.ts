import { describe, it, expect } from "vitest";
import { scan } from "../../src/core/scanner";
import type { Lang } from "../../src/core/types";

const f = (src: string, lang: Lang, rules?: Record<string, boolean>) =>
  scan(src, lang, { rules }).map((x) => ({ rule: x.ruleId, line: x.line, text: x.text, manual: x.manual }));
const rules = (src: string, lang: Lang) => scan(src, lang).map((x) => x.ruleId);

describe("scanner: js/ts patterns", () => {
  it("finds every console method", () => {
    const methods = ["log", "debug", "info", "warn", "error", "trace", "dir", "table", "time", "timeEnd", "group", "groupEnd", "count", "assert"];
    const src = methods.map((m) => `console.${m}(x);`).join("\n");
    expect(rules(src, "js")).toEqual(methods.map((m) => `console.${m}`));
  });
  it("finds debugger statements", () => {
    expect(f("function a() {\n  debugger;\n}", "js")).toEqual([{ rule: "debugger", line: 1, text: "debugger", manual: false }]);
  });
  it("ignores unrelated console members and look-alikes", () => {
    expect(rules("console.clear(); myconsole.log(1); foo.console.log(1); obj.debugger; x = { debugger: 1 }; console.log", "js")).toEqual([]);
  });
  it("handles TypeScript generics and type annotations", () => {
    expect(rules("const a: Array<string> = [];\nconsole.log<string>(a as any);", "js")).toEqual(["console.log"]);
  });
  it("respects disabled rules", () => {
    expect(rules("console.warn(1); console.error(2); console.log(3);", "js")).toHaveLength(3);
    expect(scan("console.warn(1); console.error(2); console.log(3);", "js", { rules: { "console.warn": false, "console.error": false } }).map((x) => x.ruleId)).toEqual(["console.log"]);
    expect(scan("debugger;", "js", { rules: { debugger: false } })).toEqual([]);
  });
});

describe("scanner: no false positives in comments and strings", () => {
  it("js", () => {
    const src = [
      "// console.log(1)",
      "/* console.log(2); debugger; */",
      "const a = 'console.log(3)';",
      'const b = "debugger; console.log(4)";',
      "const c = `console.log(${x}) debugger`;",
      "const d = /console.log(5)/;",
      "/**",
      " * console.log(6)",
      " */",
    ].join("\n");
    expect(f(src, "js")).toEqual([]);
  });
  it("java", () => {
    const src = [
      "// System.out.println(1);",
      "/* e.printStackTrace(); */",
      'String a = "System.out.println(2);";',
      'String b = """',
      "    System.err.println(3);",
      '    e.printStackTrace();""";',
      "char c = '\"'; String d = \"x\";",
    ].join("\n");
    expect(f(src, "java")).toEqual([]);
  });
  it("rust", () => {
    const src = [
      "// println!(\"1\");",
      "/* outer /* dbg!(x) */ still comment println!() */",
      'let a = "println!(\\"2\\")";',
      'let b = r#"dbg!(x); "eprintln!()" "#;',
      "let c = b\"print!(3)\";",
      "/// doc println!(4)",
      "let q = '\"'; let s = \"after\";",
    ].join("\n");
    expect(f(src, "rust")).toEqual([]);
  });
  it("finds code right after a string containing the pattern", () => {
    expect(rules('const s = "console.log(1)"; console.log(s);', "js")).toEqual(["console.log"]);
    expect(rules('let s = r#"dbg!("x")"#; dbg!(s);', "rust")).toEqual(["dbg!"]);
  });
});

describe("scanner: java patterns", () => {
  it("finds System.out/err print methods and printStackTrace", () => {
    const src = [
      "System.out.print(1);",
      "System.out.println(2);",
      'System.out.printf("%d", 3);',
      "System.err.print(4);",
      "System.err.println(5);",
      'System.err.printf("%s", 6);',
      "e.printStackTrace();",
      "ex.getCause().printStackTrace();",
      "new Exception(\"x\").printStackTrace();",
    ].join("\n");
    expect(f(src, "java").map((x) => [x.rule, x.text])).toEqual([
      ["System.out.print", "System.out.print(1)"],
      ["System.out.println", "System.out.println(2)"],
      ["System.out.printf", 'System.out.printf("%d", 3)'],
      ["System.err.print", "System.err.print(4)"],
      ["System.err.println", "System.err.println(5)"],
      ["System.err.printf", 'System.err.printf("%s", 6)'],
      ["printStackTrace", "e.printStackTrace()"],
      ["printStackTrace", "ex.getCause().printStackTrace()"],
      ["printStackTrace", 'new Exception("x").printStackTrace()'],
    ]);
  });
  it("ignores other System members", () => {
    expect(rules("System.out.flush(); System.exit(0); logger.println(1); out.println(2);", "java")).toEqual([]);
  });
  it("flags method references as manual", () => {
    expect(f("list.forEach(System.out::println);", "java")).toEqual([
      { rule: "System.out.println", line: 0, text: "System.out::println", manual: true },
    ]);
  });
});

describe("scanner: rust patterns", () => {
  it("finds print macros with any delimiter", () => {
    const src = 'println!("a");\nprint!["b"];\neprintln!{"c"};\neprint!("d");\nlet x = dbg!(y);';
    expect(rules(src, "rust")).toEqual(["println!", "print!", "eprintln!", "eprint!", "dbg!"]);
  });
  it("finds std::-qualified macros", () => {
    expect(f('std::println!("a");', "rust")).toEqual([{ rule: "println!", line: 0, text: 'std::println!("a")', manual: false }]);
  });
  it("ignores look-alikes", () => {
    expect(rules('writeln!(f, "x"); format!("y"); my_println!("z"); x.println(); println != 1;', "rust")).toEqual([]);
  });
  it("finds dbg! nested inside other expressions", () => {
    expect(f("let v = foo(dbg!(a + b), 2);", "rust")).toEqual([{ rule: "dbg!", line: 0, text: "dbg!(a + b)", manual: false }]);
  });
});

describe("scanner: multi-line extent", () => {
  it("js: spans lines and skips parens inside strings and comments", () => {
    const src = 'console.log(\n  "(",\n  // )\n  foo(`)`),\n  /* ) */ bar\n);\nnext();';
    const r = scan(src, "js");
    expect(r).toHaveLength(1);
    expect(r[0].line).toBe(0);
    expect(r[0].endLine).toBe(5);
    expect(r[0].text.endsWith(")")).toBe(true);
  });
  it("java: multi-line println", () => {
    const src = 'System.out.println(\n    "a" + ")" +\n    b);\nint x = 1;';
    const r = scan(src, "java");
    expect(r[0].endLine).toBe(2);
  });
  it("rust: multi-line macro with brackets in raw strings", () => {
    const src = 'println!(\n    "{}",\n    r#")"#\n);\nlet x = 1;';
    const r = scan(src, "rust");
    expect(r[0].endLine).toBe(3);
  });
  it("unterminated call is reported as manual", () => {
    const r = scan("console.log(1,\n", "js");
    expect(r).toHaveLength(1);
    expect(r[0].manual).toBe(true);
  });
});

describe("scanner: safe vs manual", () => {
  const manual = (src: string, lang: Lang) => scan(src, lang).map((x) => x.manual);
  it("js statements are safe", () => {
    expect(manual("console.log(1);\nfoo(); console.log(2)\nif (a) { console.log(3) }\n", "js")).toEqual([false, false, false]);
  });
  it("js expression positions are manual", () => {
    const src = [
      "const f = () => console.log(x);",
      "const v = console.log(x);",
      "a && console.log(x);",
      "if (a) console.log(x);",
      "else console.log(x);",
      "foo(console.log(x));",
      "console.log(x), y;",
      "console.log(x).then(y);",
      "x ? console.log(1) : 0;",
      "return console.log(x);",
      "await console.log(x);",
    ].join("\n");
    expect(manual(src, "js")).toEqual(Array(11).fill(true));
  });
  it("java statements are safe; lambdas and conditions are manual", () => {
    expect(manual("void f() {\n  System.out.println(1);\n  e.printStackTrace();\n}", "java")).toEqual([false, false]);
    expect(manual("r = () -> System.out.println(1);\nif (a) System.out.println(2);\nString s = String.valueOf(System.out.printf(\"x\"));", "java")).toEqual([true, true, true]);
  });
  it("rust statements are safe; match arms with print macros are fixable", () => {
    expect(manual('fn f() {\n    println!("a");\n    match x {\n        1 => println!("one"),\n        _ => {}\n    }\n}', "rust")).toEqual([false, false]);
    expect(manual('let c = |x| println!("{}", x);', "rust")).toEqual([true]);
  });
  it("rust dbg! is always fixable by unwrapping", () => {
    expect(manual("let a = dbg!(x) + 1;\nfoo(dbg!(y));\ndbg!(z);", "rust")).toEqual([false, false, false]);
  });
  it("gives a reason for manual findings", () => {
    expect(scan("const f = () => console.log(x);", "js")[0].reason).toMatch(/arrow/i);
  });
});
