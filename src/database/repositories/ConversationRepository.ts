import type { PrismaClient } from "@prisma/client";
import type { JsonValue } from "../../types/common";

export interface CreateConversationInput {
  guildId: string | null;
  channelId: string;
  userId: string;
  discordMessageId: string;
  userMessage: string;
  assistantResponse: string | null;
  metadataJson: JsonValue;
}

export interface ActiveConversationChannel {
  guildId: string | null;
  channelId: string;
  conversationCount: number;
  lastConversationAt: string;
}

export class ConversationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateConversationInput): Promise<string> {
    const row = await this.prisma.conversation.create({
      data: {
        guildId: input.guildId,
        channelId: input.channelId,
        userId: input.userId,
        discordMessageId: input.discordMessageId,
        userMessage: input.userMessage,
        assistantResponse: input.assistantResponse,
        metadataJson: input.metadataJson ?? {},
      },
      select: { id: true },
    });
    return row.id;
  }

  async count(): Promise<number> {
    return this.prisma.conversation.count();
  }

  async listActiveChannelsSince(since: Date, limit = 50): Promise<ActiveConversationChannel[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { createdAt: { gte: since } },
      select: { guildId: true, channelId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: Math.max(limit * 100, limit),
    });

    const byChannel = new Map<string, ActiveConversationChannel>();
    for (const row of rows) {
      const key = `${row.guildId ?? "dm"}:${row.channelId}`;
      const existing = byChannel.get(key);
      if (existing) {
        existing.conversationCount += 1;
        continue;
      }
      byChannel.set(key, {
        guildId: row.guildId,
        channelId: row.channelId,
        conversationCount: 1,
        lastConversationAt: row.createdAt.toISOString(),
      });
    }

    return [...byChannel.values()]
      .sort((a, b) => b.lastConversationAt.localeCompare(a.lastConversationAt))
      .slice(0, limit);
  }

  async listRecentByChannel(channelId: string, limit = 20) {
    return this.prisma.conversation.findMany({
      where: { channelId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
