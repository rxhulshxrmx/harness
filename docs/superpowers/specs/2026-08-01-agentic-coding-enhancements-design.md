# Harness Agentic-Coding Enhancements — Design

**Goal:** Harden and extend "harness" (the VS Code coding-agent extension in this repo) by porting concrete, proven features from four reference projects, adapted to harness's small TypeScript/Node codebase.

**Sources surveyed** (cloned to scratchpad, not part of this repo):
- `yc-software/qm` — multi-tenant AI-agent hosting platform (command policy, secret masking, memory consolidation, turn/interruption handling).
- `cline/cline` — mature VS Code coding-agent extension (checkpoints, `.clineignore`, stale-file tracking, @-mentions, typed error/retry, focus-chain todo).
- `openai/codex` — OpenAI's production Codex CLI, Rust (`execpolicy` rule-based command classification, `apply-patch` hunk format, secret sanitizer regexes, rollout persistence).
- `xai-org/grok-build` — xAI's Grok Build terminal agent, Rust (per-turn rewind checkpoints, Plan Mode, hooks system).

Each phase below is independently shippable. Phase 1 is fully specified and ready to implement now; Phases 2–4 are specified at design-intent level and should be re-verified against the current code before implementation (file line numbers will have shifted).

---

## Phase 1 — Safety & reliability foundation

No webview redesign; touches `tools/`, `state/`, `agent/loop.ts`, and `ui/panel.ts` only additively. Everything here is backward-compatible: existing behavior is a fallback path, never removed.

### 1. Command policy engine (`src/tools/commandPolicy.ts`, new)

Replaces the ad hoc lists in `tools/bash.ts` (`READ_ONLY_EXACT`, `READ_ONLY_PREFIX_WORDS`, `AUTO_APPROVE_PREFIXES`, `NEVER_AUTO_WORDS`) with a rule table, borrowing codex's `execpolicy` shape:

```ts
type Decision = "allow" | "confirm";
interface CommandRule {
  program: string;                 // first token, e.g. "git", "rm", "npm"
  args?: (string | { anyOf: string[] })[]; // ordered prefix match against remaining tokens; "*" = wildcard single token
  decision: Decision;
  severity?: "caution" | "dangerous"; // only meaningful for "confirm"
  reason: string;                  // shown in the approval UI
}
function classifyCommand(command: string): { decision: Decision; reason: string; severity?: "caution"|"dangerous" }
```

- Rules live in a `Map<string, CommandRule[]>` keyed by `program`, checked in order; first match wins.
- Default table distinguishes cases the current flat lists can't, e.g. `git push` (confirm/caution) vs `git push --force` (confirm/dangerous) vs `git status` (allow).
- **No rule matches → fall through to today's heuristics**, moved into this module unchanged as the fallback tier (`isAutoApproved`/`isNeverAutoApproved`/`hasShellMetacharacters`, still exported and unit-tested as today).
- `bash.ts` calls `classifyCommand()` in place of its current inline checks; `approvalMode: "auto"` auto-runs on `decision === "allow"`, everything else prompts.

### 2. Secret redaction (`src/security/redactSecrets.ts`, new)

Four regexes ported from codex's `secrets/src/sanitizer.rs`, applied in sequence, each replacing the secret value (not the key name) with `[REDACTED]`:
- OpenAI-style keys: `sk-[A-Za-z0-9]{20,}`
- AWS access key IDs: `AKIA[0-9A-Z]{16}`
- Bearer tokens: `Bearer\s+[A-Za-z0-9\-._~+/]+=*`
- Generic assignment: `(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?\S{8,}` → redact captured value, keep key name

**Single hook point:** `tools/index.ts`'s `runTool()`, applied to the result string immediately before `truncate()`. Covers bash stdout/stderr, file reads, grep matches uniformly — every tool result is written to `.harness/sessions/*.jsonl` via `appendToStore` and shown in the webview, so this is the one choke point that matters.

### 3. `.harnessignore` support

