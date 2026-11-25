// Runs inside a real VS Code extension host (see run.sh). Plain JS, no test framework.
const vscode = require("vscode");
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  let lastErr;
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { lastErr = e; } // e.g. "Canceled" when the editor re-requests code actions
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what + (lastErr ? " (last error: " + lastErr.message + ")" : ""));
    await sleep(100);
  }
}

exports.run = async function () {
  try {
    await runSuite();
  } catch (e) {
    console.log("[it] FAILED: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
    throw e;
  }
};

async function runSuite() {
  const log = (m) => console.log("[it] " + m);
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const p = (rel) => path.join(ws, rel);
  const relFiles = (api) => api.results().map((r) => path.relative(ws, r.file).split(path.sep).join("/")).sort();

  const ext = vscode.extensions.getExtension("NiravPatel15.pr-ready");
  assert.ok(ext, "extension found");
  const api = await ext.activate();
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ["prReady.checkChanges", "prReady.checkWorkspace", "prReady.fixAll", "prReady.fixFinding", "prReady.ignoreFinding", "prReady.fixFile", "prReady.ignoreFile"]) {
    assert.ok(cmds.includes(c), "command registered: " + c);
  }
  log("commands registered");

  // Check Changes: committed + staged + untracked on the branch; not old.ts (unchanged), keep.ts (file marker), dist/ (excluded)
  await vscode.commands.executeCommand("prReady.checkChanges");
  assert.strictEqual(api.scope(), "changes");
  assert.deepStrictEqual(relFiles(api), ["src/Main.java", "src/app.ts", "src/lib.rs", "src/new.js"]);
  const counts = Object.fromEntries(api.results().map((r) => [path.basename(r.file), r.findings.map((f) => f.ruleId + (f.manual ? "(manual)" : ""))]));
  assert.deepStrictEqual(counts["app.ts"], ["console.log", "console.debug(manual)"]);
  assert.deepStrictEqual(counts["lib.rs"], ["println!", "dbg!"]);
  log("check changes: " + JSON.stringify(counts));

  // Check Workspace also finds the old file
  await api.checkWorkspace();
  assert.deepStrictEqual(relFiles(api), ["src/Main.java", "src/app.ts", "src/lib.rs", "src/new.js", "src/old.ts"]);
  log("check workspace finds old.ts too");

  // Live diagnostics + quick fixes
  const doc = await vscode.workspace.openTextDocument(p("src/app.ts"));
  await vscode.window.showTextDocument(doc);
  const diags = await until(() => {
    const d = vscode.languages.getDiagnostics(doc.uri).filter((x) => x.source === "PR Ready");
    return d.length === 2 && d;
  }, "diagnostics");
  assert.strictEqual(diags[0].severity, vscode.DiagnosticSeverity.Warning);
  assert.strictEqual(diags[0].range.start.line, 2);
  // ask for quick fixes explicitly (what Ctrl+. requests); without a kind, results from slower providers can be dropped
  // The first request right after opening a file can come back without our actions (other providers warming up), so retry briefly.
  const actions = await until(async () => {
    const a = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", doc.uri, diags[0].range, "quickfix");
    return a.some((x) => x.title.startsWith("Remove debug statement")) && a;
  }, "quick fixes", 5000);
  const titles = actions.map((a) => a.title);
  for (const t of ["Remove debug statement (console.log)", "Ignore this line (console.log)", "Ignore debug statements in this file"]) {
    assert.ok(titles.includes(t), "action " + t + " in " + JSON.stringify(titles));
  }
  const manualActions = await until(() => vscode.commands.executeCommand("vscode.executeCodeActionProvider", doc.uri, diags[1].range, "quickfix"), "manual actions");
  assert.ok(manualActions.some((a) => a.title === "Ignore this line (console.debug)"), "manual finding can be ignored");
  assert.ok(!manualActions.some((a) => a.title.startsWith("Remove debug statement (console.debug)")), "manual finding has no remove action");
  const fixAllOnSave = await until(() => vscode.commands.executeCommand("vscode.executeCodeActionProvider", doc.uri, new vscode.Range(0, 0, 0, 0), "source.fixAll.prReady"), "fix-all action");
  assert.deepStrictEqual(fixAllOnSave.map((a) => a.title), ["Remove all debug statements in file"]);
  await vscode.workspace.applyEdit(actions.find((a) => a.title.startsWith("Remove debug statement")).edit);
  assert.ok(!doc.getText().includes('console.log("run"'), "console.log removed");
  assert.ok(doc.getText().includes("console.debug(x)"), "manual one kept");
  await until(() => vscode.languages.getDiagnostics(doc.uri).filter((x) => x.source === "PR Ready").length === 1, "diagnostics update");
  await doc.save();
  log("diagnostics and quick fix work");

  // Tree actions: ignore println! on its line, then fix the file (dbg! unwrapped)
  const lib = api.results().find((r) => r.file.endsWith("lib.rs"));
  const node = (r, f) => ({ type: "finding", file: { uri: vscode.Uri.file(r.file), findings: r.findings }, finding: f });
  await vscode.commands.executeCommand("prReady.ignoreFinding", node(lib, lib.findings[0]));
  await vscode.commands.executeCommand("prReady.fixFile", vscode.Uri.file(lib.file));
  const libText = fs.readFileSync(p("src/lib.rs"), "utf8");
  assert.strictEqual(libText, 'pub fn lib() -> i32 {\n    // pr-ready-ignore\n    println!("lib called");\n    let v = (1 + 1) * 2;\n    v\n}\n');
  log("ignore line + fix file in lib.rs");

  // Fix all (no confirmation in tests): only the manual finding remains
  await vscode.commands.executeCommand("prReady.fixAll", "noConfirm");
  const left = api.results().flatMap((r) => r.findings.map((f) => path.basename(r.file) + ":" + f.ruleId));
  assert.deepStrictEqual(left, ["app.ts:console.debug"]);
  assert.strictEqual(fs.readFileSync(p("src/Main.java"), "utf8"), "class Main {\n    public static void main(String[] args) {\n    }\n}\n");
  assert.strictEqual(fs.readFileSync(p("src/new.js"), "utf8"), "function x() {\n}\n");
  log("fix all leaves only the manual finding");

  // Ignore file via command on the active editor
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("prReady.ignoreFile");
  assert.ok(doc.getText().startsWith("// pr-ready-ignore-file\n"));
  await until(() => vscode.languages.getDiagnostics(doc.uri).filter((x) => x.source === "PR Ready").length === 0, "file ignored");
  assert.deepStrictEqual(api.results(), []);
  log("ignore file works");
  log("ALL PASSED");
}
