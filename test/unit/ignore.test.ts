import { describe, it, expect } from "vitest";
import { scan, hasFileMarker } from "../../src/core/scanner";
import { isPathIgnored, globToRegExp, DEFAULT_IGNORE_PATHS } from "../../src/core/glob";
import { langForPath } from "../../src/core/languages";

describe("ignore level 1: this line", () => {
  it("skips a finding whose previous line has the marker", () => {
    const src = "// pr-ready-ignore\nconsole.log(1);\nconsole.log(2);";
    expect(scan(src, "js").map((x) => x.line)).toEqual([2]);
  });
  it("works in java and rust, with indentation and extra text after the marker", () => {
    expect(scan("    // pr-ready-ignore: intentional CLI output\n    System.out.println(1);", "java")).toEqual([]);
    expect(scan('    // pr-ready-ignore\n    println!("usage");\n    dbg!(x);', "rust").map((x) => x.ruleId)).toEqual(["dbg!"]);
  });
  it("accepts a marker at the end of the same line", () => {
    expect(scan("console.log(1); // pr-ready-ignore", "js")).toEqual([]);
  });
  it("applies to the first line of a multi-line statement", () => {
    expect(scan("// pr-ready-ignore\nconsole.log(\n  1\n);", "js")).toEqual([]);
  });
  it("does not apply two lines down", () => {
    expect(scan("// pr-ready-ignore\n\nconsole.log(1);", "js")).toHaveLength(1);
  });
  it("is not triggered by the marker inside a string", () => {
    expect(scan('const s = "// pr-ready-ignore";\nconsole.log(s);', "js")).toHaveLength(1);
  });
  it("the file marker is not a line marker and vice versa", () => {
    expect(scan("// pr-ready-ignorex\nconsole.log(1);", "js")).toHaveLength(1);
  });
  it("can be disabled for listing ignored findings", () => {
    expect(scan("// pr-ready-ignore\nconsole.log(1);", "js", { respectMarkers: false })).toHaveLength(1);
  });
});

describe("ignore level 2: this file", () => {
  it("skips every finding when the file marker is present anywhere", () => {
    const src = "console.log(1);\nfoo();\n// pr-ready-ignore-file\nconsole.log(2);";
    expect(hasFileMarker(src, "js")).toBe(true);
    expect(scan(src, "js")).toEqual([]);
  });
  it("works as a block comment and in every language", () => {
    expect(scan("/* pr-ready-ignore-file */\nSystem.out.println(1);", "java")).toEqual([]);
    expect(scan("// pr-ready-ignore-file\nprintln!(\"x\");", "rust")).toEqual([]);
  });
  it("is not triggered from inside a string", () => {
    expect(scan('const s = "// pr-ready-ignore-file"; console.log(s);', "js")).toHaveLength(1);
  });
});

describe("ignore level 3: path patterns", () => {
  it("excludes the default folders anywhere in the tree", () => {
    for (const p of ["node_modules/x/a.js", "pkg/node_modules/y.js", "dist/a.js", "build/b.ts", "out/c.js", "target/debug/build/x.rs", ".git/hooks/a.js", "a/b/dist/c.js"]) {
      expect(isPathIgnored(p, DEFAULT_IGNORE_PATHS), p).toBe(true);
    }
    for (const p of ["src/a.ts", "src/distance.ts", "outer/a.js", "src/builder/x.rs"]) {
      expect(isPathIgnored(p, DEFAULT_IGNORE_PATHS), p).toBe(false);
    }
  });
  it("matches user globs", () => {
    expect(isPathIgnored("scripts/dev.js", ["scripts/**"])).toBe(true);
    expect(isPathIgnored("src/cli/main.rs", ["**/cli/*.rs"])).toBe(true);
    expect(isPathIgnored("src/a.test.ts", ["**/*.test.{ts,js}"])).toBe(true);
    expect(isPathIgnored("src/a.ts", ["**/*.test.{ts,js}"])).toBe(false);
    expect(isPathIgnored("a/b.js", ["?/b.js"])).toBe(true);
  });
  it("a pattern without a slash matches a file name at any depth", () => {
    expect(isPathIgnored("deep/x/Main.java", ["Main.java"])).toBe(true);
    expect(isPathIgnored("deep/x/Main.java", ["*.java"])).toBe(true);
  });
  it("normalises backslashes", () => {
    expect(isPathIgnored("src\\gen\\a.ts", ["src/gen/**"])).toBe(true);
  });
  it("escapes regex characters in globs", () => {
    expect(globToRegExp("a+b(c).js").test("a+b(c).js")).toBe(true);
    expect(globToRegExp("a+b(c).js").test("aab(c)xjs")).toBe(false);
  });
});

describe("languages", () => {
  it("maps extensions", () => {
    expect(["a.js", "a.jsx", "a.mjs", "a.cjs", "a.ts", "a.tsx", "A.java", "m.rs", "x.py", "a.d.ts", "README"].map(langForPath))
      .toEqual(["js", "js", "js", "js", "js", "js", "java", "rust", undefined, undefined, undefined]);
  });
});
