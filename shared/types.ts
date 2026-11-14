/** Shared API contracts consumed by the client and available to server packages. */
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export interface PublicUser {
  id: string;
  username: string;
  email?: string;
  avatar?: string | null;
  banner?: string | null;
  bio?: string;
  status_text?: string;
  presence?: Presence;
  created_at?: string;
}

export interface MessageReaction {
  emoji: string;
  user_id: string;
}

export interface MessageAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface MessageRecord {
  id: string;
  sender_id: string;
  username: string;
  avatar?: string | null;
  content: string;
  created_at: string;
  edited_at?: string | null;
  reply_to?: string | null;
  pinned?: number;
  reactions: MessageReaction[];
  attachments: MessageAttachment[];
  channel_id?: string | null;
  dm_id?: string | null;
}

export interface ChannelRecord {
  id: string;
  server_id: string;
  category_id?: string | null;
  name: string;
  type: 'text' | 'voice' | 'announcement';
  topic?: string;
  position: number;
  slow_mode: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  description: string;
  icon?: string | null;
  member_count?: number;
  role_id?: string | null;
}

export interface NotificationRecord {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string;
  created_at: string;
  read_at?: string | null;
}
