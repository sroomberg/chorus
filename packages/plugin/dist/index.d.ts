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
        };
    };
}
interface ToolContext {
    sessionID: string;
    directory: string;
}
export default function chorusPlugin(input: PluginInput): Promise<{
    "chat.message": (chatInput: {
        sessionID: string;
    }, output: {
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
            };
            execute(args: {
                role?: "edit" | "view" | "admin";
            }, context: ToolContext): Promise<string>;
        };
        "chorus-join": {
            description: string;
            args: {
                token: z.ZodString;
                host: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
            };
            execute(args: {
                token: string;
                host: string;
                name?: string;
            }, context: ToolContext): Promise<string>;
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
            execute(): Promise<string>;
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