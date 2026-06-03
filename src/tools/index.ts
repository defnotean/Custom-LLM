import { ToolRegistry } from "./ToolRegistry";
import { utilityTools } from "./categories/utilityTools";
import { moderationTools } from "./categories/moderationTools";
import { memoryTools } from "./categories/memoryTools";
import { discordTools } from "./categories/discordTools";
import { exampleTools } from "./categories/exampleTools";

/** Build the registry with all starter tools. Add new categories here. */
export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(utilityTools);
  registry.registerAll(moderationTools);
  registry.registerAll(memoryTools);
  registry.registerAll(discordTools);
  registry.registerAll(exampleTools);
  return registry;
}
