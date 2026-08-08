import { RelayServer, relayOptionsFromEnv } from "./relay/index.js";
import { JoinClient } from "./join/index.js";
import { S3BackupAdapter } from "./backup/index.js";
import { networkInterfaces } from "node:os";
import { mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const DEFAULT_PORT = parseInt(process.env["CHORUS_PORT"] ?? "7742", 10);
const { port: RELAY_PORT, opts: RELAY_OPTS } = relayOptionsFromEnv(DEFAULT_PORT);
// TODO: replace with native plugin slash command registration once supported
// https://github.com/sst/opencode/issues/5305
function installCommands() {
    try {
        const pluginDir = dirname(fileURLToPath(import.meta.url));
        const srcDir = join(pluginDir, "..", "commands");
        const destDir = join(homedir(), ".config", "opencode", "commands");
        if (!existsSync(srcDir))
            return;
        mkdirSync(destDir, { recursive: true });
        for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".md"))) {
            const dest = join(destDir, file);
            if (!existsSync(dest)) {
                copyFileSync(join(srcDir, file), dest);
            }
        }
    }
    catch {
        // Non-fatal — commands can be installed manually
    }
}
function getLanIp() {
    const nets = networkInterfaces();
    for (const iface of Object.values(nets)) {
        for (const net of iface ?? []) {
            if (net.family === "IPv4" && !net.internal)
                return net.address;
        }
    }
    return "localhost";
}
/** Host:port advertised to joiners (override with CHORUS_PUBLIC_HOST). */
function publicJoinHost(port) {
    if (process.env["CHORUS_PUBLIC_HOST"])
        return process.env["CHORUS_PUBLIC_HOST"];
    if (RELAY_OPTS.external && RELAY_OPTS.host && RELAY_OPTS.host !== "127.0.0.1") {
        return `${RELAY_OPTS.host}:${port}`;
    }
    return `${getLanIp()}:${port}`;
}
function buildBackupAdapter() {
    const bucket = process.env["CHORUS_AWS_BUCKET"];
    if (!bucket)
        return null;
    return new S3BackupAdapter({
        bucket,
        region: process.env["CHORUS_AWS_REGION"],
        endpoint: process.env["CHORUS_AWS_ENDPOINT"],
    });
}
export default async function chorusPlugin(input) {
    installCommands();
    const relay = new RelayServer(RELAY_PORT, RELAY_OPTS);
    const backup = buildBackupAdapter();
    let sessionId = "";
    let sharing = false;
    const events = [];
    let joinClient = null;
    /** Joiner OpenCode session that should mirror the host transcript. */
    let joinSessionId = "";
    /**
     * True while we inject a remote host/AI event into the joiner session so
     * chat.message does not forward that text back over collab.input.
     */
    let pendingRemoteInject = false;
    /** Serialize joiner transcript mirrors (history replay + live events). */
    let mirrorChain = Promise.resolve();
    /** Event ids already written into the joiner transcript (dedupe live vs history). */
    const mirroredEventIds = new Set();
    const MIRROR_LINE = /^\[(AI|Host)\]:/;
    function toast(message, variant = "info", duration = 4000) {
        input.client.tui.showToast({ body: { message, variant, duration } }).catch(() => { });
    }
    function say(sid, text) {
        input.client.session
            .prompt({
            throwOnError: false,
            path: { id: sid },
            body: { noReply: true, parts: [{ type: "text", text }] },
        })
            .catch(() => { });
    }
    function formatMirroredEvent(event) {
        const payload = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
        if (event.type === "user")
            return `[Host]: ${payload}`;
        if (event.type === "assistant")
            return `[AI]: ${payload}`;
        return null;
    }
    function rememberMirrored(id) {
        mirroredEventIds.add(id);
        if (mirroredEventIds.size > 400) {
            const first = mirroredEventIds.values().next().value;
            if (first !== undefined)
                mirroredEventIds.delete(first);
        }
    }
    /**
     * Inject a host session event into the joiner OpenCode transcript (no LLM).
     * Never run this while sharing — that creates a feedback loop where the host
     * mirrors its own AI replies back into itself.
     */
    function mirrorEventToJoiner(event) {
        if (sharing)
            return;
        if (!joinSessionId || !joinClient)
            return;
        if (mirroredEventIds.has(event.id))
            return;
        const text = formatMirroredEvent(event);
        if (!text)
            return;
        rememberMirrored(event.id);
        mirrorChain = mirrorChain
            .then(async () => {
            if (!joinSessionId || sharing)
                return;
            pendingRemoteInject = true;
            try {
                await input.client.session.prompt({
                    throwOnError: false,
                    path: { id: joinSessionId },
                    body: {
                        noReply: true,
                        parts: [{ type: "text", text, synthetic: true }],
                    },
                });
            }
            finally {
                pendingRemoteInject = false;
            }
        })
            .catch(() => { });
    }
    // Track when we're injecting a collab message so chat.message hook can skip pushing it as an event
    let pendingCollabInject = false;
    relay.setInputHandler(async (content, userId, displayName) => {
        if (!sessionId)
            return;
        // Joiner echoed a mirrored transcript line — drop it (do not re-prompt the host LLM).
        if (MIRROR_LINE.test(content.trim()))
            return;
        const label = displayName ?? userId.slice(0, 8);
        pendingCollabInject = true;
        try {
            await input.client.session.prompt({
                throwOnError: true,
                path: { id: sessionId },
                body: { parts: [{ type: "text", text: `[${label}]: ${content}` }] },
            });
        }
        finally {
            pendingCollabInject = false;
        }
    });
    relay.setChatHandler((displayName, content) => {
        toast(`💬 [${displayName ?? "guest"}]: ${content}`);
    });
    relay.setTypingHandler((displayName) => {
        toast(`✏️ [${displayName ?? "someone"}] is typing…`, "info", 2000);
    });
    return {
        "chat.message": async (chatInput, output) => {
            sessionId = chatInput.sessionID;
            if (joinClient)
                joinSessionId = chatInput.sessionID;
            if (joinClient) {
                const state = joinClient.getState();
                if (state.status === "connected") {
                    // Mirrored host/AI lines are synthetic / pendingRemoteInject — do not echo back.
                    if (!pendingRemoteInject) {
                        const text = output.parts
                            .filter((p) => p.type === "text" && !p.synthetic)
                            .map((p) => p.text ?? "")
                            .join("\n");
                        if (text && !MIRROR_LINE.test(text.trim()))
                            joinClient.sendInput(text);
                    }
                }
            }
            if (!sharing)
                return;
            const text = output.parts
                .filter((p) => p.type === "text" && !p.synthetic)
                .map((p) => p.text ?? "")
                .join("\n");
            // Skip collab-injected, synthetic, and mirrored transcript lines
            if (!text || pendingCollabInject || MIRROR_LINE.test(text.trim()))
                return;
            const event = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                sessionId: chatInput.sessionID,
                type: "user",
                payload: text,
                timestamp: Date.now(),
            };
            events.push(event);
            relay.pushEvent(event);
            if (backup) {
                backup
                    .save({
                    sessionId: chatInput.sessionID,
                    events,
                    messages: [],
                    startedAt: events[0]?.timestamp ?? Date.now(),
                })
                    .catch(console.error);
            }
        },
        "experimental.text.complete": async (hookInput, hookOutput) => {
            sessionId = hookInput.sessionID;
            if (!sharing || !hookOutput.text)
                return;
            const event = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                sessionId: hookInput.sessionID,
                type: "assistant",
                payload: hookOutput.text,
                timestamp: Date.now(),
            };
            events.push(event);
            relay.pushEvent(event);
        },
        tool: {
            "chorus-share": {
                description: "Start sharing this session and generate a join token for a collaborator. " +
                    "The recipient must have OpenCode + the chorus plugin installed and run chorus-join. " +
                    "Roles: edit (default, can send LLM messages), view (read-only), admin (full control).",
                args: {
                    role: z
                        .enum(["edit", "view", "admin"])
                        .optional()
                        .describe("Role for the recipient. edit = can contribute (default); " +
                        "view = read-only; admin = full control."),
                },
                async execute(args, context) {
                    const grantedRole = args.role === "admin" ? "admin" : args.role === "view" ? "view" : "edit";
                    const sid = sessionId || context.sessionID;
                    // Hosting + joining on the same plugin instance mirrors events into itself.
                    if (joinClient) {
                        joinClient.disconnect();
                        joinClient = null;
                        joinSessionId = "";
                        mirroredEventIds.clear();
                    }
                    if (!sharing) {
                        await relay.start();
                        sharing = true;
                        const where = relay.isExternal()
                            ? `attached to external relay ${relay.getHost()}:${relay.getPort()}`
                            : `chorus relay started on port ${relay.getPort()}`;
                        say(sid, where);
                    }
                    const joinHost = publicJoinHost(relay.getPort());
                    const token = await relay.issueToken(sid, grantedRole);
                    const info = {
                        token: token.token,
                        sessionId: sid,
                        port: relay.getPort(),
                        url: joinHost,
                        role: grantedRole,
                    };
                    const joinCommand = `/chorus-join token="${token.token}" host="${joinHost}"`;
                    say(sid, `Send this command to your collaborator:\n${joinCommand}`);
                    return JSON.stringify({
                        ...info,
                        connect: joinCommand,
                    });
                },
            },
            "chorus-join": {
                description: "Join another user's shared OpenCode session. " +
                    "Requires the token and host address provided by the session organizer via chorus-share. " +
                    "Once joined, your messages are also forwarded to the shared session.",
                args: {
                    token: z.string().describe("The session token provided by the organizer."),
                    host: z
                        .string()
                        .describe("Host address of the organizer's relay, e.g. 192.168.1.5:7742"),
                    name: z
                        .string()
                        .optional()
                        .describe("Your display name in the session (defaults to system username)."),
                },
                async execute(args, context) {
                    if (sharing) {
                        return JSON.stringify({
                            joined: false,
                            error: "This session is currently sharing. Run chorus-stop before chorus-join — " +
                                "hosting and joining on the same agent creates an event feedback loop.",
                        });
                    }
                    if (joinClient) {
                        joinClient.disconnect();
                        joinClient = null;
                    }
                    joinSessionId = context.sessionID;
                    mirroredEventIds.clear();
                    const displayName = args.name ?? process.env["USER"] ?? "unknown";
                    const jc = new JoinClient(`ws://${args.host}/ws`, args.token, displayName);
                    try {
                        await jc.connect();
                    }
                    catch (err) {
                        joinSessionId = "";
                        return JSON.stringify({
                            joined: false,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                    jc.setChatHandler((msgDisplayName, content) => {
                        toast(`💬 [${msgDisplayName ?? "host"}]: ${content}`);
                    });
                    jc.setTypingHandler((typingDisplayName) => {
                        toast(`✏️ [${typingDisplayName ?? "someone"}] is typing…`, "info", 2000);
                    });
                    // Live host transcript → joiner session (not toasts).
                    jc.setEventHandler((event) => {
                        mirrorEventToJoiner(event);
                    });
                    // Replay buffered history from auth so late joiners catch up.
                    for (const event of jc.getState().recentEvents) {
                        mirrorEventToJoiner(event);
                    }
                    joinClient = jc;
                    const state = jc.getState();
                    return JSON.stringify({
                        joined: true,
                        users: state.users,
                        recentEventCount: state.recentEvents.length,
                        message: "Connected. Host prompts and AI replies will appear in this session. " +
                            "Your messages are forwarded to the shared session. Run chorus-leave to disconnect.",
                    });
                },
            },
            "chorus-leave": {
                description: "Leave the currently joined session.",
                args: {},
                async execute() {
                    if (!joinClient)
                        return JSON.stringify({ left: false, message: "Not currently joined to any session." });
                    joinClient.disconnect();
                    joinClient = null;
                    joinSessionId = "";
                    mirroredEventIds.clear();
                    return JSON.stringify({ left: true });
                },
            },
            "chorus-chat": {
                description: "Send a chat message to all participants in the current chorus session. " +
                    "Visible to both the host and all joined collaborators as an inline notification.",
                args: {
                    message: z.string().describe("The message to send to all participants."),
                },
                async execute(args) {
                    if (sharing) {
                        const displayName = process.env["USER"] ?? "Host";
                        relay.sendChat(displayName, args.message);
                        return JSON.stringify({ sent: true, via: "relay" });
                    }
                    if (joinClient?.getState().status === "connected") {
                        joinClient.sendTyping();
                        joinClient.sendChat(args.message);
                        return JSON.stringify({ sent: true, via: "join" });
                    }
                    return JSON.stringify({
                        sent: false,
                        message: "Not currently sharing or joined to a session.",
                    });
                },
            },
            "chorus-status": {
                description: "Show the current chorus state: whether sharing, joined, and who is connected.",
                args: {},
                async execute() {
                    const shareInfo = sharing
                        ? {
                            sharing: true,
                            clients: relay.clientCount,
                            port: relay.getPort(),
                            host: relay.getHost(),
                            external: relay.isExternal(),
                        }
                        : { sharing: false };
                    const joinInfo = joinClient
                        ? { joined: true, ...joinClient.getState() }
                        : { joined: false };
                    return JSON.stringify({ ...shareInfo, ...joinInfo });
                },
            },
            "chorus-stop": {
                description: "Stop sharing the current session.",
                args: {},
                async execute() {
                    sharing = false;
                    relay.stop();
                    return JSON.stringify({ stopped: true });
                },
            },
        },
        dispose: async () => {
            joinClient?.disconnect();
            joinClient = null;
            joinSessionId = "";
            mirroredEventIds.clear();
            relay.stop();
        },
    };
}
//# sourceMappingURL=index.js.map