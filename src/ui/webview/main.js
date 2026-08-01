const vscode = acquireVsCodeApi();
const el = (id) => document.getElementById(id);

let state = {
  session: { messages: [] },
  streamingText: "",
  pendingApproval: null,
  touchedFiles: [],
  sessionList: [],
  approvalMode: "ask",
  model: "GPT-5",
  streaming: false,
  config: { clientId: "", aiCoreBaseUrl: "", tokenUrl: "", resourceGroup: "", deploymentId: "", hasClientSecret: false },
};
let historyOpen = false;
let settingsOpen = false;
let settingsPopulated = false;
let modelPickerOpen = false;

const DIFF_LANGS = new Set(["diff", "patch"]);

// Models label a diff block inconsistently — ```diff, ```patch, or a bare
// ``` — so fall back to sniffing the content when the fence carries no
// language, rather than silently rendering a diff as flat grey text.
function looksLikeDiff(lines) {
  if (lines.some((l) => /^(@@|\+\+\+ |--- )/.test(l))) return true;
  const marked = lines.filter((l) => /^[+-]/.test(l)).length;
  return marked >= 2 && marked >= lines.length * 0.3;
}

function diffLineClass(line) {
  // File headers before +/- so "--- a/file.ts" is not read as a deletion.
  if (/^(\+\+\+|---)(\s|$)/.test(line)) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

// Syntax highlighting, hand-rolled. A real grammar engine (shiki, highlight.js)
// would be megabytes of dependency for a sidebar that shows short snippets, so
// this is a single-pass lexer: comments, strings, numbers, keywords and call
// sites. It is deliberately approximate — the goal is that code stops reading
// as one flat grey wall, not that it matches the editor token-for-token.
const KW_JS =
  "abstract as async await break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while yield";
const KW_PY =
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield";
const KW_SH =
  "case do done elif else esac exit export fi for function if in local read readonly return set then until unset while";
const KW_C =
  "auto bool break case catch chan char class const constexpr continue default defer delete do double else enum extern false final float fn for func go goto if impl implements import in int interface let long map match mod move mut namespace new nil nullptr package private protected pub public range return self short signed sizeof static struct super switch template this throw trait true try type typedef typename union unsigned use using var virtual void volatile where while";
const KW_SQL =
  "all alter and as asc between by case create cross delete desc distinct drop else end exists from full group having in inner insert into is join left like limit not null offset on or order outer right select set table then union update values when where with";

function highlightMode(lang) {
  switch (lang) {
    case "js": case "jsx": case "mjs": case "cjs": case "javascript":
    case "ts": case "tsx": case "typescript":
    case "json": case "jsonc": case "json5":
      return { key: "js", kw: KW_JS, line: "//", block: true, template: true };
    case "py": case "python":
      return { key: "py", kw: KW_PY, line: "#", block: false };
    case "sh": case "bash": case "zsh": case "shell": case "console": case "shellscript":
      return { key: "sh", kw: KW_SH, line: "#", block: false };
    case "css": case "scss": case "less":
      return { key: "css", kw: "important from to", line: "//", block: true };
    case "sql":
      return { key: "sql", kw: KW_SQL, line: "--", block: true, ci: true };
    case "yaml": case "yml": case "toml": case "ini": case "env": case "dotenv":
      return { key: "data", kw: "false null true yes no on off", line: "#", block: false };
    case "c": case "h": case "cc": case "cpp": case "hpp": case "cs": case "java":
    case "kt": case "kotlin": case "swift": case "go": case "rs": case "rust":
    case "php": case "rb": case "ruby": case "dart": case "scala":
      return { key: "c", kw: KW_C, line: "//", block: true };
    default:
      // Unlabelled fences are the common case mid-stream. Accept both comment
      // styles and the union of keywords rather than giving up and rendering
      // flat text — over-colouring a word is a smaller cost than no colour.
      return { key: "generic", kw: `${KW_JS} ${KW_PY} ${KW_C}`, line: "//|#", block: true, template: true };
  }
}

const scannerCache = new Map();

function scannerFor(mode) {
  const cached = scannerCache.get(mode.key);
  if (cached) return cached;
  const parts = [];
  // Order matters: whatever opens first wins, so comments and strings must be
  // tried before keywords, or a keyword inside a string would be coloured.
  if (mode.block) parts.push("(?<comment>/\\*[\\s\\S]*?\\*/)");
  parts.push(`(?<linecomment>(?:${mode.line})[^\\n]*)`);
  const tick = mode.template ? "|`(?:[^`\\\\]|\\\\[\\s\\S])*`" : "";
  parts.push(`(?<string>"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'${tick})`);
  parts.push("(?<number>\\b\\d[\\w.]*)");
  parts.push(`(?<keyword>\\b(?:${mode.kw.trim().split(/\s+/).join("|")})\\b)`);
  parts.push("(?<fn>\\b[A-Za-z_$][\\w$]*(?=\\s*\\())");
  const re = new RegExp(parts.join("|"), mode.ci ? "gi" : "g");
  scannerCache.set(mode.key, re);
  return re;
}

function highlightInto(codeEl, text, lang) {
  const re = scannerFor(highlightMode(lang));
  re.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    // A zero-length match would spin forever; step past it.
    if (match[0].length === 0) { re.lastIndex++; continue; }
    if (match.index > last) codeEl.appendChild(document.createTextNode(text.slice(last, match.index)));
    const kind = Object.keys(match.groups).find((k) => match.groups[k] !== undefined);
    const span = document.createElement("span");
    span.className = `tok-${kind}`;
    span.textContent = match[0];
    codeEl.appendChild(span);
    last = match.index + match[0].length;
  }
  if (last < text.length) codeEl.appendChild(document.createTextNode(text.slice(last)));
}

