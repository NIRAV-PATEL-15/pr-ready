# Changelog

## 0.1.0 — 2026-11-25
First release.
- Finds leftover debug statements in JavaScript/TypeScript (`console.*`, `debugger`), Java (`System.out/err.print*`,
  `printStackTrace()`) and Rust (`println!`, `print!`, `eprintln!`, `eprint!`, `dbg!`), never inside comments or strings.
- Live warnings with quick fixes: remove, ignore this line, ignore this file, remove all in file.
- **Check Changes** (files changed on the current branch) and **Check Workspace**, with a results view, Fix / Ignore
  buttons, Fix All and a status bar count.
- Safe removal: whole lines when the statement is alone, `dbg!(x)` unwrapped to `x`, and "manual" findings when removal
  could break the code.
- Ignore by line (`// pr-ready-ignore`), by file (`// pr-ready-ignore-file`) or by path (`prReady.ignorePaths`).
