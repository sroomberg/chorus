import { RelayServer, relayOptionsFromEnv } from "./relay/index.js";
import { JoinClient } from "./join/index.js";
import { S3BackupAdapter } from "./backup/index.js";
import { detectRepoRemote } from "./git.js";
import { normalizeDisplayName } from "@chorus/shared";
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
    /** Texts this joiner recently forwarded — skip mirroring our own labeled echo. */
    const recentlyForwarded = new Set();
    const MIRROR_LINE = /^\[(AI|Host)\]:/;
    const LABELED_LINE = /^\[[^\]]+\]:\s/;
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
        if (event.type === "user") {
            // Collaborator lines are already `[name]: …` from the host — keep for all agents.
            if (LABELED_LINE.test(payload))
                return payload;
            return `[Host]: ${payload}`;
        }
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
    function noteForwarded(text) {
        recentlyForwarded.add(text);
        setTimeout(() => recentlyForwarded.delete(text), 30_000).unref?.();
    }
    function isOwnForwardEcho(payload) {
        for (const text of recentlyForwarded) {
            if (payload === text || payload.endsWith(`: ${text}`))
                return true;
        }
        return false;
    }
    async function abortLocalTurn(sid) {
        if (!input.client.session.abort)
            return;
        // chat.message runs before the agent loop is busy — brief delay then abort.
        await new Promise((r) => setTimeout(r, 75));
        await input.client.session.abort({ path: { id: sid } }).catch(() => { });
    }
    async function nudgeJoinerTui(sid, preview) {
        toast(preview, "info", 3500);
        if (input.client.tui.selectSession) {
            await input.client.tui.selectSession({ body: { sessionID: sid } }).catch(() => { });
        }
        if (input.client.tui.executeCommand) {
            await input.client.tui
                .executeCommand({ body: { command: "session.last" } })
                .catch(() => { });
        }
    }
    /**
     * Inject a shared-session event into this joiner's OpenCode transcript (no LLM).
     * Never run while sharing — that feedback-loops the host into itself.
     *
     * Prefer the web UI on the agent port for live view; attach TUI often misses
     * injects (upstream). We still toast + nudge after each write.
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
        if (event.type === "user" && isOwnForwardEcho(text)) {
            rememberMirrored(event.id);
            return;
        }
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
            const preview = text.length > 100 ? `${text.slice(0, 97)}…` : text;
            await nudgeJoinerTui(joinSessionId, preview);
        })
            .catch(() => { });
    }
    // Track when we're injecting a collab message so chat.message can skip auto-push
    let pendingCollabInject = false;
    relay.setInputHandler(async (content, userId, displayName) => {
        if (!sessionId)
            return;
        // Joiner echoed a mirrored transcript line — drop it.
        if (MIRROR_LINE.test(content.trim()))
            return;
        const label = displayName ?? userId.slice(0, 8);
        const labeled = `[${label}]: ${content}`;
        pendingCollabInject = true;
        try {
            await input.client.session.prompt({
                throwOnError: true,
                path: { id: sessionId },
                body: { parts: [{ type: "text", text: labeled }] },
            });
        }
        finally {
            pendingCollabInject = false;
        }
        // Fan out collaborator prompts to every joiner (pendingCollabInject skips
        // the chat.message auto-push, so publish explicitly).
        const event = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            sessionId,
            type: "user",
            payload: labeled,
            timestamp: Date.now(),
        };
        events.push(event);
        relay.pushEvent(event);
    });
    relay.setChatHandler((displayName, content) => {
        toast(`[${displayName ?? "guest"}]: ${content}`);
    });
    relay.setTypingHandler((displayName) => {
        toast(`[${displayName ?? "someone"}] is typing…`, "info", 2000);
    });
    relay.setUserPendingHandler((user) => {
        toast(`Join request from ${user.displayName} (${user.role}). Run chorus-approve userId="${user.userId}" or chorus-deny.`, "warning", 12_000);
        if (sessionId) {
            say(sessionId, `Pending join: ${user.displayName} wants ${user.role} access (userId=${user.userId}). ` +
                `Approve with /chorus-approve ${user.userId} or deny with /chorus-deny ${user.userId}.`);
        }
    });
    relay.setUserJoinedHandler((user) => {
        toast(`${user.displayName} joined (${user.role})`, "success", 4000);
    });
    relay.setUserLeftHandler((userId) => {
        toast(`User left (${userId.slice(0, 8)}…)`, "info", 3000);
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
                        if (text && !MIRROR_LINE.test(text.trim())) {
                            noteForwarded(text);
                            joinClient.sendInput(text);
                            // One shared brain: cancel the joiner's local LLM; wait for mirrored host AI.
                            void abortLocalTurn(chatInput.sessionID);
                        }
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
                    "Roles: edit (default, can send LLM messages), view (read-only), admin (full control). " +
                    "By default the host must approve each joiner; set requireApproval=false to skip. " +
                    "When this directory is a git checkout, joiners must present the same origin remote.",
                args: {
                    role: z
                        .enum(["edit", "view", "admin"])
                        .optional()
                        .describe("Role for the recipient. edit = can contribute (default); " +
                        "view = read-only; admin = full control."),
                    requireApproval: z
                        .boolean()
                        .optional()
                        .describe("If true (default), joiners wait in pending until chorus-approve. " +
                        "Set false for open token join (LAN/trusted)."),
                },
                async execute(args, context) {
                    const grantedRole = args.role === "admin" ? "admin" : args.role === "view" ? "view" : "edit";
                    const requireApproval = args.requireApproval !== false;
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
                    const repoRemote = detectRepoRemote(context.directory);
                    relay.setSessionPolicy({
                        requireApproval,
                        repoRemote: repoRemote ?? "",
                    });
                    const joinHost = publicJoinHost(relay.getPort());
                    const token = await relay.issueToken(sid, grantedRole);
                    const info = {
                        token: token.token,
                        sessionId: sid,
                        port: relay.getPort(),
                        url: joinHost,
                        role: grantedRole,
                        requireApproval,
                        ...(repoRemote ? { repoRemote } : {}),
                    };
                    const joinCommand = `/chorus-join token="${token.token}" host="${joinHost}" name="YOUR_NAME"`;
                    const policyNotes = [
                        requireApproval
                            ? "Joiners wait for your approval (chorus-approve / chorus-deny)."
                            : "Open join: token holders connect without approval.",
                        repoRemote
                            ? `Repo gate on: joiners must be in a clone of ${repoRemote}.`
                            : "No git origin detected — repo gate disabled for this share.",
                    ].join(" ");
                    say(sid, `Send this command to your collaborator:\n${joinCommand}\n\n${policyNotes}`);
                    return JSON.stringify({
                        ...info,
                        connect: joinCommand,
                        policyNotes,
                    });
                },
            },
            "chorus-join": {
                description: "Join another user's shared OpenCode session. " +
                    "Requires the token, host address, and a display name from the organizer via chorus-share. " +
                    "If the host enabled approval, you wait in pending until they approve. " +
                    "If the host bound the session to a git repo, you must be in a matching clone.",
                args: {
                    token: z.string().describe("The session token provided by the organizer."),
                    host: z
                        .string()
                        .describe("Host address of the organizer's relay, e.g. 192.168.1.5:7742"),
                    name: z.string().describe("Your display name in the session (required)."),
                },
                async execute(args, context) {
                    if (sharing) {
                        return JSON.stringify({
                            joined: false,
                            error: "This session is currently sharing. Run chorus-stop before chorus-join — " +
                                "hosting and joining on the same agent creates an event feedback loop.",
                        });
                    }
                    const displayName = normalizeDisplayName(args.name);
                    if (!displayName) {
                        return JSON.stringify({
                            joined: false,
                            error: "A non-empty name is required to join a chorus session.",
                        });
                    }
                    if (joinClient) {
                        joinClient.disconnect();
                        joinClient = null;
                    }
                    joinSessionId = context.sessionID;
                    mirroredEventIds.clear();
                    const repoRemote = detectRepoRemote(context.directory);
                    const jc = new JoinClient(`ws://${args.host}/ws`, args.token, displayName, repoRemote);
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
                        toast(`[${msgDisplayName ?? "host"}]: ${content}`);
                    });
                    jc.setTypingHandler((typingDisplayName) => {
                        toast(`[${typingDisplayName ?? "someone"}] is typing…`, "info", 2000);
                    });
                    jc.setApprovedHandler(() => {
                        toast("Host approved — you are in the session.", "success", 5000);
                        for (const event of jc.getState().recentEvents) {
                            mirrorEventToJoiner(event);
                        }
                    });
                    // Live host transcript → joiner session (not toasts).
                    jc.setEventHandler((event) => {
                        mirrorEventToJoiner(event);
                    });
                    // Replay buffered history once active (immediate when approval is off).
                    if (jc.getState().status === "connected") {
                        for (const event of jc.getState().recentEvents) {
                            mirrorEventToJoiner(event);
                        }
                    }
                    joinClient = jc;
                    const state = jc.getState();
                    if (state.status === "pending") {
                        return JSON.stringify({
                            joined: true,
                            pending: true,
                            userId: state.userId,
                            message: "Connected and waiting for host approval. " +
                                "You cannot send prompts or chat until the host runs chorus-approve. " +
                                "Run chorus-leave to disconnect.",
                        });
                    }
                    return JSON.stringify({
                        joined: true,
                        pending: false,
                        users: state.users,
                        recentEventCount: state.recentEvents.length,
                        message: "Connected. This agent mirrors the shared host transcript in real time " +
                            "([Host]: / [name]: / [AI]:). Your prompts go to the host session; local LLM is aborted. " +
                            "For live UI updates prefer the web UI at this agent's port (attach TUI often lags). " +
                            "Run chorus-leave to disconnect.",
                    });
                },
            },
            "chorus-approve": {
                description: "Approve a pending joiner so they can enter the shared session. " +
                    "Use the userId from the join-request toast or chorus-status.",
                args: {
                    userId: z.string().describe("Pending user id to approve."),
                },
                async execute(args) {
                    if (!sharing) {
                        return JSON.stringify({
                            approved: false,
                            error: "Not currently sharing a session.",
                        });
                    }
                    relay.approveUser(args.userId);
                    return JSON.stringify({ approved: true, userId: args.userId });
                },
            },
            "chorus-deny": {
                description: "Deny a pending joiner and disconnect them from the relay.",
                args: {
                    userId: z.string().describe("Pending user id to deny."),
                },
                async execute(args) {
                    if (!sharing) {
                        return JSON.stringify({
                            denied: false,
                            error: "Not currently sharing a session.",
                        });
                    }
                    relay.denyUser(args.userId);
                    return JSON.stringify({ denied: true, userId: args.userId });
                },
            },
            "chorus-kick": {
                description: "Disconnect an active joiner from the shared session.",
                args: {
                    userId: z.string().describe("Active user id to kick."),
                },
                async execute(args) {
                    if (!sharing) {
                        return JSON.stringify({
                            kicked: false,
                            error: "Not currently sharing a session.",
                        });
                    }
                    relay.kickUser(args.userId);
                    return JSON.stringify({ kicked: true, userId: args.userId });
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