function appendCodeBlock(container, bufLines, lang) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");

  if (DIFF_LANGS.has(lang) || (!lang && looksLikeDiff(bufLines))) {
    pre.className = "diff";
    for (const line of bufLines) {
      const span = document.createElement("span");
      span.className = `diff-line ${diffLineClass(line)}`;
      // A blank line still needs to occupy a row, or the diff loses its shape.
      span.textContent = line === "" ? " " : line;
      code.appendChild(span);
    }
  } else {
    pre.className = "code";
    highlightInto(code, bufLines.join("\n"), lang);
  }

  pre.appendChild(code);
  container.appendChild(pre);
}

function renderMarkdown(text) {
  const container = document.createElement("div");
  const lines = text.split("\n");
  let inCode = false;
  let codeBuf = [];
  let codeLang = "";
  let listBuf = null;

  function flushList() {
    if (listBuf) { container.appendChild(listBuf); listBuf = null; }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        appendCodeBlock(container, codeBuf, codeLang);
        codeBuf = [];
        codeLang = "";
        inCode = false;
      } else {
        flushList();
        codeLang = line.slice(3).trim().toLowerCase();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (/^#{1,6}\s/.test(line)) {
      flushList();
      const level = line.match(/^#+/)[0].length;
      const h = document.createElement(`h${Math.min(level, 6)}`);
      h.textContent = line.replace(/^#{1,6}\s/, "");
      container.appendChild(h);
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      if (!listBuf) listBuf = document.createElement("ul");
      const li = document.createElement("li");
      appendInline(li, line.replace(/^[-*]\s/, ""));
      listBuf.appendChild(li);
      continue;
    }
    flushList();
    if (line.trim() === "") continue;
    const p = document.createElement("p");
    appendInline(p, line);
    container.appendChild(p);
  }
  flushList();
  // A fence that never closed — the normal state mid-stream, before the
  // closing ``` arrives. Render what we have, or the block stays blank until
  // the model finishes writing it.
  if (inCode && codeBuf.length) appendCodeBlock(container, codeBuf, codeLang);
  return container;
}

// A workspace-relative path, optionally with :line or :line:col. Restricted to
// known code extensions so that prose like `node.js` or `v0.0.13` stays plain
// text; absolute paths and URLs are excluded because the extension side would
// refuse them anyway.
const FILE_REF_RE =
  /^(?!\/)([\w.@~-]+(?:\/[\w.@~-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|css|scss|less|html|htm|xml|yml|yaml|toml|ini|md|sql|vue|svelte|txt|lock|gradle))(?::(\d+))?(?::\d+)?$/i;

// Library names shaped exactly like a bare .js file. Only a problem when the
// reference has no directory part, since nobody writes `src/node.js` meaning
// the runtime.
const NOT_A_FILE = new Set([
  "node.js", "next.js", "nest.js", "nuxt.js", "vue.js", "react.js", "express.js",
  "three.js", "d3.js", "chart.js", "ember.js", "backbone.js", "socket.io",
]);

function fileRef(text) {
  const match = FILE_REF_RE.exec(text.trim());
  if (!match) return null;
  const file = match[1];
  if (!file.includes("/") && NOT_A_FILE.has(file.toLowerCase())) return null;
  return { file, line: match[2] ? Number(match[2]) : undefined };
}

function appendInline(parent, text) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`")) {
      const inner = part.slice(1, -1);
      const code = document.createElement("code");
      code.textContent = inner;
      const ref = fileRef(inner);
      if (ref) {
        code.className = "file-ref";
        code.title = `Open ${ref.file}${ref.line ? `:${ref.line}` : ""}`;
        code.addEventListener("click", () => vscode.postMessage({ type: "openFile", ...ref }));
      }
      parent.appendChild(code);
    } else if (part.startsWith("**") && part.endsWith("**")) {
      const b = document.createElement("b");
      b.textContent = part.slice(2, -2);
      parent.appendChild(b);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  }
}

function renderMessages() {
  const messagesEl = el("messages");
  messagesEl.innerHTML = "";

  let turnIndex = 0;
  for (const msg of state.session.messages) {
    if (msg.role === "user") {
      const currentTurn = turnIndex++;
      const div = document.createElement("div");
      div.className = "msg user";
      const rewindBtn = document.createElement("button");
      rewindBtn.className = "rewind-btn";
      rewindBtn.textContent = "⟲";
      rewindBtn.title = "Rewind to before this turn";
      rewindBtn.addEventListener("click", () => vscode.postMessage({ type: "rewindToTurn", turnIndex: currentTurn }));
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = msg.content;
      // Block first, rewind after it: the block now starts at the left edge, so
      // a leading button would push it out of alignment with everything else.
      div.appendChild(bubble);
      div.appendChild(rewindBtn);
      messagesEl.appendChild(div);
    } else if (msg.role === "assistant") {
      if (msg.content) {
        const div = document.createElement("div");
        div.className = "msg assistant";
        div.appendChild(renderMarkdown(msg.content));
        messagesEl.appendChild(div);
      }
      for (const call of msg.tool_calls ?? []) {
        const div = document.createElement("div");
        div.className = "tool-call";
        div.textContent = `${call.function.name} ${call.function.arguments}`;
        const body = document.createElement("div");
        body.className = "body";
        body.textContent = call.function.arguments;
        div.appendChild(body);
        div.addEventListener("click", () => div.classList.toggle("expanded"));
        messagesEl.appendChild(div);
      }
    } else if (msg.role === "tool") {
      const div = document.createElement("div");
      div.className = "tool-call";
      const preview = (msg.content || "").split("\n")[0].slice(0, 80);
      div.textContent = preview;
      const body = document.createElement("div");
      body.className = "body";
      body.textContent = msg.content;
      div.appendChild(body);
      div.addEventListener("click", () => div.classList.toggle("expanded"));
      messagesEl.appendChild(div);
    }
  }

  if (state.streamingText) {
    const div = document.createElement("div");
    div.className = "msg assistant";
    div.id = "streamingMsg";
    div.appendChild(renderMarkdown(state.streamingText));
    messagesEl.appendChild(div);
  }

  if (state.pendingApproval) {
    const div = document.createElement("div");
    div.className = "approval";
    if (state.pendingApproval.severity) div.classList.add(`severity-${state.pendingApproval.severity}`);

    const command = document.createElement("div");
    command.className = "command";
    command.textContent = state.pendingApproval.command;
    div.appendChild(command);

    if (state.pendingApproval.reason) {
      const reason = document.createElement("div");
      reason.className = "reason";
      if (state.pendingApproval.severity) {
        const badge = document.createElement("span");
        badge.className = `severity-badge ${state.pendingApproval.severity}`;
        badge.textContent = state.pendingApproval.severity === "dangerous" ? "⚠ dangerous" : "⚠ caution";
        reason.appendChild(badge);
      }
      reason.appendChild(document.createTextNode(state.pendingApproval.reason));
      div.appendChild(reason);
    }

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const approveBtn = document.createElement("button");
    approveBtn.className = "approve";
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => vscode.postMessage({ type: "approve", id: state.pendingApproval.id }));
    const denyBtn = document.createElement("button");
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => vscode.postMessage({ type: "deny", id: state.pendingApproval.id }));
    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    div.appendChild(actions);
    messagesEl.appendChild(div);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderTouchedFiles() {
  const touchedEl = el("touchedFiles");
  touchedEl.innerHTML = "";
  touchedEl.classList.toggle("visible", state.touchedFiles.length > 0);
  for (const file of state.touchedFiles) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = file;
    name.title = file;
    name.addEventListener("click", () => vscode.postMessage({ type: "openDiff", file }));
    const revertBtn = document.createElement("button");
    revertBtn.className = "revert-btn";
    revertBtn.title = "Revert";
    revertBtn.textContent = "↺";
    revertBtn.addEventListener("click", () => vscode.postMessage({ type: "revertFile", file }));
    chip.appendChild(name);
    chip.appendChild(revertBtn);
    touchedEl.appendChild(chip);
  }
}

function renderHistoryPanel() {
  const panel = el("historyPanel");
  panel.innerHTML = "";
  panel.classList.toggle("open", historyOpen);
  if (!historyOpen) return;

  if (state.sessionList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No sessions yet.";
    panel.appendChild(empty);
    return;
  }

  for (const s of state.sessionList) {
    const row = document.createElement("div");
    row.className = "history-row";
    if (s.id === state.session.id) row.classList.add("active");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = s.title || "(untitled)";
    row.appendChild(title);
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.title = "Delete session";
    deleteBtn.textContent = "✕";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: "deleteSession", id: s.id });
    });
    row.appendChild(deleteBtn);
    row.addEventListener("click", () => {
      historyOpen = false;
      vscode.postMessage({ type: "selectSession", id: s.id });
    });
    panel.appendChild(row);
  }
}

function renderSettingsPanel() {
  const panel = el("settingsPanel");
  panel.classList.toggle("open", settingsOpen);
  el("messages").style.display = settingsOpen ? "none" : "";
  el("touchedFiles").style.display = settingsOpen ? "none" : "";
  el("composerWrap").style.display = settingsOpen ? "none" : "";

  el("clientSecretHint").style.display = state.config?.hasClientSecret ? "" : "none";

  const test = state.connectionTest ?? { state: "idle" };
  const statusEl = el("connectionStatus");
  statusEl.className = `settings-status ${test.state}`;
  statusEl.textContent =
    test.state === "testing" ? "Testing…" : test.state === "idle" ? "" : test.message || "";
  el("testConnectionBtn").disabled = test.state === "testing";

  if (settingsOpen && !settingsPopulated) {
    el("clientIdInput").value = state.config?.clientId || "";
    el("clientSecretInput").value = "";
    el("aiCoreBaseUrlInput").value = state.config?.aiCoreBaseUrl || "";
    el("tokenUrlInput").value = state.config?.tokenUrl || "";
    el("resourceGroupInput").value = state.config?.resourceGroup || "";
    el("deploymentIdInput").value = state.config?.deploymentId || "";
    settingsPopulated = true;
  }
  if (!settingsOpen) settingsPopulated = false;
}

function renderModelPicker() {
  const picker = el("modelPicker");
  picker.innerHTML = "";
  picker.classList.toggle("open", modelPickerOpen);
  if (!modelPickerOpen) return;

  const models = state.models ?? { state: "idle", list: [] };

  const message = (text, withSettingsLink) => {
    const div = document.createElement("div");
    div.className = "model-message";
    div.appendChild(document.createTextNode(text));
    if (withSettingsLink) {
      div.appendChild(document.createElement("br"));
      const link = document.createElement("a");
      link.textContent = "Open settings";
      link.addEventListener("click", () => {
        modelPickerOpen = false;
        settingsOpen = true;
        renderModelPicker();
        renderSettingsPanel();
      });
      div.appendChild(link);
    }
    picker.appendChild(div);
  };

  if (models.state === "loading") return message("Loading models…");
  if (models.state === "error") return message(models.message || "Could not load models.", true);
  if (!models.list.length) {
    return message(models.message || "No models loaded yet. Add your credentials, then test the connection.", true);
  }

  for (const model of models.list) {
    const row = document.createElement("div");
    row.className = "model-row";
    if (model.id === state.config?.deploymentId) row.classList.add("active");

    const check = document.createElement("span");
    check.className = "check";
    check.textContent = "✓";
    row.appendChild(check);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = model.label;
    label.title = `${model.label} — deployment ${model.id}`;
    row.appendChild(label);

    row.addEventListener("click", () => {
      modelPickerOpen = false;
      renderModelPicker();
      vscode.postMessage({ type: "selectModel", deploymentId: model.id });
    });
    picker.appendChild(row);
  }
}

function render() {
  el("sessionTitle").textContent = state.session.title || "New session";
  renderMessages();
  renderTouchedFiles();
  renderHistoryPanel();
  renderSettingsPanel();
  renderModelPicker();

  const modeBtn = el("approvalModeBtn");
  modeBtn.textContent = state.approvalMode === "auto" ? "Auto" : "Ask";
  el("modelName").textContent = state.model || "GPT-5";

  const sendBtn = el("sendBtn");
  sendBtn.classList.toggle("stopping", state.streaming);
  sendBtn.title = state.streaming ? "Stop" : "Send";
  sendBtn.innerHTML = state.streaming
    ? '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5V3.5M3.5 8 8 3.5 12.5 8"/></svg>';
}

const INPUT_MIN_HEIGHT = 68;
const INPUT_MAX_HEIGHT = 260;

// Grow the composer upward with the message so a long prompt stays readable,
// falling back to scrolling only past INPUT_MAX_HEIGHT. Height must be reset
// to "auto" first, or scrollHeight can only ever report the current height
// and the box would never shrink back down.
function autoGrowInput() {
  const input = el("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT)}px`;
}

function send() {
  const input = el("input");
  if (state.streaming) {
    vscode.postMessage({ type: "stop" });
    return;
  }
  if (!input.value.trim()) return;
  vscode.postMessage({ type: "userSend", text: input.value });
  input.value = "";
  autoGrowInput();
}

el("sendBtn").addEventListener("click", send);
el("input").addEventListener("input", autoGrowInput);
el("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
function closeSettings() {
  settingsOpen = false;
  renderSettingsPanel();
}
function closeHistory() {
  historyOpen = false;
  renderHistoryPanel();
}
function closeModelPicker() {
  modelPickerOpen = false;
  renderModelPicker();
}

el("modelBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  closeHistory();
  modelPickerOpen = !modelPickerOpen;
  renderModelPicker();
  // Load on first open rather than up front, so a workspace with no
  // credentials never fires a doomed request on startup.
  const models = state.models ?? { state: "idle", list: [] };
  if (modelPickerOpen && models.state === "idle") {
    vscode.postMessage({ type: "refreshModels" });
  }
});

el("newSessionBtn").addEventListener("click", () => {
  closeSettings();
  closeHistory();
  closeModelPicker();
  vscode.postMessage({ type: "newSession" });
});
el("historyBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  closeSettings();
  closeModelPicker();
  historyOpen = !historyOpen;
  renderHistoryPanel();
});
document.addEventListener("click", (e) => {
  if (historyOpen && !el("historyPanel").contains(e.target) && e.target !== el("historyBtn")) {
    closeHistory();
  }
  if (modelPickerOpen && !el("modelPicker").contains(e.target) && !el("modelBtn").contains(e.target)) {
    closeModelPicker();
  }
});
el("approvalModeBtn").addEventListener("click", () => vscode.postMessage({ type: "toggleApprovalMode" }));

el("settingsBtn").addEventListener("click", () => {
  closeHistory();
  closeModelPicker();
  settingsOpen = !settingsOpen;
  renderSettingsPanel();
});
el("closeSettingsBtn").addEventListener("click", () => closeSettings());
function wireSettingField(inputId, key) {
  el(inputId).addEventListener("change", (e) =>
    vscode.postMessage({ type: "updateSetting", key, value: e.target.value.trim() }),
  );
}
wireSettingField("clientIdInput", "clientId");
wireSettingField("aiCoreBaseUrlInput", "aiCoreBaseUrl");
wireSettingField("tokenUrlInput", "tokenUrl");
wireSettingField("resourceGroupInput", "resourceGroup");
wireSettingField("deploymentIdInput", "deploymentId");

el("clientSecretInput").addEventListener("change", (e) => {
  const value = e.target.value.trim();
  if (value) vscode.postMessage({ type: "updateSecret", value });
});

el("testConnectionBtn").addEventListener("click", () => vscode.postMessage({ type: "testConnection" }));

el("openSettingsJsonLink").addEventListener("click", (e) => {
  e.preventDefault();
  vscode.postMessage({ type: "openSettingsJson" });
});

// Repaint only the in-progress reply. renderMessages() tears down and rebuilds
// every message in the conversation, re-parsing markdown and re-highlighting
// every code block, so driving it from the stream made cost grow with session
// length rather than with the reply being typed.
function renderStreaming() {
  const existing = el("streamingMsg");
  if (!existing) {
    // First delta of a turn: the node does not exist yet, so fall back to a
    // full render once to create it.
    renderMessages();
    return;
  }
  existing.replaceChildren(renderMarkdown(state.streamingText));
  const messagesEl = el("messages");
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

window.addEventListener("message", (event) => {
  if (event.data.type === "state") {
    state = event.data;
    render();
  } else if (event.data.type === "stream") {
    state.streamingText = event.data.text;
    renderStreaming();
  }
});

vscode.postMessage({ type: "ready" });
