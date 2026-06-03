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

  async listRecentByChannel(channelId: string, limit = 20) {
    return this.prisma.conversation.findMany({
      where: { channelId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }
}
