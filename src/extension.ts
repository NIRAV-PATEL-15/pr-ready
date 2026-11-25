import * as path from "path";
import * as vscode from "vscode";
import { readSettings } from "./config";
import { fixAllEdits, ignoreFileEdit, ignoreLineEdit } from "./core/fixes";
import { getChangedFiles } from "./core/git";
import { isPathIgnored } from "./core/glob";
import { langForLanguageId, langForPath, SCANNED_EXTENSIONS } from "./core/languages";
import { scan } from "./core/scanner";
import type { Edit, Finding, Lang } from "./core/types";
import { FileResult, Node, ResultsProvider } from "./results";

const SOURCE = "PR Ready";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FIX_ALL_KIND = vscode.CodeActionKind.SourceFixAll.append("prReady");

/** Language of a document we should scan, or undefined if it is not one of ours or is excluded. */
function docLang(doc: vscode.TextDocument): Lang | undefined {
  const lang = langForLanguageId(doc.languageId) ?? (doc.uri.scheme === "untitled" ? undefined : langForPath(doc.uri.path));
  if (!lang) return undefined;
  if (doc.uri.scheme !== "untitled" && /\.d\.[mc]?ts$/i.test(doc.uri.path)) return undefined;
  if (isExcluded(doc.uri)) return undefined;
  return lang;
}

function isExcluded(uri: vscode.Uri): boolean {
  if (uri.scheme === "untitled") return false;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const rel = folder ? path.posix.relative(folder.uri.path, uri.path) : uri.path.replace(/^\/+/, "");
  return isPathIgnored(rel, readSettings(uri).ignorePaths);
}

function scanDoc(doc: vscode.TextDocument): Finding[] {
  const lang = docLang(doc);
  if (!lang) return [];
  return scan(doc.getText(), lang, { rules: readSettings(doc.uri).rules });
}

function toRange(doc: vscode.TextDocument, start: number, end: number): vscode.Range {
  return new vscode.Range(doc.positionAt(start), doc.positionAt(end));
}

function toWorkspaceEdit(doc: vscode.TextDocument, edits: Edit[]): vscode.WorkspaceEdit {
  const we = new vscode.WorkspaceEdit();
  for (const e of edits) we.replace(doc.uri, toRange(doc, e.start, e.end), e.newText);
  return we;
}

function diagnosticFor(doc: vscode.TextDocument, f: Finding): vscode.Diagnostic {
  const msg = f.manual
    ? `Debug statement (${f.ruleId}): remove it by hand or ignore it. ${f.reason ?? ""}`.trim()
    : `Debug statement (${f.ruleId}): remove it before opening a pull request, or ignore it if it is intentional.`;
  const d = new vscode.Diagnostic(toRange(doc, f.start, f.end), msg, vscode.DiagnosticSeverity.Warning);
  d.source = SOURCE;
  d.code = f.ruleId;
  return d;
}

export interface PrReadyApi {
  results(): { file: string; findings: Finding[] }[];
  scope(): string | undefined;
  checkChanges(): Promise<void>;
  checkWorkspace(): Promise<void>;
  scanText(text: string, lang: Lang): Finding[];
}

