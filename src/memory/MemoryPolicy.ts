/**
 * Decides what is worth storing in long-term memory. The bot must NOT store
 * everything — memory is for durable, useful facts.
 *
 * Store: stable preferences, server configuration facts, recurring user
 * preferences, important project info, tool outcomes worth remembering.
 * Never store: secrets/tokens/passwords (even on explicit request),
 * one-off messages, jokes, sensitive personal data without an explicit ask.
 */

export interface MemoryPolicyInput {
  content: string;
  /** True when the user explicitly asked to remember (tool / command). */
  explicit?: boolean;
}

export interface MemoryPolicyVerdict {
  store: boolean;
  importance: number; // 1 (low) .. 5 (critical)
  reason: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(password|passwd|passphrase)\b\s*[:=]?/i,
  /\bapi[_ -]?key\b/i,
  /\bsecret\b\s*[:=]/i,
  /\b(bearer|authorization)\s+[a-z0-9._-]{10,}/i,
  /\bsk-[a-z0-9]{16,}/i, // common API key shape
  /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/, // Discord token shape
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const PII_PATTERNS: RegExp[] = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, // email
  /\+?\d[\d\s().-]{7,}\d/, // phone-ish
  /\b\d{1,5}\s+\w+\s+(street|st|avenue|ave|road|rd|lane|ln|drive|dr)\b/i, // address-ish
];

const STABLE_FACT_PATTERNS: RegExp[] = [
  /\bi prefer\b/i,
  /\bmy favou?rite\b/i,
  /\bcall me\b/i,
  /\bmy (name|pronouns|timezone|tz|birthday|main|setup|rig)\b/i,
  /\bi (always|never|usually|main)\b/i,
  /\bi('m| am) (from|in|learning|working on|building)\b/i,
  /\bi use\b/i,
  /\bremember (that|this)?\b/i,
  /\b(our|the) (server|guild|project|team)('s)? (rule|rules|game night|schedule|meeting|standup)\b/i,
];

const ONE_OFF_PATTERNS: RegExp[] = [
  /\b(lol|lmao|rofl|haha|hahaha|xd)\b/i,
  /^[\W\d\s]*$/, // no letters at all
  /^(hi|hey|hello|yo|sup|gm|gn|good (morning|night))\b/i,
  /\?$/, // questions are requests, not facts
];

export class MemoryPolicy {
  evaluate(input: MemoryPolicyInput): MemoryPolicyVerdict {
    const content = input.content.trim();

    // 1. Secrets are never stored — explicit request included. The right
    //    response is refusal, not storage.
    if (SECRET_PATTERNS.some((p) => p.test(content))) {
      return {
        store: false,
        importance: 0,
        reason: "content looks like a secret/credential — never stored",
      };
    }

    // 2. Size bounds.
    if (content.length < 8) {
      return { store: false, importance: 0, reason: "too short to be a useful memory" };
    }
    if (content.length > 2000) {
      return { store: false, importance: 0, reason: "too long — summarize before storing" };
    }

    // 3. PII is only stored on an explicit ask.
    const hasPII = PII_PATTERNS.some((p) => p.test(content));
    if (hasPII && !input.explicit) {
      return {
        store: false,
        importance: 0,
        reason: "contains personal data (email/phone/address) — only stored on explicit request",
      };
    }

    // 4. Explicit requests (minus secrets, handled above) are stored.
    if (input.explicit) {
      return { store: true, importance: 4, reason: "explicit remember request" };
    }

    // 5. Obvious one-off chatter is skipped.
    if (ONE_OFF_PATTERNS.some((p) => p.test(content))) {
      return { store: false, importance: 0, reason: "one-off/casual message" };
    }

    // 6. Stable facts/preferences are stored automatically.
    if (STABLE_FACT_PATTERNS.some((p) => p.test(content))) {
      return { store: true, importance: 3, reason: "stable preference/fact pattern" };
    }

    // Default: do not store. Conservative beats hoarding.
    return { store: false, importance: 0, reason: "no durable-fact signal" };
  }
}
