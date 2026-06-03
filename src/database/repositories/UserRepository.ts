import type { PrismaClient } from "@prisma/client";

export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Upsert the Discord user profile (called on interaction logging). */
  async ensure(discordUserId: string, username: string, displayName: string | null): Promise<void> {
    await this.prisma.userProfile.upsert({
      where: { discordUserId },
      create: { discordUserId, username, displayName },
      update: { username, displayName },
    });
  }

  async findByDiscordId(discordUserId: string) {
    return this.prisma.userProfile.findUnique({ where: { discordUserId } });
  }

  async count(): Promise<number> {
    return this.prisma.userProfile.count();
  }
}