export function activate(context: vscode.ExtensionContext): PrReadyApi {
  const diagnostics = vscode.languages.createDiagnosticCollection("pr-ready");
  const results = new ResultsProvider();
  const view = vscode.window.createTreeView("prReady.results", { treeDataProvider: results, showCollapseAll: true });
  const status = vscode.window.createStatusBarItem("prReady.status", vscode.StatusBarAlignment.Left, 50);
  status.name = "PR Ready Check";
  status.command = "prReady.results.focus";
  context.subscriptions.push(diagnostics, view, status);

  const updateStatus = () => {
    const n = results.count;
    if (!results.scope) { status.hide(); return; }
    const manual = results.all.reduce((a, f) => a + f.findings.filter((x) => x.manual).length, 0);
    status.text = n ? `$(debug-console) ${n}` : "$(check) PR ready";
    status.tooltip = n
      ? `PR Ready Check: ${n} debug statement${n === 1 ? "" : "s"}${manual ? ` (${manual} manual)` : ""} in ${results.all.length} file${results.all.length === 1 ? "" : "s"}`
      : "PR Ready Check: no debug statements found";
    status.backgroundColor = n ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.show();
    view.badge = n ? { value: n, tooltip: status.tooltip } : undefined;
  };
  results.onDidChangeTreeData(updateStatus, undefined, context.subscriptions);

  // ------------------------------------------------------------ live diagnostics
  const refreshDoc = (doc: vscode.TextDocument) => {
    if (!docLang(doc)) {
      diagnostics.delete(doc.uri);
      return;
    }
    const findings = scanDoc(doc);
    if (readSettings(doc.uri).enableDiagnostics) diagnostics.set(doc.uri, findings.map((f) => diagnosticFor(doc, f)));
    else diagnostics.delete(doc.uri);
    results.update(doc.uri, findings);
  };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleRefresh = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => { timers.delete(key); refreshDoc(doc); }, 250));
  };
  context.subscriptions.push(
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.workspace.onDidOpenTextDocument(refreshDoc),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleRefresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("prReady")) vscode.workspace.textDocuments.forEach(refreshDoc);
    }),
  );
  vscode.workspace.textDocuments.forEach(refreshDoc);

  // ------------------------------------------------------------ quick fixes
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      ["javascript", "javascriptreact", "typescript", "typescriptreact", "java", "rust"].flatMap((language) => [
        { language, scheme: "file" },
        { language, scheme: "untitled" },
      ]),
      {
        provideCodeActions(doc, range, ctx) {
          const lang = docLang(doc);
          if (!lang) return [];
          const findings = scanDoc(doc);
          const text = doc.getText();
          const actions: vscode.CodeAction[] = [];
          const fixable = findings.filter((f) => f.fix);
          const fixAll = (kind: vscode.CodeActionKind) => {
            const a = new vscode.CodeAction("Remove all debug statements in file", kind);
            a.edit = toWorkspaceEdit(doc, fixAllEdits(text, findings));
            return a;
          };
          if (ctx.only && (ctx.only.contains(FIX_ALL_KIND) || FIX_ALL_KIND.contains(ctx.only))) {
            return fixable.length ? [fixAll(FIX_ALL_KIND)] : [];
          }
          const here = findings.filter((f) => toRange(doc, f.start, f.end).intersection(range) !== undefined);
          if (!here.length) return [];
          const ours = ctx.diagnostics.filter((d) => d.source === SOURCE);
          for (const f of here) {
            const fr = toRange(doc, f.start, f.end);
            const diags = ours.filter((d) => d.range.isEqual(fr));
            if (f.fix) {
              const a = new vscode.CodeAction(`Remove debug statement (${f.ruleId})`, vscode.CodeActionKind.QuickFix);
              a.edit = toWorkspaceEdit(doc, [f.fix]);
              a.diagnostics = diags;
              a.isPreferred = true;
              actions.push(a);
            }
            const ig = new vscode.CodeAction(`Ignore this line (${f.ruleId})`, vscode.CodeActionKind.QuickFix);
            ig.edit = toWorkspaceEdit(doc, [ignoreLineEdit(text, lang, f)]);
            ig.diagnostics = diags;
            actions.push(ig);
          }
          const igFile = new vscode.CodeAction("Ignore debug statements in this file", vscode.CodeActionKind.QuickFix);
          igFile.edit = toWorkspaceEdit(doc, [ignoreFileEdit(text)]);
          actions.push(igFile);
          if (fixable.length > 1 || (fixable.length === 1 && !here.includes(fixable[0]))) actions.push(fixAll(vscode.CodeActionKind.QuickFix));
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, FIX_ALL_KIND] },
    ),
  );

  // ------------------------------------------------------------ applying edits to files
  /** Applies edits computed from the file's current text, then saves it if it was not dirty before. */
  const editFile = async (uri: vscode.Uri, compute: (text: string, lang: Lang, findings: Finding[]) => Edit[]): Promise<number> => {
    const doc = await vscode.workspace.openTextDocument(uri);
    const lang = docLang(doc) ?? langForPath(uri.path);
    if (!lang) return 0;
    const wasDirty = doc.isDirty;
    const text = doc.getText();
    const findings = scan(text, lang, { rules: readSettings(uri).rules });
    const edits = compute(text, lang, findings);
    if (!edits.length) { refreshDoc(doc); return 0; }
    const ok = await vscode.workspace.applyEdit(toWorkspaceEdit(doc, edits));
    if (!ok) throw new Error(`Could not edit ${vscode.workspace.asRelativePath(uri)}.`);
    if (!wasDirty) await doc.save();
    refreshDoc(doc);
    return edits.length;
  };

  /** Finds the current version of a finding shown in the tree (the file may have changed since the scan). */
  const locate = (old: Finding, findings: Finding[]): Finding | undefined => {
    const same = findings.filter((f) => f.ruleId === old.ruleId && f.text === old.text);
    same.sort((a, b) => Math.abs(a.line - old.line) - Math.abs(b.line - old.line));
    return same[0];
  };

  const nodeFromArg = (arg: unknown): Node | undefined => (arg && typeof arg === "object" && "type" in arg ? (arg as Node) : undefined);

  const fileFromArg = (arg: unknown): vscode.Uri | undefined => {
    const node = nodeFromArg(arg);
    if (node) return node.file.uri;
    if (arg instanceof vscode.Uri) return arg;
    return vscode.window.activeTextEditor?.document.uri;
  };

  const report = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { vscode.window.showErrorMessage(`PR Ready Check: ${(e as Error).message}`); }
  };

  // ------------------------------------------------------------ checks
  const readText = async (uri: vscode.Uri): Promise<string | undefined> => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return undefined;
      return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  };

  const scanUris = async (uris: vscode.Uri[], token?: vscode.CancellationToken): Promise<{ scanned: vscode.Uri[]; found: FileResult[] }> => {
    const found: FileResult[] = [];
    const scanned: vscode.Uri[] = [];
    for (const uri of uris) {
      if (token?.isCancellationRequested) break;
      const lang = langForPath(uri.path);
      if (!lang || isExcluded(uri)) continue;
      const text = await readText(uri);
      if (text === undefined || text.includes("\0")) continue;
      scanned.push(uri);
      const findings = scan(text, lang, { rules: readSettings(uri).rules });
      if (findings.length) found.push({ uri, findings });
    }
    return { scanned, found };
  };

  const finishCheck = (scope: "changes" | "workspace", scanned: vscode.Uri[], found: FileResult[], note?: string) => {
    results.replaceAll(scope, scanned, found);
    const n = results.count;
    const what = scope === "changes" ? "changed file" : "file";
    view.message = [
      note,
      `${n ? n : "No"} debug statement${n === 1 ? "" : "s"} in ${scanned.length} ${what}${scanned.length === 1 ? "" : "s"}.`,
    ].filter(Boolean).join(" ");
    void vscode.commands.executeCommand("prReady.results.focus");
  };

  const checkChanges = async () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
    if (!folders.length) {
      vscode.window.showWarningMessage("PR Ready Check: open a folder that is a git repository to check its changes.");
      return;
    }
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage("PR Ready Check: Check Changes runs git, so it needs a trusted workspace. Use Check Workspace instead, or trust this folder.");
      return;
    }
    await vscode.window.withProgress(
      { location: { viewId: "prReady.results" }, title: "Checking changed files" },
      async () => {
        const uris = new Map<string, vscode.Uri>();
        const notes: string[] = [];
        let gitFolders = 0;
        for (const folder of folders) {
          const r = await getChangedFiles(folder.uri.fsPath, { baseBranch: readSettings(folder.uri).baseBranch });
          if (r.kind === "no-git") { notes.push(`${folder.name}: ${r.message}`); continue; }
          gitFolders++;
          if (r.note) notes.push(folders.length > 1 ? `${folder.name}: ${r.note}` : r.note);
          const prefix = folder.uri.fsPath.endsWith(path.sep) ? folder.uri.fsPath : folder.uri.fsPath + path.sep;
          for (const f of r.files) if (f.startsWith(prefix)) uris.set(f, vscode.Uri.file(f));
        }
        if (!gitFolders) {
          vscode.window.showWarningMessage(`PR Ready Check: ${notes.join(" ") || "no git repository found."} Use "PR Ready: Check Workspace" instead.`);
          return;
        }
        const { scanned, found } = await scanUris([...uris.values()]);
        finishCheck("changes", scanned, found, notes.join(" ") || undefined);
      },
    );
  };

  const checkWorkspace = async () => {
    if (!vscode.workspace.workspaceFolders?.length) {
      vscode.window.showWarningMessage("PR Ready Check: open a folder to check it.");
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PR Ready Check: scanning workspace", cancellable: true },
      async (_p, token) => {
        const uris = await vscode.workspace.findFiles(`**/*.{${SCANNED_EXTENSIONS.join(",")}}`, "**/{node_modules,.git}/**", undefined, token);
        const { scanned, found } = await scanUris(uris, token);
        if (token.isCancellationRequested) return;
        finishCheck("workspace", scanned, found);
      },
    );
  };

  const rescanResults = async () => {
    for (const f of results.all) {
      const text = await readText(f.uri);
      const lang = langForPath(f.uri.path);
      if (text !== undefined && lang) results.update(f.uri, scan(text, lang, { rules: readSettings(f.uri).rules }));
    }
  };

  // ------------------------------------------------------------ commands
  const reg = (id: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("prReady.checkChanges", () => report(checkChanges()));
  reg("prReady.checkWorkspace", () => report(checkWorkspace()));
  reg("prReady.clearResults", () => { results.clear(); view.message = undefined; });

  reg("prReady.openFinding", async (arg) => {
    const node = nodeFromArg(arg);
    if (!node || node.type !== "finding") return;
    const doc = await vscode.workspace.openTextDocument(node.file.uri);
    const cur = locate(node.finding, scanDoc(doc)) ?? node.finding;
    const r = toRange(doc, cur.start, cur.end);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(r.start, r.start), preserveFocus: false });
  });

  reg("prReady.fixFinding", (arg) => report((async () => {
    const node = nodeFromArg(arg);
    if (!node || node.type !== "finding") return;
    let missing = false;
    await editFile(node.file.uri, (_t, _l, findings) => {
      const cur = locate(node.finding, findings);
      if (!cur) { missing = true; return []; }
      if (!cur.fix) throw new Error(`This ${cur.ruleId} cannot be removed automatically: ${cur.reason ?? ""}`);
      return [cur.fix];
    });
    if (missing) vscode.window.showInformationMessage("PR Ready Check: that debug statement is no longer there.");
  })()));

  reg("prReady.ignoreFinding", (arg) => report((async () => {
    const node = nodeFromArg(arg);
    if (!node || node.type !== "finding") return;
    await editFile(node.file.uri, (text, lang, findings) => {
      const cur = locate(node.finding, findings);
      return cur ? [ignoreLineEdit(text, lang, cur)] : [];
    });
  })()));

  reg("prReady.fixFile", (arg) => report((async () => {
    const uri = fileFromArg(arg);
    if (!uri) return;
    const n = await editFile(uri, (text, _l, findings) => fixAllEdits(text, findings));
    if (!n) vscode.window.showInformationMessage("PR Ready Check: nothing to remove automatically in this file.");
  })()));

  reg("prReady.ignoreFile", (arg) => report((async () => {
    const uri = fileFromArg(arg);
    if (!uri) return;
    await editFile(uri, (text, _l, findings) => (findings.length ? [ignoreFileEdit(text)] : []));
  })()));

  reg("prReady.fixAll", (arg) => report((async () => {
    const auto = arg === "noConfirm";
    const files = results.all.filter((f) => f.findings.some((x) => x.fix));
    const total = files.reduce((a, f) => a + f.findings.filter((x) => x.fix).length, 0);
    if (!total) {
      vscode.window.showInformationMessage("PR Ready Check: nothing to remove automatically.");
      return;
    }
    const manual = results.count - total;
    if (!auto) {
      const ok = await vscode.window.showWarningMessage(
        `Remove ${total} debug statement${total === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}?`,
        { modal: true, detail: (manual ? `${manual} manual finding${manual === 1 ? "" : "s"} will be left for you. ` : "") + "Files that had no unsaved changes are saved afterwards; you can undo in each editor." },
        "Remove",
      );
      if (ok !== "Remove") return;
    }
    for (const f of files) await editFile(f.uri, (text, _l, findings) => fixAllEdits(text, findings));
    await rescanResults();
  })()));

  return {
    results: () => results.all.map((f) => ({ file: f.uri.fsPath, findings: f.findings })),
    scope: () => results.scope,
    checkChanges,
    checkWorkspace,
    scanText: (text, lang) => scan(text, lang),
  };
}

export function deactivate(): void {}
