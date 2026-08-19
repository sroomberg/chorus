/** Placeholder in `/chorus-share` output; joiners must replace it with a real name. */
export declare const JOIN_NAME_PLACEHOLDER = "YOUR_NAME";
/** Optional email slot shown when the host is not enforcing a company domain. */
export declare const JOIN_EMAIL_PLACEHOLDER = "<work-email>";
/** Ready-to-send join command, including args the collaborator should fill in. */
export declare function formatJoinCommand(token: string, host: string, opts?: {
    allowedEmailDomain?: string;
}): string;
//# sourceMappingURL=join-command.d.ts.map