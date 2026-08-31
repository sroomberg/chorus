import * as vscode from "vscode";
import { ChorusController } from "./controller.js";
import { SessionViewProvider } from "./sessionView.js";
export function activate(context) {
    const output = vscode.window.createOutputChannel("Chorus");
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.show();
    const controller = new ChorusController(output, statusBar);
    const viewProvider = new SessionViewProvider(controller);
    context.subscriptions.push(output, statusBar, controller, vscode.window.registerWebviewViewProvider(SessionViewProvider.viewType, viewProvider));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.share", async () => {
        try {
            const rolePick = await vscode.window.showQuickPick([
                { label: "edit", description: "Can send prompts (default)" },
                { label: "view", description: "Read-only" },
                { label: "admin", description: "Full control" },
            ], { title: "Chorus share role for join token" });
            const role = (rolePick?.label ?? "edit");
            const joinCommand = await controller.share(role);
            output.show(true);
            void vscode.commands.executeCommand("chorus.session.focus");
            return joinCommand;
        }
        catch (err) {
            void vscode.window.showErrorMessage(`Chorus share failed: ${String(err)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.join", async () => {
        try {
            const token = await vscode.window.showInputBox({
                title: "Chorus join token",
                prompt: "Paste the token from the host's share command",
                ignoreFocusOut: true,
            });
            if (!token)
                return;
            const host = await vscode.window.showInputBox({
                title: "Chorus relay host",
                prompt: "host:port (e.g. 192.168.1.5:7742)",
                ignoreFocusOut: true,
                value: "127.0.0.1:7742",
            });
            if (!host)
                return;
            const name = await vscode.window.showInputBox({
                title: "Display name",
                prompt: "Required — shown to collaborators (cannot be empty)",
                ignoreFocusOut: true,
                value: vscode.workspace.getConfiguration("chorus").get("displayName") || "",
            });
            if (name !== undefined && !name.trim()) {
                void vscode.window.showErrorMessage("Display name is required.");
                return;
            }
            await controller.join(token.trim(), host.trim(), name?.trim() || undefined);
            output.show(true);
            const mode = controller.getMode();
            void vscode.window.showInformationMessage(mode === "pending" ? "Connected — waiting for host approval" : "Joined Chorus session");
        }
        catch (err) {
            void vscode.window.showErrorMessage(`Chorus join failed: ${String(err)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.approve", async () => {
        try {
            const pending = controller.getPendingUsers();
            if (!pending.length) {
                const userId = await vscode.window.showInputBox({
                    title: "Approve joiner",
                    prompt: "Pending user id",
                    ignoreFocusOut: true,
                });
                if (!userId)
                    return;
                controller.approveUser(userId.trim());
                return;
            }
            const pick = await vscode.window.showQuickPick(pending.map((u) => ({
                label: u.displayName,
                description: `${u.role} · ${u.userId}`,
                userId: u.userId,
            })), { title: "Approve joiner" });
            if (!pick)
                return;
            controller.approveUser(pick.userId);
        }
        catch (err) {
            void vscode.window.showErrorMessage(String(err));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.deny", async () => {
        try {
            const pending = controller.getPendingUsers();
            if (!pending.length) {
                const userId = await vscode.window.showInputBox({
                    title: "Deny joiner",
                    prompt: "Pending user id",
                    ignoreFocusOut: true,
                });
                if (!userId)
                    return;
                controller.denyUser(userId.trim());
                return;
            }
            const pick = await vscode.window.showQuickPick(pending.map((u) => ({
                label: u.displayName,
                description: `${u.role} · ${u.userId}`,
                userId: u.userId,
            })), { title: "Deny joiner" });
            if (!pick)
                return;
            controller.denyUser(pick.userId);
        }
        catch (err) {
            void vscode.window.showErrorMessage(String(err));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.leave", async () => {
        await controller.leave();
        void vscode.window.showInformationMessage("Left Chorus session");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.stop", async () => {
        await controller.stop();
        void vscode.window.showInformationMessage("Stopped Chorus sharing");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.chat", async () => {
        try {
            const message = await vscode.window.showInputBox({
                title: "Chorus chat",
                prompt: "Side-channel message (does not enter the LLM transcript)",
                ignoreFocusOut: true,
            });
            if (!message)
                return;
            controller.sendChat(message);
        }
        catch (err) {
            void vscode.window.showErrorMessage(String(err));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.sendPrompt", async () => {
        try {
            const content = await vscode.window.showInputBox({
                title: "Send prompt to Chorus host",
                prompt: "Forwarded as collab.input into the shared session",
                ignoreFocusOut: true,
            });
            if (!content)
                return;
            controller.sendPrompt(content);
        }
        catch (err) {
            void vscode.window.showErrorMessage(String(err));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.publishHostMessage", async () => {
        try {
            const content = await vscode.window.showInputBox({
                title: "Publish host message",
                prompt: "Pushed to all joiners as a session user event",
                ignoreFocusOut: true,
            });
            if (!content)
                return;
            controller.publishHostMessage(content, "user");
        }
        catch (err) {
            void vscode.window.showErrorMessage(String(err));
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.status", async () => {
        const text = controller.statusText();
        output.appendLine(text);
        output.show(true);
        await vscode.window.showInformationMessage(`Chorus mode: ${controller.getMode()}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("chorus.openSession", async () => {
        await vscode.commands.executeCommand("chorus.session.focus");
    }));
}
export function deactivate() {
    // disposables handled via subscriptions
}
//# sourceMappingURL=extension.js.map