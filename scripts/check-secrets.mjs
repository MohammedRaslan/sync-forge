#!/usr/bin/env node
/**
 * Stops credentials from reaching git. No dependencies.
 *
 *   node scripts/check-secrets.mjs           scan the staged changes (the pre-commit hook)
 *   node scripts/check-secrets.mjs --all     scan every tracked file (CI, or by hand)
 *
 * Exit code 1 when something looks like a credential. A line that is a deliberate, harmless example can be
 * marked with `secret-scan: allow` in a comment on the same line.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Files that must never be committed, whatever they contain. */
const BLOCKED_PATHS = [
  { rule: '.env file (use .env.example for the template)', test: (p) => /(^|\/)\.env(\..+)?$/.test(p) && !p.endsWith('.env.example') },
  { rule: 'Syncforge workspace (encrypted connections, secret.key, run records)', test: (p) => /^workspace\/(\.local\/|.*secret)/.test(p) },
  { rule: 'private key or certificate file', test: (p) => /\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/.test(p) },
  { rule: 'exported-script state file', test: (p) => p.endsWith('.state.json') },
  { rule: 'npm credentials file', test: (p) => /(^|\/)\.npmrc$/.test(p) },
];

/** Content that looks like a credential. */
const PATTERNS = [
  { rule: 'private key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { rule: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { rule: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/ },
  { rule: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'API key (OpenAI/Anthropic style)', re: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/ },
  { rule: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { rule: 'Azure storage/Cosmos account key', re: /AccountKey=[A-Za-z0-9+/=]{20,}/ },
  { rule: 'JSON Web Token', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: 'connection string with a password', re: /[a-z][a-z0-9+.-]*:\/\/[^/@\s:'"`]+:[^@\s/'"`]+@/i },
  { rule: 'long base64 secret', re: /[A-Za-z0-9+/]{60,}={1,2}/ },
  {
    rule: 'password or secret written in the code',
    re: /(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)['"]?\s*[:=]\s*['"`]([^'"`$\s{}]{6,})['"`]/i,
  },
];

/** Known harmless values: placeholders in docs, the public emulator key, throwaway demo/test containers. */
const ALLOWED = [
  /:\/\/user:pass(word)?@/, // documentation placeholder
  /C2y6yDjf5\/R\+ob0N8A7Cgv30VRDJIWEHLM\+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw\/Jw==/, // Cosmos emulator, published by Microsoft
  /secret-scan: allow/,
];

/** Demo passwords are fine only where demo and test databases live. */
const DEMO_PASSWORD = /^(postgres|mysql)$/;
const DEMO_LOCATIONS = /^(sandbox\/|docker-compose\.yml$|README\.md$|engine\/test\/|\.claude\/)/;

/** Generated or vendored files that are not worth scanning. */
const SKIPPED = /(^|\/)(package-lock\.json|node_modules\/|dist\/)|\.(png|jpe?g|gif|webp|woff2?|ico|pdf)$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function filesToScan(all) {
  const list = all ? git('ls-files') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR');
  return list.split('\n').filter(Boolean);
}

/** Staged content for the hook (what will really be committed), the working tree for --all. */
function contentOf(path, all) {
  try {
    return all ? readFileSync(path, 'utf8') : git('show', `:${path}`);
  } catch {
    return ''; // deleted or unreadable: nothing to commit
  }
}

/** The line as shown in the report, with the secret parts hidden so the output does not leak them. */
function mask(text) {
  return text
    .trim()
    .slice(0, 140)
    .replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/g, '$1***@')
    .replace(/((?:password|passwd|pwd|secret|key|token)['"]?\s*[:=]\s*['"`][^'"`]{2})[^'"`]+/gi, '$1…')
    .replace(/([A-Za-z0-9+/_-]{6})[A-Za-z0-9+/_=-]{8,}/g, '$1…');
}

function scan(all) {
  const findings = [];
  for (const path of filesToScan(all)) {
    const blocked = BLOCKED_PATHS.find((entry) => entry.test(path));
    if (blocked) {
      findings.push({ path, line: 0, rule: blocked.rule, text: '' });
      continue;
    }
    if (SKIPPED.test(path)) continue;
    const content = contentOf(path, all);
    if (content.includes('\0')) continue; // binary
    content.split('\n').forEach((text, index) => {
      if (ALLOWED.some((re) => re.test(text))) return;
      for (const { rule, re } of PATTERNS) {
        const match = re.exec(text);
        if (!match) continue;
        const value = match[2];
        const isDemo = value !== undefined && DEMO_LOCATIONS.test(path) && DEMO_PASSWORD.test(value);
        if (!isDemo) findings.push({ path, line: index + 1, rule, text: mask(text) });
        break;
      }
    });
  }
  return findings;
}

const all = process.argv.includes('--all');
const findings = scan(all);
if (findings.length === 0) {
  console.log(`secret scan: no credentials found (${all ? 'all tracked files' : 'staged changes'})`);
} else {
  console.error(`secret scan: ${findings.length} possible credential(s)${all ? '' : ', commit stopped'}:\n`);
  for (const f of findings) console.error(`  ${f.path}${f.line ? `:${f.line}` : ''}  [${f.rule}]${f.text ? `\n      ${f.text}` : ''}`);
  console.error(
    '\nMove real secrets to environment variables or the encrypted workspace. If a line is a harmless example,' +
      "\nadd a 'secret-scan: allow' comment to it. Bypassing with --no-verify still fails the CI check.",
  );
  process.exitCode = 1;
}
