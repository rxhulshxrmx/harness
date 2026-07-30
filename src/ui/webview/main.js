const vscode = acquireVsCodeApi();
const el = (id) => document.getElementById(id);

let state = { session: { messages: [] }, streamingText: "", pendingApproval: null, touchedFiles: [], sessionList: [], approvalMode: "ask" };

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

function render() {
  const messagesEl = el("messages");
  messagesEl.innerHTML = "";

  for (const msg of state.session.messages) {
    if (msg.role === "user") {
      const div = document.createElement("div");
      div.className = "msg user";
      div.textContent = msg.content;
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
        div.textContent = `▸ ${call.function.name} ${call.function.arguments}`;
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
      div.textContent = `  └ ${preview}`;
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
    const label = document.createElement("div");
    label.textContent = `Run: ${state.pendingApproval.command}`;
    div.appendChild(label);
    const approveBtn = document.createElement("button");
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => vscode.postMessage({ type: "approve", id: state.pendingApproval.id }));
    const denyBtn = document.createElement("button");
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => vscode.postMessage({ type: "deny", id: state.pendingApproval.id }));
    div.appendChild(approveBtn);
    div.appendChild(denyBtn);
    messagesEl.appendChild(div);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;

  const touchedEl = el("touchedFiles");
  touchedEl.innerHTML = "";
  touchedEl.classList.toggle("visible", state.touchedFiles.length > 0);
  for (const file of state.touchedFiles) {
    const span = document.createElement("span");
    span.textContent = file;
    span.addEventListener("click", () => vscode.postMessage({ type: "openDiff", file }));
    touchedEl.appendChild(span);
  }

  const sel = el("sessionSelect");
  sel.innerHTML = "";
  for (const s of state.sessionList) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.title;
    if (s.id === state.session.id) opt.selected = true;
    sel.appendChild(opt);
  }

  el("approvalModeBtn").textContent = state.approvalMode;
  el("stopBtn").disabled = !state.streaming;
}

el("sendBtn").addEventListener("click", () => {
  const input = el("input");
  if (!input.value.trim()) return;
  vscode.postMessage({ type: "userSend", text: input.value });
  input.value = "";
});
el("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el("sendBtn").click();
  }
});
el("newSessionBtn").addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
el("stopBtn").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
el("approvalModeBtn").addEventListener("click", () => vscode.postMessage({ type: "toggleApprovalMode" }));
el("sessionSelect").addEventListener("change", (e) => vscode.postMessage({ type: "selectSession", id: e.target.value }));

window.addEventListener("message", (event) => {
  if (event.data.type === "state") {
    state = event.data;
    render();
  }
});

vscode.postMessage({ type: "ready" });
