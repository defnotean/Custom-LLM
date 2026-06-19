import { performance } from "node:perf_hooks";
import { expertForRoute, type SpecialistExpert, type SpecialistRoute } from "./SpecialistRoutingContract";

export const HEURISTIC_SPECIALIST_ROUTER_MODEL = "heuristic_specialist_router_v1" as const;

export interface HeuristicSpecialistRouteDecision {
  route: SpecialistRoute;
  expert: SpecialistExpert;
  confidence: number;
  reason: string;
  matchedRule: string;
}

export interface TimedHeuristicSpecialistRouteDecision extends HeuristicSpecialistRouteDecision {
  model: typeof HEURISTIC_SPECIALIST_ROUTER_MODEL;
  latencyMs: number;
}

interface RouteRule {
  id: string;
  route: SpecialistRoute;
  confidence: number;
  reason: string;
  patterns: RegExp[];
}

const RULES: RouteRule[] = [
  {
    id: "boundary-credential-abuse",
    route: "boundary",
    confidence: 0.99,
    reason: "credential theft, account theft, phishing, or secret exfiltration needs a direct boundary",
    patterns: [
      /\b(steal|stealing|hijack|take over|break into|get into)\b.*\b(account|login)\b/,
      /\b(account|login)\b.*\b(steal|stealing|hijack|take over|break into|get into)\b/,
      /\b(phishing|credential|credentials|password|passwords|token|tokens|api key|api keys|secret|secrets)\b/,
      /\blogin[-\s]?stealing\b/,
      /\bsteals?\b.*\blogin\b/,
    ],
  },
  {
    id: "tool-discord-action",
    route: "tool_protocol",
    confidence: 0.97,
    reason: "explicit Discord action should go through tool selection and permission checks",
    patterns: [
      /\b(ban|timeout|warn|delete|remove|purge|kick|moderate)\b.*\b(@|user|message|chat|spam|spambot)\b/,
      /\b(send|post|announce|publish)\b.*\b(#|channel|announcements|message)\b/,
      /\b(check|ping|status|latency|alive)\b.*\b(bot|server|latency|alive)\b/,
    ],
  },
  {
    id: "persona-identity-style",
    route: "persona",
    confidence: 0.96,
    reason: "identity, pronouns, or Irene's presentation should route to persona",
    patterns: [
      /\bpronouns?\b/,
      /\bshe\/her\b/,
      /\bcall you she\b/,
      /\b(dude|guy|man|boy|girl)\b.*\b(call|you|she|her)\b/,
      /\b(can you|be|sound)\b.*\b(warmer|less robotic|more human|emotional style)\b/,
      /\b(tone|identity|persona)\b/,
    ],
  },
  {
    id: "social-cue",
    route: "social_cue",
    confidence: 0.94,
    reason: "support, celebration, or repair after a misread should route to social cues",
    patterns: [
      /\bworked\b.*\ball night\b/,
      /\ball night\b.*\b(sucks|terrible|rough|broken|bad)\b/,
      /\b(still sucks|still terrible|discouraged|exhausted|over it|feel dumb|i'?m stuck)\b/,
      /\bnot what i meant\b/,
      /\b(misread|what did i miss)\b/,
      /\b(finally|got it|we got it|the fix)\b.*\b(working|works|worked|passing|launched|fixed|runs|win)\b/,
    ],
  },
  {
    id: "knowledge-question",
    route: "knowledge",
    confidence: 0.93,
    reason: "factual or explanatory request with no external action",
    patterns: [
      /^(explain|what is|what are|why does|why do|how does|how do|what does)\b/,
      /\b(overfitting|qlora|lora|pgvector|redis|subq|subquadratic|sparse attention|packed sequences|memory system|model training)\b/,
    ],
  },
  {
    id: "casual-low-stakes",
    route: "casual",
    confidence: 0.91,
    reason: "low-stakes chat, slang, opinion, or no-tool vibe check",
    patterns: [/\b(no tools?|don'?t run|do not run|just vibe|vibe check|valid or cursed|cooked|ngl|fr|sus)\b/],
  },
];

export function routeSpecialistPrompt(prompt: string): HeuristicSpecialistRouteDecision {
  const normalized = normalizePrompt(prompt);
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return decision(rule);
    }
  }
  return decision({
    id: "casual-default",
    route: "casual",
    confidence: 0.75,
    reason: "default low-stakes conversation route when no stronger cue matches",
    patterns: [],
  });
}

export function routeWithHeuristicSpecialistRouter(input: {
  prompt: string;
}): TimedHeuristicSpecialistRouteDecision {
  const start = performance.now();
  const routed = routeSpecialistPrompt(input.prompt);
  return {
    ...routed,
    model: HEURISTIC_SPECIALIST_ROUTER_MODEL,
    latencyMs: Number((performance.now() - start).toFixed(3)),
  };
}

function decision(rule: Omit<RouteRule, "patterns"> | RouteRule): HeuristicSpecialistRouteDecision {
  return {
    route: rule.route,
    expert: expertForRoute(rule.route),
    confidence: rule.confidence,
    reason: rule.reason,
    matchedRule: rule.id,
  };
}

function normalizePrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/\u2019|`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
