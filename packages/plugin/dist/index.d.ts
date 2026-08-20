import { z } from "zod";
interface PluginInput {
    client: {
        session: {
            prompt(opts: {
                throwOnError?: boolean;
                path: {
                    id: string;
                };
                body: {
                    noReply?: boolean;
                    parts: Array<{
                        type: "text";
                        text: string;
                        synthetic?: boolean;
                    }>;
                };
            }): Promise<unknown>;
            /** Cancel in-flight local generation (used so joiners don't run a divergent LLM). */
            abort?(opts: {
                path: {
                    id: string;
                };
                query?: {
                    directory?: string;
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
                query?: {
                    directory?: string;
                };
            }): Promise<unknown>;
            /** Navigate attached TUI to a session (helps surface externally injected lines). */
            selectSession?(opts?: {
                body?: {
                    sessionID: string;
                };
                query?: {
                    directory?: string;
                };
            }): Promise<unknown>;
            executeCommand?(opts?: {
                body?: {
                    command: string;
                };
                query?: {
                    directory?: string;
                };
            }): Promise<unknown>;
        };
    };
}
interface ToolContext {
    sessionID: string;
    directory: string;
}
export default function chorusPlugin(input: PluginInput): Promise<{
    /**
     * Backup for host prompts that miss chat.message (busy session / attach TUI).
     * Deduped against chat.message and collab.input fan-out.
     */
    event: (hookInput: {
        event: {
            type: string;
            properties?: {
                info?: {
                    id?: string;
                    role?: string;
                };
                part?: {
                    type?: string;
                    text?: string;
                    synthetic?: boolean;
                    messageID?: string;
                    sessionID?: string;
                };
            };
        };
    }) => Promise<void>;
    "chat.message": (chatInput: {
        sessionID: string;
        messageID?: string;
    }, output: {
        message?: {
            id?: string;
        };
        parts: Array<{
            type: string;
            text?: string;
            synthetic?: boolean;
        }>;
    }) => Promise<void>;
    "experimental.text.complete": (hookInput: {
        sessionID: string;
        messageID: string;
        partID: string;
    }, hookOutput: {
        text: string;
    }) => Promise<void>;
    tool: {
        "chorus-share": {
            description: string;
            args: {
                role: z.ZodOptional<z.ZodEnum<{
                    admin: "admin";
                    edit: "edit";
                    view: "view";
                }>>;
                requireApproval: z.ZodOptional<z.ZodBoolean>;
            };
            execute(args: {
                role?: "edit" | "view" | "admin";
                requireApproval?: boolean;
            }, context: ToolContext): Promise<string>;
        };
        "chorus-join": {
            description: string;
            args: {
                token: z.ZodString;
                host: z.ZodString;
                name: z.ZodString;
                email: z.ZodOptional<z.ZodString>;
            };
            execute(args: {
                token: string;
                host: string;
                name: string;
                email?: string;
            }, context: ToolContext): Promise<string>;
        };
        "chorus-approve": {
            description: string;
            args: {
                userId: z.ZodOptional<z.ZodString>;
            };
            execute(args: {
                userId?: string;
            }): Promise<string>;
        };
        "chorus-deny": {
            description: string;
            args: {
                userId: z.ZodOptional<z.ZodString>;
            };
            execute(args: {
                userId?: string;
            }): Promise<string>;
        };
        "chorus-kick": {
            description: string;
            args: {
                userId: z.ZodString;
            };
            execute(args: {
                userId: string;
            }): Promise<string>;
        };
        "chorus-leave": {
            description: string;
            args: {};
            execute(): Promise<string>;
        };
        "chorus-chat": {
            description: string;
            args: {
                message: z.ZodString;
            };
            execute(args: {
                message: string;
            }): Promise<string>;
        };
        "chorus-status": {
            description: string;
            args: {};
            execute(_args: Record<string, never>, context: ToolContext): Promise<string>;
        };
        "chorus-stop": {
            description: string;
            args: {};
            execute(): Promise<string>;
        };
    };
    dispose: () => Promise<void>;
}>;
export {};
//# sourceMappingURL=index.d.ts.map