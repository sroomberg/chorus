import { AccessManager } from "./access/index.js";
import { RelayServer } from "./relay/index.js";
import { JoinClient } from "./join/index.js";
import type { BackupAdapter } from "./backup/index.js";
import { S3BackupAdapter } from "./backup/index.js";
import type { SessionEvent, ShareInfo, UserRole } from "@chorus/shared";
import { networkInterfaces } from "node:os";
import { mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const DEFAULT_PORT = parseInt(process.env["CHORUS_PORT"] ?? "7742", 10);

// TODO: replace with native plugin slash command registration once supported
// https://github.com/sst/opencode/issues/5305
function installCommands(): void {
  try {
    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(pluginDir, "..", "commands");
    const destDir = join(homedir(), ".config", "opencode", "commands");
    if (!existsSync(srcDir)) return;
    mkdirSync(destDir, { recursive: true });
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".md"))) {
      const dest = join(destDir, file);
      if (!existsSync(dest)) {
        copyFileSync(join(srcDir, file), dest);

      }
    }
  } catch {
    // Non-fatal — commands can be installed manually
  }
}

function getLanIp(): string {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function buildBackupAdapter(): BackupAdapter | null {
  const bucket = process.env["CHORUS_AWS_BUCKET"];
  if (!bucket) return null;
  return new S3BackupAdapter({
    bucket,
    region: process.env["CHORUS_AWS_REGION"],
    endpoint: process.env["CHORUS_AWS_ENDPOINT"],
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// OpenCode plugin entry point
//
// API: https://github.com/sst/opencode — @opencode-ai/plugin v1.15.11
// Plugin receives a single PluginInput and returns a Hooks object.
// Tools are registered via hooks.tool as { [name]: { description, args, execute } }
// where args is a Zod raw shape (NOT JSON Schema).
// ──────────────────────────────────────────────────────────────────────────────

interface PluginInput {
  client: {
    session: {
      prompt(opts: {
        throwOnError?: boolean;
        path: { id: string };
        body: {
          noReply?: boolean;
          parts: Array<{ type: "text"; text: string; synthetic?: boolean }>;
        };
      }): Promise<unknown>;
    };
    tui: {
      showToast(opts?: {
        body?: {
          title?: string;
          message: string;
          variant: "info" | "success" | "warning" | "error";
          duration?: number;
        };
        query?: { directory?: string };
      }): Promise<unknown>;
    };
  };
}

interface ToolContext {
  sessionID: string;
  directory: string;
}

export default async function chorusPlugin(input: PluginInput) {
  installCommands();

  const access = new AccessManager();
  const relay = new RelayServer(access, DEFAULT_PORT);
  const backup = buildBackupAdapter();

  let sessionId = "";
  let sharing = false;
  const events: SessionEvent[] = [];

  let joinClient: JoinClient | null = null;

  function toast(message: string, variant: "info" | "success" | "warning" | "error" = "info", duration = 4000): void {
    input.client.tui.showToast({ body: { message, variant, duration } }).catch(() => {});
  }

  function say(sid: string, text: string): void {
    input.client.session
      .prompt({ throwOnError: false, path: { id: sid }, body: { noReply: true, parts: [{ type: "text", text }] } })
      .catch(() => {});
  }

  // Track when we're injecting a collab message so chat.message hook can skip pushing it as an event
  let pendingCollabInject = false;

  relay.setInputHandler(async (content, userId) => {
    if (!sessionId) return;
    const user = access.getUser(userId);
    const label = user?.displayName ?? userId.slice(0, 8);
    pendingCollabInject = true;
    try {
      await input.client.session.prompt({
        throwOnError: true,
        path: { id: sessionId },
        body: { parts: [{ type: "text", text: `[${label}]: ${content}` }] },
      });
    } finally {
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
    "chat.message": async (
      chatInput: { sessionID: string },
      output: { parts: Array<{ type: string; text?: string; synthetic?: boolean }> }
    ) => {
      sessionId = chatInput.sessionID;

      if (joinClient) {
        const state = joinClient.getState();
        if (state.status === "connected") {
          const text = output.parts
            .filter((p) => p.type === "text" && !p.synthetic)
            .map((p) => p.text ?? "")
            .join("\n");
          if (text) joinClient.sendInput(text);
        }
      }

      if (!sharing) return;

      const text = output.parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => p.text ?? "")
        .join("\n");

      // Skip collab-injected and synthetic messages — they're already visible in both sessions
      if (!text || pendingCollabInject) return;

      const event: SessionEvent = {
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

    "experimental.text.complete": async (
      hookInput: { sessionID: string; messageID: string; partID: string },
      hookOutput: { text: string }
    ) => {
      sessionId = hookInput.sessionID;
      if (!sharing || !hookOutput.text) return;

      const event: SessionEvent = {
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
        description:
          "Start sharing this session and generate a join token for a collaborator. " +
          "The recipient must have OpenCode + the chorus plugin installed and run chorus-join. " +
          "Roles: edit (default, can send LLM messages), view (read-only), admin (full control).",
        args: {
          role: z
            .enum(["edit", "view", "admin"])
            .optional()
            .describe(
              "Role for the recipient. edit = can contribute (default); " +
                "view = read-only; admin = full control."
            ),
        },
        async execute(args: { role?: "edit" | "view" | "admin" }, context: ToolContext) {
          const grantedRole: UserRole =
            args.role === "admin" ? "admin" : args.role === "view" ? "view" : "edit";

          const sid = sessionId || context.sessionID;

          if (!sharing) {
            sharing = true;
            relay.start();
            say(sid, `chorus relay started on port ${DEFAULT_PORT}`);
          }

          const ip = getLanIp();
          const token = access.issueToken(sid, grantedRole);
          const info: ShareInfo & { role: string } = {
            token: token.token,
            sessionId: sid,
            port: DEFAULT_PORT,
            url: `${ip}:${DEFAULT_PORT}`,
            role: grantedRole,
          };

          const joinCommand = `/chorus-join token="${token.token}" host="${ip}:${DEFAULT_PORT}"`;
          say(sid, `Send this command to your collaborator:\n${joinCommand}`);

          return JSON.stringify({
            ...info,
            connect: joinCommand,
          });
        },
      },

      "chorus-join": {
        description:
          "Join another user's shared OpenCode session. " +
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
        async execute(args: { token: string; host: string; name?: string }) {
          if (joinClient) {
            joinClient.disconnect();
            joinClient = null;
          }

          const displayName = args.name ?? process.env["USER"] ?? "unknown";
          const jc = new JoinClient(`ws://${args.host}/ws`, args.token, displayName);

          try {
            await jc.connect();
          } catch (err) {
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

          jc.setEventHandler((event) => {
            const payload =
              typeof event.payload === "string"
                ? event.payload
                : JSON.stringify(event.payload);
            if (event.type === "user") {
              toast(`[Host]: ${payload}`);
            } else if (event.type === "assistant") {
              // AI responses can be long — show a truncated preview toast
              const preview = payload.length > 120 ? `${payload.slice(0, 117)}…` : payload;
              toast(`[AI]: ${preview}`);
            }
          });

          joinClient = jc;
          const state = jc.getState();
          return JSON.stringify({
            joined: true,
            users: state.users,
            recentEventCount: state.recentEvents.length,
            message:
              "Connected. Your messages will now be forwarded to the shared session. " +
              "Run chorus-leave to disconnect.",
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
          return JSON.stringify({ left: true });
        },
      },

      "chorus-chat": {
        description:
          "Send a chat message to all participants in the current chorus session. " +
          "Visible to both the host and all joined collaborators as an inline notification.",
        args: {
          message: z.string().describe("The message to send to all participants."),
        },
        async execute(args: { message: string }) {
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
        description:
          "Show the current chorus state: whether sharing, joined, and who is connected.",
        args: {},
        async execute() {
          const shareInfo = sharing
            ? { sharing: true, clients: relay.clientCount, port: DEFAULT_PORT }
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
      relay.stop();
    },
  };
}
