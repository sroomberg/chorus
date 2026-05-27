export type UserRole = "host" | "collaborator" | "viewer";

export interface SessionToken {
  token: string;
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
}

export interface ConnectedUser {
  userId: string;
  role: UserRole;
  joinedAt: number;
  displayName?: string;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  displayName?: string;
  content: string;
  timestamp: number;
}

export interface SessionSnapshot {
  sessionId: string;
  projectId?: string;
  events: SessionEvent[];
  messages: ChatMessage[];
  startedAt: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface BackupMeta {
  backupId: string;
  sessionId: string;
  createdAt: number;
  eventCount: number;
}

export interface ShareInfo {
  url: string;
  token: string;
  sessionId: string;
  port: number;
}