`listDir.ts` and `grep.ts` each currently build their own throwaway `ignore()` instance from `.gitignore` only; `readFile.ts` and `searchReplace.ts` don't check ignore rules at all. Consolidate:

- New `loadWorkspaceIgnore(root: string)` in `tools/index.ts`, reading `.gitignore` then `.harnessignore` (both optional, both added to the same `ignore()` instance).
- `listDir.ts` and `grep.ts` switch to calling this shared helper (removes the duplication).
- `readFile.ts` and `searchReplace.ts` gain an ignore check: if the resolved relative path is ignored, return `Error: path is excluded by .gitignore/.harnessignore (file_path)` instead of reading/writing.

### 4. Stale-file tracking (`src/state/fileTracker.ts`, new)

```ts
function recordRead(absPath: string): void   // call after a successful readFile
function isStale(absPath: string): boolean   // true if mtime changed since last recordRead, or never read
```

- `readFile.ts` calls `recordRead(abs)` after every successful read.
- `searchReplace.ts` calls `isStale(abs)` before applying an edit to an *existing* file (skip the check for file creation, where `old_string === ""`). If stale, return `Error: file changed on disk since it was last read — re-read it before editing (file_path)` without applying the edit.
- Rationale: `search_replace` already re-reads the file fresh at execute time, so an exact-string mismatch is already caught — but if the *rest* of the file changed since the model last saw it (via `read_file`), the string match can still succeed while the model is silently editing against a stale mental model of surrounding context. This catches that case explicitly.

### 5. Interrupted-tool-call marker + resume-safety fix (`src/agent/loop.ts`)

Current bug: in the tool-call loop —
```ts
for (const call of assistant.tool_calls) {
  if (signal.aborted) return;   // <-- leaves later tool_calls with no matching tool-result message
  ...
}
```
— aborting mid-loop (user hits Stop) leaves the last assistant message's `tool_calls` array with some calls that never got a corresponding `role: "tool"` result message. Most chat-completions-style APIs reject a request whose message history has that shape, so resuming the session after a mid-loop Stop is likely already broken.

Fix: on abort (or an uncaught exception) partway through the `tool_calls` loop, push a placeholder result for every call that didn't get to run or didn't finish:
```ts
{ role: "tool", tool_call_id: call.id, content: "[INTERRUPTED] This tool call did not complete (turn was stopped or crashed). Do not assume it succeeded or failed — verify current state before retrying." }
```
before returning/rethrowing. This keeps the message array valid for the next turn and gives the model an explicit, honest signal instead of a silent gap.

### 6. Structured approval context (`agent/loop.ts`, `tools/bash.ts`, `ui/panel.ts`, webview)

`UiPort.requestApproval` changes shape:
```ts
// before
requestApproval: (command: string) => Promise<boolean>;
// after
requestApproval: (ctx: { command: string; reason: string; severity?: "caution" | "dangerous" }) => Promise<boolean>;
```
`bash.ts` passes the `reason`/`severity` from `classifyCommand()` (or a generic reason when falling back to heuristics). `panel.ts`'s `PendingApproval` and `postState()` carry the extra fields through unchanged in shape otherwise. Webview (`main.js`) renders the reason and a severity-colored badge when present, plain command text when not (fully backward compatible rendering — this is the only Phase 1 change that touches the webview, and it's additive text/styling only).

### Testing (Phase 1)
Each new/changed module gets a matching `*.test.ts`, following the existing convention (`bash.test.ts`, `readFile.test.ts`, etc.):
- `commandPolicy.test.ts` — rule-table precedence, fallback-to-heuristics behavior, severity assignment.
- `redactSecrets.test.ts` — one case per regex, plus a "no false positives on normal code" case.
- ignore-precedence cases added to `listDir.test.ts`/new `grep.test.ts` coverage, plus new checks in `readFile.test.ts`/`searchReplace.test.ts`.
- `fileTracker.test.ts` — stale/non-stale/never-read cases.
- `loop.test.ts` (new, currently no test exists for `loop.ts`) — abort-mid-tool-loop produces valid, resumable message history.

