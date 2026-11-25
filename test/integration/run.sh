#!/usr/bin/env bash
# Usage: test/integration/run.sh <scratch-dir>   — launches VS Code with an isolated profile on a fixture git repo
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="${1:?scratch dir}"
rm -rf "$TMP/ud" "$TMP/ext" "$TMP/ws"; mkdir -p "$TMP/ud" "$TMP/ext" "$TMP/ws"
WS="$TMP/ws"
g() { git -C "$WS" -c user.name=it -c user.email=it@example.invalid -c commit.gpgsign=false "$@"; }

# main: clean files plus one old file that already has a console.log
g init -q -b main
mkdir -p "$WS/src" "$WS/dist"
printf 'export const a = 1;\n' > "$WS/src/app.ts"
printf 'export function old() {\n  console.log("old");\n}\n' > "$WS/src/old.ts"
printf 'pub fn lib() -> i32 {\n    1\n}\n' > "$WS/src/lib.rs"
g add -A && g commit -qm base

# feature branch: committed, staged and untracked changes
g checkout -qb feature
cat > "$WS/src/app.ts" <<'TS'
export const a = 1;
export function run(xs: number[]) {
  console.log("run", xs);
  const each = (x: number) => console.debug(x);
  xs.forEach(each);
}
TS
cat > "$WS/src/lib.rs" <<'RS'
pub fn lib() -> i32 {
    println!("lib called");
    let v = dbg!(1 + 1) * 2;
    v
}
RS
g add -A && g commit -qm feature
cat > "$WS/src/Main.java" <<'JAVA'
class Main {
    public static void main(String[] args) {
        System.out.println("hello");
    }
}
JAVA
g add src/Main.java
printf 'function x() {\n  debugger;\n}\n' > "$WS/src/new.js"
printf '// pr-ready-ignore-file\nconsole.log("kept");\n' > "$WS/src/keep.ts"
printf 'console.log("built");\n' > "$WS/dist/bundle.js"

# fresh profile: trust the fixture folder (Check Changes needs a trusted workspace to run git)
mkdir -p "$TMP/ud/User"
printf '{ "security.workspace.trust.enabled": false }\n' > "$TMP/ud/User/settings.json"

code --user-data-dir "$TMP/ud" --extensions-dir "$TMP/ext" --disable-extensions --new-window \
  --extensionDevelopmentPath="$ROOT" --extensionTestsPath="$ROOT/test/integration/suite.js" --wait "$WS"

# The extension host's console goes to the renderer log, and `code --wait` does not return the test result.
LOG="$(ls -t "$TMP"/ud/logs/*/window1/renderer.log | head -1)"
grep -E "\[it\]|AssertionError|Error:|^\s+at |^[+-] " "$LOG" | sed -E 's/^[0-9-]+ [0-9:.]+ \[[a-z]+\] //' || true
grep -q "\[it\] ALL PASSED" "$LOG"
