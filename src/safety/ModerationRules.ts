/**
 * Operational boundary screen.
 *
 * This deliberately avoids broad "tone policing" so Irene can stay candid for
 * allowed prompts. It blocks narrow high-risk inputs that should not reach the
 * model context: pasted credentials, secret exfiltration requests, mass
 * mentions, doxxing, credential theft, and attempts to bypass tool gates.
 * Larger public deployments should still layer a local moderation model and
 * Discord AutoMod on top.
 */

export interface ModerationVerdict {
  flagged: boolean;
  categories: string[];
  reason?: string;
  matches?: Array<{ category: string; reason: string }>;
}

interface Rule {
  category: string;
  reason: string;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    category: "credentials",
    patterns: [
      /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/i,
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/i,
      /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/i,
      /\bAKIA[0-9A-Z]{16}\b/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
      /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|password|passwd|passphrase|private[_ -]?key|secret)\b\s*[:=]\s*["']?[^"',\s;]{6,}/i,
    ],
    reason: "message appears to contain a credential/token",
  },
  {
    category: "mass_mention",
    patterns: [/(^|[^\w])@(everyone|here)\b/i],
    reason: "mass mention attempt routed through the bot",
  },
  {
    category: "doxxing_request",
    patterns: [
      /\b(?:doxx?|d0x)\b/i,
      /\b(?:find|get|give|tell|lookup|track)\b[\s\S]{0,50}\b(?:his|her|their|someone'?s|that user'?s)\b[\s\S]{0,50}\b(?:home address|address|ip address|phone number|location)\b/i,
      /\b(?:find|get|give|tell|lookup|track)\b[\s\S]{0,50}\b(?:home address|address|ip address|phone number|location)\b[\s\S]{0,50}\b(?:for|of)\b[\s\S]{0,30}\b(?:him|her|them|that user|someone)\b/i,
    ],
    reason: "doxxing-related request",
  },
  {
    category: "secret_exfiltration",
    patterns: [
      /\b(?:print|show|reveal|dump|send|give|paste|list|exfiltrate)\b[\s\S]{0,80}\b(?:stored|saved|remembered|your|my|their|any|all|env(?:ironment)?|database|system)\b[\s\S]{0,80}\b(?:tokens?|passwords?|api\s*keys?|secrets?|credentials?|private\s*keys?)\b/i,
      /\b(?:tokens?|passwords?|api\s*keys?|secrets?|credentials?|private\s*keys?)\b[\s\S]{0,80}\b(?:stored|saved|remembered|env(?:ironment)?|database|system)\b[\s\S]{0,80}\b(?:print|show|reveal|dump|send|give|paste|list|exfiltrate)\b/i,
    ],
    reason: "request to reveal stored or environmental secrets",
  },
  {
    category: "credential_theft",
    patterns: [
      /\b(?:phishing|credential harvesting|credential theft)\b/i,
      /\b(?:steal|grab|harvest|capture|exfiltrate)\b[\s\S]{0,80}\b(?:login|password|credentials?|session cookies?|2fa|mfa|account)\b/i,
      /\bfake\b[\s\S]{0,40}\b(?:login|sign-in|signin)\b[\s\S]{0,80}\b(?:steal|grab|harvest|capture|collect)\b/i,
    ],
    reason: "credential-theft request",
  },
  {
    category: "tool_gate_bypass",
    patterns: [
      /\bsystem override\b[\s\S]{0,80}\b(?:confirmation|permission|safety|tool)\b/i,
      /\b(?:bypass|disable|skip|ignore)\b[\s\S]{0,40}\b(?:confirmation|permissions?|safety|tool gates?|risk gates?)\b/i,
      /\b(?:confirmation|permissions?|safety|tool gates?|risk gates?)\b[\s\S]{0,40}\b(?:bypass|disabled?|skipped?|ignored?)\b/i,
    ],
    reason: "attempt to bypass tool safety gates",
  },
];

export class ModerationRules {
  screen(content: string): ModerationVerdict {
    const categories = new Set<string>();
    const matches: Array<{ category: string; reason: string }> = [];
    let reason: string | undefined;

    for (const rule of RULES) {
      if (rule.patterns.some((pattern) => pattern.test(content))) {
        categories.add(rule.category);
        matches.push({ category: rule.category, reason: rule.reason });
        reason = reason ?? rule.reason;
      }
    }

    const categoryList = [...categories];
    return {
      flagged: categoryList.length > 0,
      categories: categoryList,
      ...(reason ? { reason } : {}),
      ...(matches.length > 0 ? { matches } : {}),
    };
  }
}
