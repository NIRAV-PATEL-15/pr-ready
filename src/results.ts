import * as path from "path";
import * as vscode from "vscode";
import type { Finding } from "./core/types";

export interface FileResult {
  uri: vscode.Uri;
  findings: Finding[];
}

export type Node = { type: "file"; file: FileResult } | { type: "finding"; file: FileResult; finding: Finding };

/** Holds the last Check Changes / Check Workspace result and renders it as a tree. */
export class ResultsProvider implements vscode.TreeDataProvider<Node> {
  private files = new Map<string, FileResult>();
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  scope: "changes" | "workspace" | undefined;

  get all(): FileResult[] {
    return [...this.files.values()].sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
  }

  get count(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.findings.length;
    return n;
  }

  has(uri: vscode.Uri): boolean {
    return this.files.has(uri.toString());
  }

  /** The set of files covered by the current result (including files with no findings). */
  private covered = new Set<string>();

  covers(uri: vscode.Uri): boolean {
    return this.covered.has(uri.toString());
  }

  replaceAll(scope: "changes" | "workspace", scanned: vscode.Uri[], results: FileResult[]): void {
    this.scope = scope;
    this.covered = new Set(scanned.map((u) => u.toString()));
    this.files.clear();
    for (const r of results) if (r.findings.length) this.files.set(r.uri.toString(), r);
    this.emitter.fire(undefined);
  }

  update(uri: vscode.Uri, findings: Finding[]): void {
    if (!this.covers(uri)) return;
    const key = uri.toString();
    const before = this.files.get(key);
    if (findings.length) this.files.set(key, { uri, findings });
    else this.files.delete(key);
    if (before || findings.length) this.emitter.fire(undefined);
  }

  clear(): void {
    this.scope = undefined;
    this.covered.clear();
    this.files.clear();
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.all.map((file) => ({ type: "file" as const, file }));
    if (node.type === "file") return node.file.findings.map((finding) => ({ type: "finding" as const, file: node.file, finding }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "file") {
      const item = new vscode.TreeItem(node.file.uri, vscode.TreeItemCollapsibleState.Expanded);
      const rel = vscode.workspace.asRelativePath(node.file.uri, true);
      const dir = path.posix.dirname(rel.replace(/\\/g, "/"));
      const n = node.file.findings.length;
      item.description = `${dir === "." ? "" : dir + " · "}${n} debug statement${n === 1 ? "" : "s"}`;
      item.contextValue = node.file.findings.some((f) => f.fix) ? "prReadyFile.fixable" : "prReadyFile";
      return item;
    }
    const f = node.finding;
    const firstLine = f.text.split(/\r?\n/)[0];
    const label = firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine + (f.text.includes("\n") ? " …" : "");
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `line ${f.line + 1}${f.manual ? " · manual" : ""}`;
    item.tooltip = new vscode.MarkdownString().appendCodeblock(f.text).appendMarkdown(
      f.manual ? `\n\n**Manual:** ${f.reason ?? "cannot be removed automatically."}` : "",
    );
    item.iconPath = new vscode.ThemeIcon(f.manual ? "warning" : "debug-console");
    item.contextValue = f.fix ? "prReadyFinding.fixable" : "prReadyFinding.manual";
    item.command = {
      command: "prReady.openFinding",
      title: "Open",
      arguments: [node],
    };
    return item;
  }
}
