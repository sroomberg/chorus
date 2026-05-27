import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionSnapshot } from "@chorus/shared";

// Mock the AWS SDK to avoid real network calls
vi.mock("@aws-sdk/client-s3", () => {
  const store = new Map<string, string>();

  const S3Client = vi.fn().mockImplementation(() => ({
    send: vi.fn().mockImplementation(async (cmd: { _key?: string; _body?: string; _prefix?: string }) => {
      if (cmd.constructor.name === "PutObjectCommand") {
        store.set(cmd._key!, cmd._body!);
        return {};
      }
      if (cmd.constructor.name === "GetObjectCommand") {
        const body = store.get(cmd._key!);
        if (!body) throw new Error("NoSuchKey");
        return { Body: { transformToString: async () => body } };
      }
      if (cmd.constructor.name === "ListObjectsV2Command") {
        const prefix = cmd._prefix ?? "";
        const contents = [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((Key) => ({ Key }));
        return { Contents: contents };
      }
      return {};
    }),
  }));

  class PutObjectCommand {
    _key: string;
    _body: string;
    constructor(params: { Key: string; Body: string }) {
      this._key = params.Key;
      this._body = params.Body;
    }
  }

  class GetObjectCommand {
    _key: string;
    constructor(params: { Key: string }) {
      this._key = params.Key;
    }
  }

  class ListObjectsV2Command {
    _prefix: string;
    constructor(params: { Prefix: string }) {
      this._prefix = params.Prefix;
    }
  }

  return { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command };
});

describe("S3BackupAdapter", () => {
  let adapter: import("../src/backup/index.js").S3BackupAdapter;
  const snapshot: SessionSnapshot = {
    sessionId: "sess-xyz",
    events: [
      { id: "e1", sessionId: "sess-xyz", type: "msg", payload: "hello", timestamp: 1000 },
    ],
    messages: [],
    startedAt: 1000,
  };

  beforeEach(async () => {
    const { S3BackupAdapter } = await import("../src/backup/index.js");
    adapter = new S3BackupAdapter({ bucket: "test-bucket" });
  });

  it("saves and loads a session snapshot", async () => {
    const backupId = await adapter.save(snapshot);
    expect(typeof backupId).toBe("string");

    const loaded = await adapter.load(backupId);
    expect(loaded.sessionId).toBe("sess-xyz");
    expect(loaded.events).toHaveLength(1);
  });

  it("throws when loading unknown backupId", async () => {
    await expect(adapter.load("nonexistent")).rejects.toThrow();
  });
});
