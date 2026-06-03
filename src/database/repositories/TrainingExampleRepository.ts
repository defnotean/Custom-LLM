import type { PrismaClient, TrainingFormat, TrainingSource } from "@prisma/client";
import type { JsonValue } from "../../types/common";

export interface CreateTrainingExampleInput {
  source: TrainingSource;
  format: TrainingFormat;
  inputJson: JsonValue;
  outputJson: JsonValue;
  qualityScore: number | null;
  metadataJson: JsonValue;
}

export interface TrainingExampleRow {
  id: string;
  source: TrainingSource;
  format: TrainingFormat;
  inputJson: unknown;
  outputJson: unknown;
  qualityScore: number | null;
  reviewed: boolean;
  metadataJson: unknown;
  createdAt: Date;
}

export class TrainingExampleRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTrainingExampleInput): Promise<string> {
    const row = await this.prisma.trainingExample.create({
      data: {
        source: input.source,
        format: input.format,
        inputJson: input.inputJson ?? {},
        outputJson: input.outputJson ?? {},
        qualityScore: input.qualityScore,
        metadataJson: input.metadataJson ?? {},
      },
      select: { id: true },
    });
    return row.id;
  }

  async listByFormat(format: TrainingFormat, limit = 100_000): Promise<TrainingExampleRow[]> {
    return this.prisma.trainingExample.findMany({
      where: { format },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  async listAll(limit = 100_000): Promise<TrainingExampleRow[]> {
    return this.prisma.trainingExample.findMany({
      orderBy: { createdAt: "asc" },
      take: limit,
    });
  }

  async count(): Promise<number> {
    return this.prisma.trainingExample.count();
  }
}
