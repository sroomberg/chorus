export class S3BackupAdapter {
    config;
    prefix;
    constructor(config) {
        this.config = config;
        this.prefix = config.prefix ?? "chorus/sessions/";
    }
    key(backupId) {
        return `${this.prefix}${backupId}.json`;
    }
    metaKey(backupId) {
        return `${this.prefix}meta/${backupId}.json`;
    }
    async save(snapshot) {
        const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
        const client = new S3Client({
            region: this.config.region ?? "us-east-1",
            endpoint: this.config.endpoint,
        });
        const backupId = `${snapshot.sessionId}-${Date.now()}`;
        const meta = {
            backupId,
            sessionId: snapshot.sessionId,
            createdAt: Date.now(),
            eventCount: snapshot.events.length,
        };
        await Promise.all([
            client.send(new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: this.key(backupId),
                Body: JSON.stringify(snapshot),
                ContentType: "application/json",
            })),
            client.send(new PutObjectCommand({
                Bucket: this.config.bucket,
                Key: this.metaKey(backupId),
                Body: JSON.stringify(meta),
                ContentType: "application/json",
            })),
        ]);
        return backupId;
    }
    async load(backupId) {
        const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
        const client = new S3Client({
            region: this.config.region ?? "us-east-1",
            endpoint: this.config.endpoint,
        });
        const response = await client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(backupId) }));
        const body = await response.Body?.transformToString();
        if (!body)
            throw new Error(`Backup ${backupId} not found`);
        return JSON.parse(body);
    }
    async list() {
        const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
        const client = new S3Client({
            region: this.config.region ?? "us-east-1",
            endpoint: this.config.endpoint,
        });
        const listed = await client.send(new ListObjectsV2Command({
            Bucket: this.config.bucket,
            Prefix: `${this.prefix}meta/`,
        }));
        const metas = [];
        for (const obj of listed.Contents ?? []) {
            if (!obj.Key)
                continue;
            const res = await client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: obj.Key }));
            const body = await res.Body?.transformToString();
            if (body)
                metas.push(JSON.parse(body));
        }
        return metas;
    }
}
//# sourceMappingURL=index.js.map