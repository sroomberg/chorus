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
export declare class S3BackupAdapter implements BackupAdapter {
    private readonly config;
    private readonly prefix;
    constructor(config: S3BackupConfig);
    private key;
    private metaKey;
    save(snapshot: SessionSnapshot): Promise<string>;
    load(backupId: string): Promise<SessionSnapshot>;
    list(): Promise<BackupMeta[]>;
}
//# sourceMappingURL=index.d.ts.map