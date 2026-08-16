import * as vscode from "vscode";
import type { ChorusController } from "./controller.js";
export declare class SessionViewProvider implements vscode.WebviewViewProvider {
    private readonly controller;
    static readonly viewType = "chorus.session";
    private view?;
    constructor(controller: ChorusController);
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void;
    private render;
}
