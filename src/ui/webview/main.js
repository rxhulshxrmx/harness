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

function renderMarkdown(text) {
  const container = document.createElement("div");
  const lines = text.split("\n");
  let inCode = false;
  let codeBuf = [];
  let listBuf = null;

  function flushList() {
    if (listBuf) { container.appendChild(listBuf); listBuf = null; }
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeBuf.join("\n");
        pre.appendChild(code);
        container.appendChild(pre);
        codeBuf = [];
        inCode = false;
      } else {
        flushList();
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
  return container;
}

function appendInline(parent, text) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
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
      div.appendChild(rewindBtn);
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = msg.content;
      div.appendChild(bubble);
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

function render() {
  el("sessionTitle").textContent = state.session.title || "New session";
  renderMessages();
  renderTouchedFiles();
  renderHistoryPanel();
  renderSettingsPanel();

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

function send() {
  const input = el("input");
  if (state.streaming) {
    vscode.postMessage({ type: "stop" });
    return;
  }
  if (!input.value.trim()) return;
  vscode.postMessage({ type: "userSend", text: input.value });
  input.value = "";
}

el("sendBtn").addEventListener("click", send);
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

el("newSessionBtn").addEventListener("click", () => {
  closeSettings();
  closeHistory();
  vscode.postMessage({ type: "newSession" });
});
el("historyBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  closeSettings();
  historyOpen = !historyOpen;
  renderHistoryPanel();
});
document.addEventListener("click", (e) => {
  if (historyOpen && !el("historyPanel").contains(e.target) && e.target !== el("historyBtn")) {
    closeHistory();
  }
});
el("approvalModeBtn").addEventListener("click", () => vscode.postMessage({ type: "toggleApprovalMode" }));

el("settingsBtn").addEventListener("click", () => {
  closeHistory();
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

window.addEventListener("message", (event) => {
  if (event.data.type === "state") {
    state = event.data;
    render();
  }
});

vscode.postMessage({ type: "ready" });
