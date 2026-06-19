export const SPECIALIST_ROUTES = [
  "tool_protocol",
  "knowledge",
  "persona",
  "casual",
  "social_cue",
  "boundary",
] as const;

export const SPECIALIST_EXPERTS = ["tool", "knowledge", "conversation", "safety"] as const;

export type SpecialistRoute = (typeof SPECIALIST_ROUTES)[number];
export type SpecialistExpert = (typeof SPECIALIST_EXPERTS)[number];

export function expertForRoute(route: SpecialistRoute): SpecialistExpert {
  if (route === "tool_protocol") return "tool";
  if (route === "knowledge") return "knowledge";
  if (route === "boundary") return "safety";
  return "conversation";
}

export function normalizeSpecialistRoute(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isSpecialistRoute(value: string): value is SpecialistRoute {
  return (SPECIALIST_ROUTES as readonly string[]).includes(value);
}
