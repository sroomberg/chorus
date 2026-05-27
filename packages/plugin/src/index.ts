import { AccessManager } from "./access/index.js";
import { RelayServer } from "./relay/index.js";
import type { BackupAdapter } from "./backup/index.js";
import { S3BackupAdapter } from "./backup/index.js";
import type { SessionEvent, ShareInfo } from "@chorus/shared";
import { networkInterfaces } from "node:os";

export { AccessManager } from "./access/index.js";
export { RelayServer } from "./relay/index.js";
export type { BackupAdapter } from "./backup/index.js";
export { S3BackupAdapter } from "./backup/index.js";

const DEFAULT_PORT = parseInt(process.env["CHORUS_PORT"] ?? "7742", 10);

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
  const access = new AccessManager();
  const relay = new RelayServer(access, DEFAULT_PORT);
  const backup = buildBackupAdapter();

  let sessionId = "";
  let sharing = false;
  const events: SessionEvent[] = [];

  relay.setInputHandler(async (content, userId) => {
    if (!sessionId) return;
    console.log(`[chorus] injecting input from ${userId}: ${content.slice(0, 40)}`);
    await client.session.send(sessionId, content);
  });

  return {
    "chat.message": async (msg) => {
      if (!sharing) return;
      sessionId = msg.sessionId;

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
          "Generate a link to share the current session with someone. " +
          "Call once to start sharing, then again with a role to generate additional links. " +
          "Roles: edit (default, can send LLM messages), view (read-only), admin (full control).",
        parameters: {
          type: "object",
          properties: {
            role: {
              type: "string",
              enum: ["edit", "view", "admin"],
              description:
                "Role to grant the recipient. edit = can send LLM messages (default); " +
                "view = read-only observer; admin = full control (promote/demote/kick).",
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
          const url = `http://${ip}:${DEFAULT_PORT}?token=${token.token}`;
          const info: ShareInfo = { url, token: token.token, sessionId, port: DEFAULT_PORT };

          console.log(`[chorus] ${grantedRole} link: ${url}`);
          return info;
        },
      },
      {
        name: "chorus-stop",
        description: "Stop sharing the current session",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          sharing = false;
          relay.stop();
          return { stopped: true };
        },
      },
    ],

    dispose: async () => {
      relay.stop();
    },
  };
}
