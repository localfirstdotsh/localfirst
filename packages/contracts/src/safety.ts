/**
 * Content safety scanners applied before publication (BACKEND_PRD sections
 * 4.3, 14.4, 17.1). These reduce obvious risk; they do not certify that any
 * referenced project code is safe.
 */

export interface SafetyFinding {
  code: string;
  message: string;
  /** Location hint such as `markdown:12` or a JSON pointer. */
  location: string;
}

interface SecretRule {
  code: string;
  message: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  {
    code: 'SECRET_PRIVATE_KEY',
    message: 'A private key block is present',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
  },
  {
    code: 'SECRET_AWS_ACCESS_KEY',
    message: 'An AWS access key identifier is present',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    code: 'SECRET_GITHUB_TOKEN',
    message: 'A GitHub token is present',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    code: 'SECRET_SLACK_TOKEN',
    message: 'A Slack token is present',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    code: 'SECRET_PROVIDER_API_KEY',
    message: 'A provider API key is present',
    pattern: /\b(?:sk|rk)-(?:proj-|ant-|live-)?[A-Za-z0-9_-]{24,}\b/,
  },
  {
    code: 'SECRET_GOOGLE_API_KEY',
    message: 'A Google API key is present',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    code: 'SECRET_JWT',
    message: 'A signed token is present',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  {
    code: 'SECRET_URL_CREDENTIALS',
    message: 'A URL embeds credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i,
  },
  {
    code: 'SECRET_ASSIGNED_CREDENTIAL',
    message: 'A credential assignment is present',
    pattern:
      /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|bearer|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9/_+=-]{16,}["']?/i,
  },
];

/** Scan untrusted text for credential-looking content. */
export function scanSecrets(text: string, locationPrefix: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          code: rule.code,
          message: rule.message,
          location: `${locationPrefix}:${index + 1}`,
        });
      }
    }
  });
  return findings;
}

const UNSAFE_MARKDOWN_RULES: SecretRule[] = [
  {
    code: 'MARKDOWN_SCRIPT_TAG',
    message: 'Raw script, iframe, object, embed, or form markup is not allowed',
    pattern: /<\s*\/?\s*(?:script|iframe|object|embed|form|base|link|meta|style)\b/i,
  },
  {
    code: 'MARKDOWN_EVENT_HANDLER',
    message: 'Inline event handler attributes are not allowed',
    pattern: /<[^>]+\son[a-z]+\s*=/i,
  },
  {
    code: 'MARKDOWN_SCRIPT_URL',
    message: 'javascript:, vbscript:, or file: URLs are not allowed',
    pattern: /\b(?:javascript|vbscript|file)\s*:/i,
  },
  {
    code: 'MARKDOWN_DATA_URL',
    message: 'data: URLs are not allowed in documentation',
    pattern: /\bdata:(?!image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]{0,200}$)/i,
  },
  {
    code: 'MARKDOWN_PRIVATE_ENDPOINT',
    message: 'Links to localhost or private network addresses are not publishable content',
    pattern:
      /\bhttps?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)/i,
  },
];

export function scanUnsafeMarkdown(markdown: string, locationPrefix = 'markdown'): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  markdown.split('\n').forEach((line, index) => {
    for (const rule of UNSAFE_MARKDOWN_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          code: rule.code,
          message: rule.message,
          location: `${locationPrefix}:${index + 1}`,
        });
      }
    }
  });
  return findings;
}

/** Reject text that is not plausibly reviewable documentation. */
export function scanContentShape(text: string, locationPrefix = 'markdown'): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  if (/\u0000/.test(text)) {
    findings.push({
      code: 'CONTENT_NULL_BYTE',
      message: 'Text contains NUL bytes',
      location: locationPrefix,
    });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    findings.push({
      code: 'CONTENT_CONTROL_CHARACTERS',
      message: 'Text contains disallowed control characters',
      location: locationPrefix,
    });
  }
  if (/[‪-‮⁦-⁩]/.test(text)) {
    findings.push({
      code: 'CONTENT_BIDI_OVERRIDE',
      message: 'Text contains bidirectional override characters',
      location: locationPrefix,
    });
  }
  return findings;
}
