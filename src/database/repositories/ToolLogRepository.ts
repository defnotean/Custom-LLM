import type { PrismaClient } from "@prisma/client";
import type { JsonValue } from "../../types/common";

export interface ToolLogEntry {
  toolName: string;
  toolCategory: string;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  inputJson: JsonValue;
  outputJson: JsonValue | null;
  error: string | null;
  latencyMs: number;
  success: boolean;
}

/** Persists tool executions; satisfies ToolExecutor's ToolLogSink port. */
export class ToolLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async log(entry: ToolLogEntry): Promise<void> {
    await this.prisma.toolLog.create({
      data: {
        toolName: entry.toolName,
        toolCategory: entry.toolCategory,
        guildId: entry.guildId,
        channelId: entry.channelId,
        userId: entry.userId,
        inputJson: entry.inputJson ?? {},
        outputJson: entry.outputJson ?? undefined,
        error: entry.error,
        latencyMs: entry.latencyMs,
        success: entry.success,
      },
    });
  }

  async count(): Promise<number> {
    return this.prisma.toolLog.count();
  }

  async successRate(toolName: string): Promise<number | null> {
    const [total, ok] = await Promise.all([
      this.prisma.toolLog.count({ where: { toolName } }),
      this.prisma.toolLog.count({ where: { toolName, success: true } }),
    ]);
    if (total === 0) return null;
    return ok / total;
  }
}
