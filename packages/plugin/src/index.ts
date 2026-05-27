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
        name: "chorus_share",
        description: "Expose the current session for viewing or pair programming",
        parameters: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["view", "pair"],
              description: "view = read-only observers; pair = observers can send LLM messages",
            },
          },
        },
        execute: async (_params: unknown) => {
          if (sharing) {
            const ip = getLanIp();
            const token = access.issueToken(sessionId);
            return { url: `http://${ip}:${DEFAULT_PORT}?token=${token.token}`, sharing: true };
          }

          sharing = true;
          relay.start();

          const ip = getLanIp();
          const token = access.issueToken(sessionId);
          const info: ShareInfo = {
            url: `http://${ip}:${DEFAULT_PORT}?token=${token.token}`,
            token: token.token,
            sessionId,
            port: DEFAULT_PORT,
          };

          console.log(`[chorus] sharing session at ${info.url}`);
          return info;
        },
      },
      {
        name: "chorus_stop",
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
