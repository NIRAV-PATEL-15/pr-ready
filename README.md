# PR Ready Check

Find leftover debug statements in **JavaScript, TypeScript, Java and Rust** before you open a pull request.
Some print statements are intentional and some were forgotten, so every finding offers two choices:
**Fix** (remove it) or **Ignore** (keep it and stop flagging it).

## What it finds
| Language | Files | Debug statements |
|---|---|---|
| JavaScript / TypeScript | `.js .jsx .mjs .cjs .ts .tsx .mts .cts` (not `.d.ts`) | `console.log/debug/info/warn/error/trace/dir/table/time/timeEnd/group/groupEnd/count/assert(...)`, `debugger;` |
| Java | `.java` | `System.out.print/println/printf(...)`, `System.err.print/println/printf(...)`, `<expr>.printStackTrace()`, method references like `System.out::println` (manual only) |
| Rust | `.rs` | `println!`, `print!`, `eprintln!`, `eprint!`, `dbg!` (also `std::println!` etc. and `dbg!(x)` inside expressions) |

Matches inside comments, strings, template literals, regex literals, Java text blocks, char literals and Rust raw strings
(`r#"..."#`) are never reported. A small per-language scanner reads the code, so a statement that spans several lines is
found with its full extent, even with brackets inside strings or comments.

## How to use it
- **While you edit:** debug statements show as warnings in open files (squiggles and the Problems panel).
  Press **Ctrl+.** (Cmd+. on macOS) on one for quick fixes:
  - **Remove debug statement**
  - **Ignore this line**
  - **Ignore debug statements in this file**
  - **Remove all debug statements in file**
- **Before a PR:** open the **PR Ready Check** view in the Activity Bar and click **Check Changes**
  (or run **PR Ready: Check Changes**). It scans the files changed on your branch: commits since the merge-base with the
  default branch (`main`, `master` or `origin/HEAD`), plus staged, unstaged and new untracked files. Results are grouped by
  file, with **Fix** and **Ignore** buttons on each item and each file, and a **Fix All** button. The status bar shows the count.
- **Whole project:** **PR Ready: Check Workspace** scans every supported file in the workspace.

You can also turn on removal on save for these files with
`"editor.codeActionsOnSave": { "source.fixAll.prReady": "explicit" }`.

## How Fix works
- A statement that is alone on its line(s) is removed together with its lines and its `;`.
  Otherwise only the statement is removed and the rest of the line stays.
- `dbg!(x)` inside an expression becomes `x` (with parentheses when needed, e.g. `dbg!(a + b) * 2` → `(a + b) * 2`).
- A Rust print macro used as a match arm (`1 => println!("one"),`) becomes `()`.
- Fix never leaves broken code. When removal is not safe, the finding is marked **manual** and only Ignore is offered.
  Examples: `() => console.log(x)`, `const v = console.log(x)`, `a && console.log(x)`, `if (a) console.log(x);` without
  braces, `x -> System.out.println(x)`, `|x| println!("{}", x)`, and JavaScript where removing the line would join the
  lines around it (no semicolons).
- Files that had no unsaved changes are saved after a fix from the results view; you can undo in the editor.

## How Ignore works
1. **This line:** adds `// pr-ready-ignore` on the line above (works in all four languages). A
   `// pr-ready-ignore` comment at the end of the same line also works.
2. **This file:** a `// pr-ready-ignore-file` comment anywhere in the file.
3. **Paths:** the `prReady.ignorePaths` setting.

## Settings
| Setting | Default | |
|---|---|---|
| `prReady.enableDiagnostics` | `true` | warnings in open files |
| `prReady.rules` | all `true` | turn single rules off, e.g. `{ "console.warn": false, "console.error": false }` |
| `prReady.ignorePaths` | `[]` | globs relative to the workspace folder, e.g. `["scripts/**", "**/*.test.ts"]`; a pattern without `/` matches a file name at any depth |
| `prReady.useDefaultExcludes` | `true` | also skip `node_modules`, `dist`, `build`, `out`, `target` and `.git` folders |
| `prReady.baseBranch` | `""` | branch that Check Changes compares against; empty = `main`, `master`, then `origin/HEAD` |

## Notes and limits
- Check Changes runs `git` (through `execFile`, never a shell) and needs a trusted workspace. In Restricted Mode the live
  warnings and Check Workspace still work.
- Without git, or with no default branch, Check Changes says so (and shows only uncommitted changes when it can).
  A detached HEAD works.
- Debug calls inside a template literal's `${...}` are not reported. In `.jsx`/`.tsx` files, an apostrophe in JSX text
  (`<p>Don't</p>`) can hide a debug statement later on the same line.
- Only the exact forms above are detected: `window.console.log`, `const log = console.log; log(x)`,
  `java.lang.System.out.println` and `PrintStream out = System.out; out.println()` are not.
- Files over 2 MB are skipped by Check Changes / Check Workspace.

## Development
```sh
npm ci
npm test                 # unit tests (vitest)
npm run typecheck
npm run test:integration # smoke test in a real VS Code with an isolated profile (needs `code` and a display)
npm run package          # builds pr-ready-<version>.vsix
```

## License
MIT