---

## Phase 2 — Agent loop robustness

*(Design-intent level; re-verify file specifics before implementing — the codebase will have moved on from Phase 1.)*

1. **Typed provider-error classification + retry** (from cline's `services/error/ClineError.ts`) — classify errors from `aicore/client.ts` into `rate_limit | auth | context_too_long | network | unknown`, each with an appropriate retry/backoff or user-facing message, instead of the current `showError(String(err))`.
2. **Richer context consolidation** (from qm's `memory/strategies/consolidation.ts`) — upgrade `agent/compaction.ts` from truncation to an LLM-driven summarize/merge/prune pass over older messages, keeping recent turns verbatim.
3. **Apply-patch-style multi-file hunk format** (from codex's `apply-patch/src/parser.rs`) — optionally extend/replace `tools/searchReplace.ts` with a context-anchored hunk format (`*** Update File: path` / `@@ context` / `+`/`-` lines) supporting multi-file edits and file add/delete in one tool call, parsed and validated fully before any filesystem write. Bigger lift than #1/#2; evaluate after they ship whether it's still worth it or whether `search_replace` is sufficient.

---

## Phase 3 — Webview UX

*(Design-intent level.)*

1. **Checkpoints/rewind** (from grok-build's `xai-grok-workspace` checkpoint mechanism) — extend `state/diffTracker.ts`'s existing turn-scoped tracking to persist a before/after snapshot of every file touched each turn to `.harness/checkpoints/<session-id>/checkpoint-<n>.json` (capped ring buffer, gitignored). Add `rewindTo(turnIndex)`: restores those files' contents and truncates `session.messages`/the JSONL store back to that point. Webview gets a rewind affordance per past turn.
2. **@-mentions** (from cline's `core/mentions/index.ts`) — `@file`, `@problems`, `@terminal` in the chat input auto-inject context (file contents, current diagnostics, last terminal output) into the outgoing user message before it's sent.
3. **Focus-chain todo file** (from cline's `core/task/focus-chain/`) — a per-session markdown checklist file the agent maintains across turns and the user can edit directly; surfaced in the webview alongside the chat.

---

## Phase 4 — Larger bets

*(Directional only — each of these is its own spec-and-plan cycle, not a drop-in port.)*

1. **Plan Mode** (from grok-build's `docs/user-guide/19-plan-mode.md`) — a mode where tool writes are hard-blocked except to a session-local `plan.md`; entered/exited explicitly (by agent or user), with an approve/request-changes UI on exit. Maps to a new `harness.approvalMode: "plan"` value.
2. **Lightweight hooks system** (from grok-build's `docs/user-guide/10-hooks.md`) — `PreToolUse`/`PostToolUse` events, JSON over stdin, `{"decision":"allow"|"deny"}` on stdout, fail-open on error/timeout. Would let users layer custom safety checks on top of (not instead of) the Phase 1 command-policy engine.
3. **MCP server support** (cline) — connect to external Model Context Protocol servers for additional tools.
4. **Multi-provider model routing** (qm's `harness-router.ts` pattern) — swap/fall back between model backends beyond the current single SAP AI Core endpoint.
5. **Skills system** (qm's frontmatter-based skill packages, grok-build's skills docs) — project-local, shareable skill files, building on the existing `agent/agentsMd.ts` AGENTS.md/CLAUDE.md support.

---

## Non-goals (explicitly out of scope, all phases)

- OS-level sandboxing (seatbelt/landlock/bubblewrap) — no equivalent inside a VS Code extension's Node process without a native helper binary; noted in research as a stretch item, not planned.
- Any change to the "no third-party agent frameworks, `ignore` is the only prod dependency" constraint from the original build spec (`docs/superpowers/plans/2026-07-29-harness-vscode-agent.md`) — all new code is hand-written, same as existing tools.
- Multi-tenant/hosting concerns from `qm` (Fly/AWS/Terraform, Slack SSO, billing, plugin marketplace) — harness is a single-user local extension, not a hosting platform.
