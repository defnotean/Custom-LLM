/**
 * Content moderation — PLACEHOLDER implementation.
 *
 * This is a minimal regex screen for unambiguous cases, not real moderation.
 * Production should layer: a moderation model (e.g. Llama Guard via the
 * local LLM endpoint), Discord AutoMod, and provider moderation APIs.
 * Tracked in docs/ARCHITECTURE.md → "Placeholders & TODOs".
 */

export interface ModerationVerdict {
  flagged: boolean;
  categories: string[];
  reason?: string;
}

interface Rule {
  category: string;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    category: "credentials",
    pattern: /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b|sk-[a-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    reason: "message appears to contain a credential/token",
  },
  {
    category: "mass_mention",
    pattern: /@everyone|@here/,
    reason: "mass mention attempt routed through the bot",
  },
  {
    category: "doxxing_request",
    pattern: /\b(dox+|find (his|her|their) (address|ip|location))\b/i,
    reason: "doxxing-related request",
  },
];

export class ModerationRules {
  screen(content: string): ModerationVerdict {
    const categories: string[] = [];
    let reason: string | undefined;
    for (const rule of RULES) {
      if (rule.pattern.test(content)) {
        categories.push(rule.category);
        reason = reason ?? rule.reason;
      }
    }
    return { flagged: categories.length > 0, categories, ...(reason ? { reason } : {}) };
  }
}
