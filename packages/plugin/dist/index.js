import { RelayServer, relayOptionsFromEnv } from "./relay/index.js";
import { JoinClient } from "./join/index.js";
import { formatJoinCommand } from "./join-command.js";
import { S3BackupAdapter } from "./backup/index.js";
import { detectRepoRemote } from "./git.js";
import { loadChorusConfig, resolveDefaultRole, resolveRequireApproval, resolveAllowedEmailDomain, } from "./config/index.js";
import { normalizeDisplayName, normalizeEmail } from "@chorus/shared";
import { MIRROR_LINE, formatMirroredEvent, isChorusControlText, shouldFanOutHostUserText, shouldForwardJoinerInput, shouldPublishAssistantText, userTextFromParts, } from "./transcript.js";
import { PendingQueue, formatPendingQueue, formatPendingQueueToast, resolveQueueTarget, } from "./pending-queue.js";
import { networkInterfaces } from "node:os";
import { mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const DEFAULT_PORT = parseInt(process.env["CHORUS_PORT"] ?? "7742", 10);
const { port: RELAY_PORT, opts: RELAY_OPTS } = relayOptionsFromEnv(DEFAULT_PORT);
/** Cache project-scoped config by directory. */
const configCache = new Map();
function getConfig(projectDir) {
    const key = projectDir ?? "";
    const cached = configCache.get(key);
    if (cached)
        return cached;
    const loaded = loadChorusConfig(projectDir);
    configCache.set(key, loaded);
    return loaded;
}
function effectiveRelayPort(config) {
    return config.relay.port ?? RELAY_PORT;
}
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
/** Host:port advertised to joiners (config / CHORUS_PUBLIC_HOST / LAN). */
function publicJoinHost(port, config) {
    if (config.relay.publicHost)
        return config.relay.publicHost;
    if (process.env["CHORUS_PUBLIC_HOST"])
        return process.env["CHORUS_PUBLIC_HOST"];
    if (RELAY_OPTS.external && RELAY_OPTS.host && RELAY_OPTS.host !== "127.0.0.1") {
        return `${RELAY_OPTS.host}:${port}`;
    }
    return `${getLanIp()}:${port}`;
}
function buildBackupAdapter(config) {
    const bucket = config.backup.bucket ?? process.env["CHORUS_AWS_BUCKET"];
    if (!bucket)
        return null;
    return new S3BackupAdapter({
        bucket,
        region: config.backup.region ?? process.env["CHORUS_AWS_REGION"],
        endpoint: config.backup.endpoint ?? process.env["CHORUS_AWS_ENDPOINT"],
    });
}
export default async function chorusPlugin(input) {
    installCommands();
    const bootstrap = getConfig();
    const relay = new RelayServer(effectiveRelayPort(bootstrap.config), RELAY_OPTS);
    let backup = buildBackupAdapter(bootstrap.config);
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
    /** Host user messages already fanned out (chat.message vs event hook vs collab handler). */
    const publishedUserKeys = new Set();
    const recentUserPayloadAt = new Map();
    const USER_PAYLOAD_DEDUPE_MS = 2500;
    /** User message ids observed while sharing — used by the event-hook backup path. */
    const hostUserMessageIds = new Set();
    /** Short ids (1, 2, A) for pending joiners so the host need not paste a userId. */
    const pendingQueue = new PendingQueue();
    /** Keep the join-queue toast visible while anyone is still waiting. */
    let queueToastTimer = null;
    /** Serialize live queue board writes (rapid join/leave). */
    let queuePublishChain = Promise.resolve();
    function toast(message, variant = "info", duration = 4000, title) {
        input.client.tui
            .showToast({ body: { ...(title ? { title } : {}), message, variant, duration } })
            .catch(() => { });
    }
    function say(sid, text, ignored = false) {
        input.client.session
            .prompt({
            throwOnError: false,
            path: { id: sid },
            body: { noReply: true, parts: [{ type: "text", text, ...(ignored ? { ignored: true } : {}) }] },
        })
            .catch(() => { });
    }
    function pendingQueuePayload() {
        return {
            pendingQueue: pendingQueue.snapshot(),
            pendingQueueText: formatPendingQueue(pendingQueue.list()),
        };
    }
    function stopLiveQueuePulse() {
        if (!queueToastTimer)
            return;
        clearInterval(queueToastTimer);
        queueToastTimer = null;
    }
    function showLiveQueueToast() {
        const entries = pendingQueue.list();
        toast(formatPendingQueueToast(entries), entries.length ? "warning" : "info", entries.length ? 15_000 : 4000, "Chorus join queue");
    }
    function syncLiveQueuePulse() {
        if (!sharing || pendingQueue.size === 0) {
            stopLiveQueuePulse();
            return;
        }
        if (queueToastTimer)
            return;
        queueToastTimer = setInterval(() => {
            if (!sharing || pendingQueue.size === 0) {
                stopLiveQueuePulse();
                return;
            }
            showLiveQueueToast();
        }, 12_000);
        queueToastTimer.unref?.();
    }
    async function nudgeHostTui(sid) {
        if (input.client.tui.selectSession) {
            await input.client.tui.selectSession({ body: { sessionID: sid } }).catch(() => { });
        }
        if (input.client.tui.executeCommand) {
            await input.client.tui
                .executeCommand({ body: { command: "session.last" } })
                .catch(() => { });
        }
    }
    /** Push the current queue to toast + session so the host sees it as it changes. */
    function publishLiveQueue(prefix) {
        showLiveQueueToast();
        syncLiveQueuePulse();
        const sid = sessionId;
        if (!sid)
            return;
        const body = [prefix, formatPendingQueue(pendingQueue.list())].filter(Boolean).join("\n");
        queuePublishChain = queuePublishChain
            .then(async () => {
            if (!sharing || sessionId !== sid)
                return;
            await input.client.session.prompt({
                throwOnError: false,
                path: { id: sid },
                body: {
                    noReply: true,
                    parts: [{ type: "text", text: body, ignored: true }],
                },
            });
            await nudgeHostTui(sid);
        })
            .catch(() => { });
    }
    function admitPending(action, raw) {
        const resolved = resolveQueueTarget(pendingQueue, raw);
        if (!resolved.ok) {
            showLiveQueueToast();
            if (sessionId)
                say(sessionId, resolved.error, true);
            return { ok: false, error: resolved.error, ...pendingQueuePayload() };
        }
        if (action === "approve")
            relay.approveUser(resolved.userId);
        else
            relay.denyUser(resolved.userId);
        const entry = pendingQueue.remove(resolved.userId);
        const name = entry?.user.displayName ?? resolved.displayName ?? resolved.userId;
        const ref = resolved.ref ?? entry?.ref;
        const verb = action === "approve" ? "Approved" : "Denied";
        publishLiveQueue(`${verb} [${ref ?? "id"}] ${name}.`);
        return {
            ok: true,
            id: ref,
            userId: resolved.userId,
            displayName: name,
            ...pendingQueuePayload(),
        };
    }
    function rememberSet(set, value, max = 400) {
        if (set.has(value))
            return false;
        set.add(value);
        if (set.size > max) {
            const first = set.values().next().value;
            if (first !== undefined)
                set.delete(first);
        }
        return true;
    }
    function rememberMirrored(id) {
        rememberSet(mirroredEventIds, id);
    }
    function publishSessionUserEvent(sid, text, messageId) {
        if (!sharing || !sid || !text)
            return false;
        if (MIRROR_LINE.test(text.trim()))
            return false;
        if (messageId && !rememberSet(publishedUserKeys, `id:${messageId}`))
            return false;
        const now = Date.now();
        const last = recentUserPayloadAt.get(text);
        if (last !== undefined && now - last < USER_PAYLOAD_DEDUPE_MS)
            return false;
        recentUserPayloadAt.set(text, now);
        if (recentUserPayloadAt.size > 400) {
            const first = recentUserPayloadAt.keys().next().value;
            if (first !== undefined)
                recentUserPayloadAt.delete(first);
        }
        const event = {
            id: messageId ?? `${now}-${Math.random().toString(36).slice(2)}`,
            sessionId: sid,
            type: "user",
            payload: text,
            timestamp: now,
        };
        events.push(event);
        relay.pushEvent(event);
        return true;
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
     * Parts are not marked synthetic: OpenCode hides those from the session UI.
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
                        // Do not mark synthetic: OpenCode hides synthetic parts from TUI/web UI.
                        // Echo is prevented by [Host]/[AI] prefixes in chat.message.
                        parts: [{ type: "text", text }],
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
    relay.setInputHandler(async (content, userId, displayName) => {
        if (!sessionId)
            return;
        const trimmed = content.trim();
        // Joiner echoed a mirrored line or forwarded a /chorus-* command — drop it.
        if (MIRROR_LINE.test(trimmed) || isChorusControlText(trimmed))
            return;
        const label = displayName ?? userId.slice(0, 8);
        const labeled = `[${label}]: ${content}`;
        // Fan out immediately — do not wait on the host LLM turn, and do not hold
        // a skip-flag that would drop a concurrent host prompt.
        publishSessionUserEvent(sessionId, labeled);
        await input.client.session.prompt({
            throwOnError: true,
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: labeled }] },
        });
    });
    relay.setChatHandler((displayName, content) => {
        toast(`[${displayName ?? "guest"}]: ${content}`);
    });
    relay.setTypingHandler((displayName) => {
        toast(`[${displayName ?? "someone"}] is typing…`, "info", 2000);
    });
    relay.setUserPendingHandler((user) => {
        const entry = pendingQueue.enqueue(user);
        const email = user.email ? ` <${user.email}>` : "";
        publishLiveQueue(`New join request [${entry.ref}] ${user.displayName}${email} wants ${user.role} access.`);
    });
    relay.setUserJoinedHandler((user) => {
        pendingQueue.remove(user.userId);
        toast(`${user.displayName} joined (${user.role})`, "success", 4000);
        if (pendingQueue.size)
            showLiveQueueToast();
    });
    relay.setUserLeftHandler((userId) => {
        const removed = pendingQueue.remove(userId);
        if (removed) {
            publishLiveQueue(`${removed.user.displayName} left before approval.`);
        }
        else {
            toast(`User left (${userId.slice(0, 8)}…)`, "info", 3000);
        }
    });
    return {
        /**
         * Backup for host prompts that miss chat.message (busy session / attach TUI).
         * Deduped against chat.message and collab.input fan-out.
         */
        event: async (hookInput) => {
            if (!sharing)
                return;
            const ev = hookInput.event;
            if (ev.type === "message.updated") {
                const info = ev.properties?.info;
                if (info?.role === "user" && typeof info.id === "string") {
                    rememberSet(hostUserMessageIds, info.id);
                }
                return;
            }
            if (ev.type !== "message.part.updated")
                return;
            const part = ev.properties?.part;
            if (!part || part.type !== "text" || part.synthetic)
                return;
            if (typeof part.text !== "string" || !part.text)
                return;
            if (!part.messageID || !hostUserMessageIds.has(part.messageID))
                return;
            if (!shouldFanOutHostUserText(part.text))
                return;
            const sid = part.sessionID || sessionId;
            if (publishSessionUserEvent(sid, part.text, part.messageID) && backup) {
                backup
                    .save({
                    sessionId: sid,
                    events,
                    messages: [],
                    startedAt: events[0]?.timestamp ?? Date.now(),
                })
                    .catch(console.error);
            }
        },
        "chat.message": async (chatInput, output) => {
            sessionId = chatInput.sessionID;
            if (joinClient)
                joinSessionId = chatInput.sessionID;
            if (joinClient) {
                const state = joinClient.getState();
                if (state.status === "connected") {
                    // Mirrored [Host]/[AI] lines must not be forwarded back over collab.input.
                    if (!pendingRemoteInject) {
                        const text = userTextFromParts(output.parts);
                        if (shouldForwardJoinerInput(text)) {
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
            const text = userTextFromParts(output.parts);
            if (!shouldFanOutHostUserText(text))
                return;
            const messageId = output.message?.id ?? chatInput.messageID;
            if (!publishSessionUserEvent(chatInput.sessionID, text, messageId))
                return;
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
            if (!sharing || !shouldPublishAssistantText(hookOutput.text))
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
                    "Roles: edit (default from chorus.json), view (read-only), admin (full control). " +
                    "Security defaults come from chorus.json (org/user/project); tool args override unless locked. " +
                    "When requireRepoMatch is set or a git origin exists, joiners must present the same remote.",
                args: {
                    role: z
                        .enum(["edit", "view", "admin"])
                        .optional()
                        .describe("Role for the recipient. Defaults to security.defaultRole from config (usually edit)."),
                    requireApproval: z
                        .boolean()
                        .optional()
                        .describe("Override security.requireApproval from config. Ignored when allowSkipApproval is false."),
                },
                async execute(args, context) {
                    const { config, sources } = getConfig(context.directory);
                    backup = buildBackupAdapter(config);
                    const grantedRole = resolveDefaultRole(config.security, args.role);
                    const requireApproval = resolveRequireApproval(config.security, args.requireApproval);
                    const sid = sessionId || context.sessionID;
                    sessionId = sid;
                    // Hosting + joining on the same plugin instance mirrors events into itself.
                    if (joinClient) {
                        joinClient.disconnect();
                        joinClient = null;
                        joinSessionId = "";
                        mirroredEventIds.clear();
                    }
                    if (!sharing) {
                        pendingQueue.clear();
                        await relay.start();
                        sharing = true;
                        const where = relay.isExternal()
                            ? `attached to external relay ${relay.getHost()}:${relay.getPort()}`
                            : `chorus relay started on port ${relay.getPort()}`;
                        say(sid, where);
                    }
                    const repoRemote = detectRepoRemote(context.directory);
                    if (config.security.requireRepoMatch && !repoRemote) {
                        return JSON.stringify({
                            shared: false,
                            error: "security.requireRepoMatch is enabled but this directory has no git origin. " +
                                "Share from a clone with an origin remote, or relax requireRepoMatch in chorus.json.",
                        });
                    }
                    const allowedEmailDomain = resolveAllowedEmailDomain(config.security);
                    if (config.security.requireEmailDomainMatch && !allowedEmailDomain) {
                        return JSON.stringify({
                            shared: false,
                            error: "security.requireEmailDomainMatch is enabled but security.allowedEmailDomain is not set. " +
                                "Add allowedEmailDomain (e.g. acme.com) to chorus.json.",
                        });
                    }
                    relay.setSessionPolicy({
                        requireApproval,
                        repoRemote: repoRemote ?? "",
                        allowedEmailDomain: allowedEmailDomain ?? "",
                        additionalRepoRemotePrefixes: config.security.additionalRepoRemotePrefixes,
                        repoRemoteRewrites: config.security.repoRemoteRewrites,
                    });
                    const joinHost = publicJoinHost(relay.getPort(), config);
                    const token = await relay.issueToken(sid, grantedRole, config.security.tokenTtlMs);
                    const info = {
                        token: token.token,
                        sessionId: sid,
                        port: relay.getPort(),
                        url: joinHost,
                        role: grantedRole,
                        requireApproval,
                        ...(repoRemote ? { repoRemote } : {}),
                        ...(allowedEmailDomain ? { allowedEmailDomain } : {}),
                        ...(config.org.name ? { org: config.org.name } : {}),
                    };
                    const joinCommand = formatJoinCommand(token.token, joinHost, {
                        allowedEmailDomain,
                    });
                    const policyNotes = [
                        config.org.name ? `Org: ${config.org.name}.` : null,
                        config.org.policyNote ?? null,
                        requireApproval
                            ? "Joiners wait for your approval. The pending queue updates live on screen; /chorus-approve 1 (or A)."
                            : "Open join: token holders connect without approval.",
                        !config.security.allowSkipApproval
                            ? "Approval policy is locked by config (allowSkipApproval=false)."
                            : null,
                        repoRemote
                            ? `Repo gate on: joiners must be in a clone of ${repoRemote}.`
                            : "No git origin detected — repo gate disabled for this share.",
                        config.security.additionalRepoRemotePrefixes.length
                            ? `Extra git remote prefixes: ${config.security.additionalRepoRemotePrefixes.join(", ")}.`
                            : null,
                        config.security.repoRemoteRewrites.length
                            ? `Git remote rewrites: ${config.security.repoRemoteRewrites
                                .map((r) => `${r.from}→${r.to}`)
                                .join(", ")}.`
                            : null,
                        allowedEmailDomain
                            ? `Email gate on: joiners must use @${allowedEmailDomain}.`
                            : config.security.requireEmailDomainMatch
                                ? "Email domain gate is required by config but no domain is configured."
                                : null,
                        config.security.tokenTtlMs
                            ? `Join token TTL: ${config.security.tokenTtlMs}ms.`
                            : null,
                    ]
                        .filter(Boolean)
                        .join(" ");
                    say(sid, `Send this command to your collaborator:\n${joinCommand}\n\n${policyNotes}`);
                    return JSON.stringify({
                        ...info,
                        connect: joinCommand,
                        policyNotes,
                        configSources: sources.map((s) => s.path ?? s.kind),
                    });
                },
            },
            "chorus-join": {
                description: "Join another user's shared OpenCode session. " +
                    "Requires the token, host address, and a display name from the organizer via chorus-share. " +
                    "If the host enabled approval, you wait in pending until they approve. " +
                    "If the host bound the session to a git repo, you must be in a matching clone. " +
                    "If the host enabled a company email gate, provide your work email.",
                args: {
                    token: z.string().describe("The session token provided by the organizer."),
                    host: z
                        .string()
                        .describe("Host address of the organizer's relay, e.g. 192.168.1.5:7742"),
                    name: z.string().describe("Your display name in the session (required)."),
                    email: z
                        .string()
                        .optional()
                        .describe("Your work email when the host requires a company domain."),
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
                    const email = args.email ? normalizeEmail(args.email) : null;
                    if (args.email?.trim() && !email) {
                        return JSON.stringify({
                            joined: false,
                            error: "Provide a valid email address to join this session.",
                        });
                    }
                    if (joinClient) {
                        joinClient.disconnect();
                        joinClient = null;
                    }
                    joinSessionId = context.sessionID;
                    mirroredEventIds.clear();
                    const repoRemote = detectRepoRemote(context.directory);
                    const jc = new JoinClient(`ws://${args.host}/ws`, args.token, displayName, repoRemote, email ?? undefined);
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
                    // Assign before connect so history replay / live events during handshake
                    // are not dropped by mirrorEventToJoiner's joinClient guard.
                    joinClient = jc;
                    try {
                        await jc.connect();
                    }
                    catch (err) {
                        joinClient = null;
                        joinSessionId = "";
                        return JSON.stringify({
                            joined: false,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                    // Replay buffered history once active (immediate when approval is off).
                    if (jc.getState().status === "connected") {
                        for (const event of jc.getState().recentEvents) {
                            mirrorEventToJoiner(event);
                        }
                    }
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
                    "Pass the queue number printed next to the joiner (1, 2, …) or letter A=1. " +
                    "Full userId still works. Omit the id when only one joiner is waiting.",
                args: {
                    userId: z
                        .string()
                        .optional()
                        .describe("Queue slot from the pending join list (1, 2, or A) or the full userId. " +
                        "Omit to approve the only pending joiner."),
                },
                async execute(args, context) {
                    sessionId = sessionId || context.sessionID;
                    if (!sharing) {
                        return JSON.stringify({
                            approved: false,
                            error: "Not currently sharing a session.",
                        });
                    }
                    const result = admitPending("approve", args.userId);
                    return JSON.stringify(result.ok
                        ? {
                            approved: true,
                            id: result.id,
                            userId: result.userId,
                            displayName: result.displayName,
                            pendingQueue: result.pendingQueue,
                            pendingQueueText: result.pendingQueueText,
                        }
                        : {
                            approved: false,
                            error: result.error,
                            pendingQueue: result.pendingQueue,
                            pendingQueueText: result.pendingQueueText,
                        });
                },
            },
            "chorus-deny": {
                description: "Deny a pending joiner and disconnect them from the relay. " +
                    "Pass the queue number printed next to the joiner (1, 2, …) or letter A=1. " +
                    "Full userId still works. Omit the id when only one joiner is waiting.",
                args: {
                    userId: z
                        .string()
                        .optional()
                        .describe("Queue slot from the pending join list (1, 2, or A) or the full userId. " +
                        "Omit to deny the only pending joiner."),
                },
                async execute(args, context) {
                    sessionId = sessionId || context.sessionID;
                    if (!sharing) {
                        return JSON.stringify({
                            denied: false,
                            error: "Not currently sharing a session.",
                        });
                    }
                    const result = admitPending("deny", args.userId);
                    return JSON.stringify(result.ok
                        ? {
                            denied: true,
                            id: result.id,
                            userId: result.userId,
                            displayName: result.displayName,
                            pendingQueue: result.pendingQueue,
                            pendingQueueText: result.pendingQueueText,
                        }
                        : {
                            denied: false,
                            error: result.error,
                            pendingQueue: result.pendingQueue,
                            pendingQueueText: result.pendingQueueText,
                        });
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
                description: "Show the current chorus state: whether sharing, joined, who is connected, " +
                    "the pending join queue (short ids for approve/deny), and effective config.",
                args: {},
                async execute(_args, context) {
                    const loaded = getConfig(context.directory);
                    const { config, sources } = loaded;
                    const shareInfo = sharing
                        ? {
                            sharing: true,
                            clients: relay.clientCount,
                            port: relay.getPort(),
                            host: relay.getHost(),
                            external: relay.isExternal(),
                            ...pendingQueuePayload(),
                        }
                        : { sharing: false };
                    const joinInfo = joinClient
                        ? { joined: true, ...joinClient.getState() }
                        : { joined: false };
                    return JSON.stringify({
                        ...shareInfo,
                        ...joinInfo,
                        config: {
                            org: config.org,
                            security: config.security,
                            relay: config.relay,
                            backup: {
                                configured: Boolean(config.backup.bucket),
                                region: config.backup.region,
                            },
                            sources: sources.map((s) => ({ kind: s.kind, path: s.path })),
                        },
                    });
                },
            },
            "chorus-stop": {
                description: "Stop sharing the current session.",
                args: {},
                async execute() {
                    sharing = false;
                    stopLiveQueuePulse();
                    pendingQueue.clear();
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
            stopLiveQueuePulse();
            pendingQueue.clear();
            relay.stop();
        },
    };
}
//# sourceMappingURL=index.js.map