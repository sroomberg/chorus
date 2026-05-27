import type { SessionSnapshot, BackupMeta } from "@chorus/shared";

export interface BackupAdapter {
  save(snapshot: SessionSnapshot): Promise<string>;
  load(backupId: string): Promise<SessionSnapshot>;
  list(): Promise<BackupMeta[]>;
}

export interface S3BackupConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
}

export class S3BackupAdapter implements BackupAdapter {
  private readonly prefix: string;

  constructor(private readonly config: S3BackupConfig) {
    this.prefix = config.prefix ?? "chorus/sessions/";
  }

  private key(backupId: string): string {
    return `${this.prefix}${backupId}.json`;
  }

  private metaKey(backupId: string): string {
    return `${this.prefix}meta/${backupId}.json`;
  }

  async save(snapshot: SessionSnapshot): Promise<string> {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: this.config.region ?? "us-east-1",
      endpoint: this.config.endpoint,
    });

    const backupId = `${snapshot.sessionId}-${Date.now()}`;
    const meta: BackupMeta = {
      backupId,
      sessionId: snapshot.sessionId,
      createdAt: Date.now(),
      eventCount: snapshot.events.length,
    };

    await Promise.all([
      client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.key(backupId),
          Body: JSON.stringify(snapshot),
          ContentType: "application/json",
        })
      ),
      client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: this.metaKey(backupId),
          Body: JSON.stringify(meta),
          ContentType: "application/json",
        })
      ),
    ]);

    return backupId;
  }

  async load(backupId: string): Promise<SessionSnapshot> {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: this.config.region ?? "us-east-1",
      endpoint: this.config.endpoint,
    });

    const response = await client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(backupId) })
    );

    const body = await response.Body?.transformToString();
    if (!body) throw new Error(`Backup ${backupId} not found`);
    return JSON.parse(body) as SessionSnapshot;
  }

  async list(): Promise<BackupMeta[]> {
    const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import(
      "@aws-sdk/client-s3"
    );
    const client = new S3Client({
      region: this.config.region ?? "us-east-1",
      endpoint: this.config.endpoint,
    });

    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: `${this.prefix}meta/`,
      })
    );

    const metas: BackupMeta[] = [];
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key) continue;
      const res = await client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: obj.Key })
      );
      const body = await res.Body?.transformToString();
      if (body) metas.push(JSON.parse(body) as BackupMeta);
    }
    return metas;
  }
}
