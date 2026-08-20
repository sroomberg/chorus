import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { encodeHostMessage, decodeRelayToHost, } from "@chorus/shared";
function resolveRelayBin() {
    if (process.env["CHORUS_RELAY_BIN"])
        return process.env["CHORUS_RELAY_BIN"];
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, "../../../../target/release/chorus-relay"),
        join(here, "../../../../target/debug/chorus-relay"),
        join(here, "../../../../../target/release/chorus-relay"),
        join(here, "../../../../../target/debug/chorus-relay"),
    ];
    for (const path of candidates) {
        if (existsSync(path))
            return path;
    }
    return "chorus-relay";
}
function parseRelayHost(raw, fallbackPort) {
    if (!raw)
        return { host: "127.0.0.1", port: fallbackPort };
    // Accept host, host:port, or ws(s)://host:port[/path]
    const trimmed = raw.replace(/^wss?:\/\//, "").replace(/\/.*$/, "");
    const [hostPart, portPart] = trimmed.split(":");
    const port = portPart ? parseInt(portPart, 10) : fallbackPort;
    return { host: hostPart || "127.0.0.1", port: Number.isFinite(port) ? port : fallbackPort };
}
/**
 * Resolve relay connection settings from env.
 *
 * External attach (relay already running elsewhere):
 *   CHORUS_RELAY_HOST=host.docker.internal:7742
 *   CHORUS_HOST_TOKEN=<shared secret>
 *   CHORUS_EXTERNAL_RELAY=1   (optional; implied when HOST_TOKEN is set)
 */
export function relayOptionsFromEnv(defaultPort) {
    const parsed = parseRelayHost(process.env["CHORUS_RELAY_HOST"], defaultPort);
    const hostToken = process.env["CHORUS_HOST_TOKEN"];
    const external = process.env["CHORUS_EXTERNAL_RELAY"] === "1" ||
        process.env["CHORUS_EXTERNAL_RELAY"] === "true" ||
        Boolean(hostToken && process.env["CHORUS_RELAY_HOST"]);
    return {
        port: parsed.port,
        opts: {
            host: parsed.host,
            hostToken: hostToken || undefined,
            external,
        },
    };
}
/**
 * Manages the Rust `chorus-relay` subprocess and the host control WebSocket.
 * Joiner-facing protocol on `/ws` is unchanged; the plugin talks to `/host`.
 */
export class RelayServer {
    port;
    child = null;
    ws = null;
    hostToken = "";
    running = false;
    clients = 0;
    host;
    external;
    pendingToken = null;
    onInjectInput;
    onChatMessage;
    onTyping;
    onUserPending;
    onUserJoined;
    onUserLeft;
    constructor(port, opts = {}) {
        this.port = port;
        this.host = opts.host ?? "127.0.0.1";
        this.external = Boolean(opts.external);
        this.hostToken = opts.hostToken ?? "";
    }
    setInputHandler(fn) {
        this.onInjectInput = fn;
    }
    setChatHandler(fn) {
        this.onChatMessage = fn;
    }
    setTypingHandler(fn) {
        this.onTyping = fn;
    }
    setUserPendingHandler(fn) {
        this.onUserPending = fn;
    }
    setUserJoinedHandler(fn) {
        this.onUserJoined = fn;
    }
    setUserLeftHandler(fn) {
        this.onUserLeft = fn;
    }
    async start() {
        if (this.running)
            return;
        if (this.external) {
            if (!this.hostToken) {
                throw new Error("External relay mode requires CHORUS_HOST_TOKEN (and usually CHORUS_RELAY_HOST).");
            }
            await this.waitForPort();
            await this.connectHost();
            this.running = true;
            return;
        }
        this.hostToken = this.hostToken || randomBytes(32).toString("hex");
        const bin = resolveRelayBin();
        this.child = spawn(bin, ["--port", String(this.port), "--bind", "0.0.0.0", "--host-token", this.hostToken], {
            stdio: ["ignore", "ignore", "pipe"],
            env: { ...process.env },
        });
        this.child.on("exit", () => {
            this.running = false;
            this.ws = null;
        });
        await this.waitForPort();
        await this.connectHost();
        this.running = true;
    }
    statusUrl() {
        return `http://${this.host}:${this.port}/status`;
    }
    hostWsUrl() {
        return `ws://${this.host}:${this.port}/host`;
    }
    async waitForPort(timeoutMs = 8000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(this.statusUrl(), { signal: AbortSignal.timeout(1000) });
                if (res.ok)
                    return;
            }
            catch {
                // not up yet
            }
            await new Promise((r) => setTimeout(r, 40));
        }
        throw new Error(this.external
            ? `External chorus-relay not reachable at ${this.host}:${this.port}. Is it running on the host?`
            : `chorus-relay did not become ready on port ${this.port}. ` +
                `Is the binary available? (CHORUS_RELAY_BIN or cargo build -p chorus-relay --release)`);
    }
    connectHost() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.hostWsUrl());
            this.ws = ws;
            const timer = setTimeout(() => reject(new Error("host control connect timeout")), 5000);
            ws.onopen = () => {
                this.send({ type: "host.auth", token: this.hostToken });
            };
            ws.onmessage = (ev) => {
                let msg;
                try {
                    msg = decodeRelayToHost(String(ev.data));
                }
                catch {
                    return;
                }
                this.handleHostMessage(msg, () => {
                    clearTimeout(timer);
                    resolve();
                });
            };
            ws.onerror = () => {
                clearTimeout(timer);
                reject(new Error("host control WebSocket error"));
            };
            ws.onclose = () => {
                this.ws = null;
                this.running = false;
            };
        });
    }
    handleHostMessage(msg, onReady) {
        switch (msg.type) {
            case "host.ready":
                onReady?.();
                break;
            case "token.issued": {
                const { type: _t, ...token } = msg;
                this.pendingToken?.resolve(token);
                this.pendingToken = null;
                break;
            }
            case "collab.input":
                this.onInjectInput?.(msg.content, msg.userId, msg.displayName)?.catch(console.error);
                break;
            case "chat.message":
                this.onChatMessage?.(msg.message.displayName, msg.message.content);
                break;
            case "user.typing":
                this.onTyping?.(msg.displayName);
                break;
            case "user.pending":
                this.onUserPending?.(msg.user);
                break;
            case "user.joined":
                this.clients += 1;
                this.onUserJoined?.(msg.user);
                break;
            case "user.left":
                this.clients = Math.max(0, this.clients - 1);
                this.onUserLeft?.(msg.userId);
                break;
            case "user.list":
                this.clients = msg.users.filter((u) => u.status === "active").length;
                break;
            case "status":
                this.clients = msg.clients;
                break;
            case "error":
                this.pendingToken?.reject(new Error(msg.message));
                this.pendingToken = null;
                break;
        }
    }
    send(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(encodeHostMessage(msg));
    }
    issueToken(sessionId, role = "edit", ttlMs) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error("relay host control not connected"));
                return;
            }
            this.pendingToken = { resolve, reject };
            this.send({ type: "token.issue", sessionId, role, ttlMs });
            setTimeout(() => {
                if (this.pendingToken) {
                    this.pendingToken.reject(new Error("token.issue timed out"));
                    this.pendingToken = null;
                }
            }, 5000);
        });
    }
    setSessionPolicy(opts) {
        this.send({
            type: "session.policy",
            requireApproval: opts.requireApproval,
            repoRemote: opts.repoRemote === null ? "" : opts.repoRemote,
            allowedEmailDomain: opts.allowedEmailDomain === null ? "" : opts.allowedEmailDomain,
            additionalRepoRemotePrefixes: opts.additionalRepoRemotePrefixes ?? undefined,
            repoRemoteRewrites: opts.repoRemoteRewrites ?? undefined,
        });
    }
    approveUser(userId) {
        this.send({ type: "host.approve", userId });
    }
    denyUser(userId) {
        this.send({ type: "host.deny", userId });
    }
    kickUser(userId) {
        this.send({ type: "host.kick", userId });
    }
    pushEvent(event) {
        this.send({ type: "session.event", event });
    }
    sendChat(displayName, content) {
        this.send({ type: "chat.send", content, displayName });
    }
    async stop() {
        // Only tear down session state on relays we own. External relays stay up
        // so container agents can reconnect across test runs.
        if (!this.external) {
            this.send({ type: "host.close" });
        }
        try {
            this.ws?.close();
        }
        catch {
            // ignore
        }
        this.ws = null;
        const child = this.child;
        this.child = null;
        this.running = false;
        this.clients = 0;
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise((resolve) => {
                const finish = () => resolve();
                child.once("exit", finish);
                try {
                    child.kill("SIGTERM");
                }
                catch {
                    finish();
                    return;
                }
                setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        try {
                            child.kill("SIGKILL");
                        }
                        catch {
                            finish();
                        }
                    }
                }, 1000).unref?.();
            });
        }
        if (!this.external) {
            await this.waitUntilStopped();
        }
    }
    async waitUntilStopped(timeoutMs = 2000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(this.statusUrl(), { signal: AbortSignal.timeout(250) });
                if (!res.ok)
                    return;
            }
            catch {
                return;
            }
            await new Promise((r) => setTimeout(r, 20));
        }
    }
    get isRunning() {
        return this.running;
    }
    get clientCount() {
        return this.clients;
    }
    getPort() {
        return this.port;
    }
    getHost() {
        return this.host;
    }
    isExternal() {
        return this.external;
    }
}
//# sourceMappingURL=index.js.map