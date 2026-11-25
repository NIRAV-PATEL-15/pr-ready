import { describe, it, expect } from "vitest";
import { tokenize } from "../../src/core/lexer";

const kinds = (src: string, lang: "js" | "java" | "rust") =>
  tokenize(src, lang).map((t) => `${t.kind}:${src.slice(t.start, t.end)}`);

describe("lexer: js", () => {
  it("splits identifiers, punctuation and strings", () => {
    expect(kinds(`console.log("a;b")`, "js")).toEqual([
      "ident:console", "punct:.", "ident:log", "punct:(", "string:\"a;b\"", "punct:)",
    ]);
  });
  it("lexes comments", () => {
    expect(kinds("a // x\n/* y */ b", "js")).toEqual(["ident:a", "comment:// x", "comment:/* y */", "ident:b"]);
  });
  it("lexes template literals with nested expressions and strings as one token", () => {
    const src = "`a ${ {b: `c ${'}'}`} } d` + 1";
    expect(kinds(src, "js")).toEqual(["template:`a ${ {b: `c ${'}'}`} } d`", "punct:+", "number:1"]);
  });
  it("tells regex literals from division", () => {
    expect(kinds("x = /co[/]nsole.log(/g; y = a / b / c", "js")).toEqual([
      "ident:x", "punct:=", "regex:/co[/]nsole.log(/g", "punct:;", "ident:y", "punct:=", "ident:a", "punct:/", "ident:b", "punct:/", "ident:c",
    ]);
    expect(kinds("return /x/.test(s)", "js")[1]).toBe("regex:/x/");
  });
  it("lexes multi-char operators used for context", () => {
    expect(kinds("a => b?.c", "js")).toEqual(["ident:a", "punct:=>", "ident:b", "punct:?.", "ident:c"]);
  });
  it("stops an unterminated string at the end of the line", () => {
    expect(kinds("'abc\nconsole", "js")).toEqual(["string:'abc", "ident:console"]);
  });
});

describe("lexer: java", () => {
  it("lexes text blocks and char literals", () => {
    const src = 'String s = """\n  System.out.println("x");\n  """; char c = \'"\';';
    const k = kinds(src, "java");
    expect(k).toContain('string:"""\n  System.out.println("x");\n  """');
    expect(k).toContain("string:'\"'");
    expect(k).not.toContain("ident:System");
  });
  it("lexes -> and ::", () => {
    expect(kinds("x -> System.out::println", "java")).toEqual([
      "ident:x", "punct:->", "ident:System", "punct:.", "ident:out", "punct:::", "ident:println",
    ]);
  });
});

describe("lexer: rust", () => {
  it("lexes raw strings with hashes", () => {
    const src = 'let s = r##"println!("hi") "# still"##; x';
    expect(kinds(src, "rust")).toEqual(["ident:let", "ident:s", "punct:=", 'string:r##"println!("hi") "# still"##', "punct:;", "ident:x"]);
  });
  it("lexes byte and C strings", () => {
    expect(kinds('b"a" br"b" c"c" cr#"d"#', "rust").every((k) => k.startsWith("string:"))).toBe(true);
  });
  it("lexes nested block comments", () => {
    expect(kinds("/* a /* println!() */ b */ x", "rust")).toEqual(["comment:/* a /* println!() */ b */", "ident:x"]);
  });
  it("tells char literals from lifetimes", () => {
    expect(kinds("fn f<'a>(x: &'a str) { let c = '\"'; let d = '\\''; let e = 'é'; }", "rust")).toEqual([
      "ident:fn", "ident:f", "punct:<", "lifetime:'a", "punct:>", "punct:(", "ident:x", "punct::", "punct:&", "lifetime:'a", "ident:str", "punct:)",
      "punct:{", "ident:let", "ident:c", "punct:=", "string:'\"'", "punct:;", "ident:let", "ident:d", "punct:=", "string:'\\''", "punct:;",
      "ident:let", "ident:e", "punct:=", "string:'é'", "punct:;", "punct:}",
    ]);
  });
  it("lexes => and ::", () => {
    expect(kinds("a => std::x", "rust")).toEqual(["ident:a", "punct:=>", "ident:std", "punct:::", "ident:x"]);
  });
});
