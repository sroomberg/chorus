import { AccessManager } from "./access/index.js";
import { RelayServer } from "./relay/index.js";
import { JoinClient } from "./join/index.js";
import type { BackupAdapter } from "./backup/index.js";
import { S3BackupAdapter } from "./backup/index.js";
import type { SessionEvent, ShareInfo } from "@chorus/shared";
import { networkInterfaces } from "node:os";
import { mkdirSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export { AccessManager } from "./access/index.js";
export { RelayServer } from "./relay/index.js";
export { JoinClient } from "./join/index.js";
export type { BackupAdapter } from "./backup/index.js";
export { S3BackupAdapter } from "./backup/index.js";

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
        console.log(`[chorus] installed slash command: /${file.replace(".md", "")}`);
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
// OpenCode loads this file as an ES module from .opencode/plugin/.
// The default export must be the plugin function (or an object with a default).
// ──────────────────────────────────────────────────────────────────────────────

interface OpenCodeApp {
  dir: string;
}

interface OpenCodeClient {
  session: {
    send: (sessionId: string, content: string) => Promise<void>;
  };
}

interface PluginHooks {
  "chat.message"?: (msg: {
    sessionId: string;
    type: string;
    content: unknown;
  }) => void | Promise<void>;
  "tool.register"?: () => {
    name: string;
    description: string;
    parameters: unknown;
    execute: (params: unknown) => Promise<unknown>;
  }[];
  dispose?: () => void | Promise<void>;
}

export default async function chorusPlugin(
  app: OpenCodeApp,
  client: OpenCodeClient
): Promise<PluginHooks> {
  installCommands();

  const access = new AccessManager();
  const relay = new RelayServer(access, DEFAULT_PORT);
  const backup = buildBackupAdapter();

  let sessionId = "";
  let sharing = false;
  const events: SessionEvent[] = [];

  // Active join connection (when this instance has joined someone else's session)
  let joinClient: JoinClient | null = null;

  relay.setInputHandler(async (content, userId) => {
    if (!sessionId) return;
    console.log(`[chorus] injecting input from ${userId}: ${content.slice(0, 40)}`);
    await client.session.send(sessionId, content);
  });

  return {
    "chat.message": async (msg) => {
      sessionId = msg.sessionId;

      // Forward to the host relay when joined as a collaborator/admin
      if (joinClient) {
        const state = joinClient.getState();
        if (state.status === "connected" && msg.type === "user") {
          joinClient.sendInput(String(msg.content));
        }
      }

      if (!sharing) return;

      const event: SessionEvent = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: msg.sessionId,
        type: msg.type,
        payload: msg.content,
        timestamp: Date.now(),
      };
      events.push(event);
      relay.pushEvent(event);

      if (backup) {
        backup
          .save({
            sessionId: msg.sessionId,
            events,
            messages: [],
            startedAt: events[0]?.timestamp ?? Date.now(),
          })
          .catch(console.error);
      }
    },

    "tool.register": () => [
      {
        name: "chorus-share",
        description:
          "Start sharing this session and generate a join token for a collaborator. " +
          "The recipient must have OpenCode + the chorus plugin installed and run chorus-join. " +
          "Roles: edit (default, can send LLM messages), view (read-only), admin (full control).",
        parameters: {
          type: "object",
          properties: {
            role: {
              type: "string",
              enum: ["edit", "view", "admin"],
              description:
                "Role for the recipient. edit = can contribute (default); " +
                "view = read-only; admin = full control.",
            },
          },
        },
        execute: async (params: unknown) => {
          const { role = "edit" } = (params as { role?: string }) ?? {};
          const grantedRole = (
            role === "admin" ? "admin" : role === "view" ? "view" : "edit"
          ) as import("@chorus/shared").UserRole;

          if (!sharing) {
            sharing = true;
            relay.start();
            console.log(`[chorus] relay started on port ${DEFAULT_PORT}`);
          }

          const ip = getLanIp();
          const token = access.issueToken(sessionId, grantedRole);
          const info: ShareInfo & { role: string } = {
            token: token.token,
            sessionId,
            port: DEFAULT_PORT,
            url: `${ip}:${DEFAULT_PORT}`,
            role: grantedRole,
          };

          console.log(`[chorus] ${grantedRole} token generated — share with: ${info.url}`);
          return {
            ...info,
            instructions: `Recipient should run: chorus-join with token "${token.token}" and host "${ip}:${DEFAULT_PORT}"`,
          };
        },
      },
      {
        name: "chorus-join",
        description:
          "Join another user's shared OpenCode session. " +
          "Requires the token and host address provided by the session organizer via chorus-share. " +
          "Once joined, your messages are also forwarded to the shared session.",
        parameters: {
          type: "object",
          required: ["token", "host"],
          properties: {
            token: {
              type: "string",
              description: "The session token provided by the organizer.",
            },
            host: {
              type: "string",
              description: "Host address of the organizer's relay, e.g. 192.168.1.5:7742",
            },
            name: {
              type: "string",
              description: "Your display name in the session (defaults to system username).",
            },
          },
        },
        execute: async (params: unknown) => {
          const { token, host, name } = params as {
            token: string;
            host: string;
            name?: string;
          };

          if (joinClient) {
            joinClient.disconnect();
            joinClient = null;
          }

          const displayName = name ?? process.env["USER"] ?? "unknown";
          const wsUrl = `ws://${host}/ws`;
          const jc = new JoinClient(wsUrl, token, displayName);

          try {
            await jc.connect();
          } catch (err) {
            return {
              joined: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }

          joinClient = jc;
          const state = jc.getState();

          return {
            joined: true,
            users: state.users,
            recentEventCount: state.recentEvents.length,
            message:
              "Connected. Your messages will now be forwarded to the shared session. " +
              "Run chorus-leave to disconnect.",
          };
        },
      },
      {
        name: "chorus-leave",
        description: "Leave the currently joined session.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          if (!joinClient) return { left: false, message: "Not currently joined to any session." };
          joinClient.disconnect();
          joinClient = null;
          return { left: true };
        },
      },
      {
        name: "chorus-status",
        description:
          "Show the current chorus state: whether sharing, joined, and who is connected.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const shareInfo = sharing
            ? { sharing: true, clients: relay.clientCount, port: DEFAULT_PORT }
            : { sharing: false };
          const joinInfo = joinClient
            ? { joined: true, ...joinClient.getState() }
            : { joined: false };
          return { ...shareInfo, ...joinInfo };
        },
      },
      {
        name: "chorus-stop",
        description: "Stop sharing the current session.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          sharing = false;
          relay.stop();
          return { stopped: true };
        },
      },
    ],

    dispose: async () => {
      joinClient?.disconnect();
      relay.stop();
    },
  };
}
