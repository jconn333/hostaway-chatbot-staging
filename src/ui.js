// src/ui.js

export function getSandboxHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Chatbot Sandbox</title>
  <style>
    :root{
      --bg:#0b1220;
      --card:#111a2e;
      --card2:#0f172a;
      --text:#e5e7eb;
      --muted:#9ca3af;
      --line:#1f2a44;
      --brand:#60a5fa;
      --good:#22c55e;
      --bad:#ef4444;
      --warn:#f59e0b;
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      background: radial-gradient(1200px 600px at 20% 0%, rgba(96,165,250,.15), transparent 60%),
                  radial-gradient(900px 500px at 80% 20%, rgba(34,197,94,.10), transparent 60%),
                  var(--bg);
      color: var(--text);
    }
    .wrap { max-width: 980px; margin: 28px auto; padding: 0 18px; }
    .topbar{
      display:flex; gap:12px; align-items:center; justify-content:space-between;
      margin-bottom: 14px;
    }
    .title{
      display:flex; flex-direction:column; gap:2px;
    }
    h1{ font-size: 20px; margin:0; letter-spacing:.2px; }
    .sub{ color: var(--muted); font-size: 13px; line-height: 1.35; }
    .pill{
      display:inline-flex; align-items:center; gap:8px;
      background: rgba(96,165,250,.12);
      border: 1px solid rgba(96,165,250,.25);
      color: var(--text);
      padding: 8px 10px;
      border-radius: 999px;
      font-size: 12px;
      box-shadow: 0 6px 18px rgba(0,0,0,.18);
      user-select:none;
      white-space: nowrap;
    }
    .grid{
      display:grid;
      grid-template-columns: 1.25fr .75fr;
      gap: 14px;
    }
    @media (max-width: 900px){
      .grid{ grid-template-columns: 1fr; }
    }
    .card{
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      border: 1px solid rgba(255,255,255,.06);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .cardHeader{
      padding: 14px 14px 10px 14px;
      border-bottom: 1px solid rgba(255,255,255,.06);
      display:flex; align-items:flex-start; justify-content:space-between; gap: 12px;
    }
    .cardHeader .h{
      font-weight: 700;
      letter-spacing:.2px;
    }
    .hint{
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
      line-height:1.35;
    }
    .content{ padding: 14px; }

    .fieldRow{ display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    @media (max-width: 520px){
      .fieldRow{ grid-template-columns: 1fr; }
    }

    label{ display:block; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    input, textarea, select{
      width: 100%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.08);
      background: rgba(15,23,42,.65);
      color: var(--text);
      outline: none;
    }
    input:focus, textarea:focus, select:focus{
      border-color: rgba(96,165,250,.45);
      box-shadow: 0 0 0 4px rgba(96,165,250,.12);
    }
    textarea{ min-height: 92px; resize: vertical; }
    .toolbar{
      display:flex; flex-wrap:wrap; gap:10px; align-items:center;
      margin-top: 10px;
    }
    .btn{
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.06);
      color: var(--text);
      border-radius: 12px;
      padding: 10px 12px;
      cursor:pointer;
      transition: transform .05s ease, background .2s ease, border-color .2s ease, opacity .2s ease;
      display:inline-flex; align-items:center; gap:8px;
      user-select:none;
    }
    .btn:hover{ background: rgba(255,255,255,.09); border-color: rgba(255,255,255,.16); }
    .btn:active{ transform: translateY(1px); }
    .btn.primary{
      background: rgba(96,165,250,.18);
      border-color: rgba(96,165,250,.35);
    }
    .btn.primary:hover{
      background: rgba(96,165,250,.24);
      border-color: rgba(96,165,250,.45);
    }
    .btn.good{
      background: rgba(34,197,94,.14);
      border-color: rgba(34,197,94,.28);
    }
    .btn.bad{
      background: rgba(239,68,68,.14);
      border-color: rgba(239,68,68,.28);
    }
    .btn:disabled{
      opacity: .5;
      cursor:not-allowed;
    }
    .mini{ font-size: 12px; padding: 8px 10px; border-radius: 10px; }

    .chat{
      display:flex; flex-direction:column; gap: 10px;
      min-height: 520px;
      max-height: 720px;
      overflow:auto;
      padding-right: 6px;
    }
    .bubble{
      max-width: 92%;
      padding: 10px 12px;
      border-radius: 14px;
      border:1px solid rgba(255,255,255,.08);
      background: rgba(15,23,42,.65);
      white-space: pre-wrap;
      line-height: 1.35;
    }
    .me{ align-self:flex-end; background: rgba(96,165,250,.14); border-color: rgba(96,165,250,.25); }
    .bot{ align-self:flex-start; background: rgba(255,255,255,.05); }
    .metaRow{
      display:flex; justify-content:space-between; align-items:center;
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .kbd{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono";
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
      padding: 2px 6px;
      border-radius: 8px;
      color: var(--text);
    }
    .toast{
      position: fixed;
      bottom: 18px;
      right: 18px;
      background: rgba(17,26,46,.95);
      border: 1px solid rgba(255,255,255,.10);
      padding: 10px 12px;
      border-radius: 12px;
      box-shadow: var(--shadow);
      min-width: 220px;
      display:none;
      color: var(--text);
      z-index: 9999;
    }
    .toast .t{ font-weight: 700; font-size: 13px; }
    .toast .m{ color: var(--muted); font-size: 12px; margin-top: 2px; }
    .badge{
      display:inline-flex; align-items:center; gap:8px;
      padding: 6px 10px;
      border-radius: 999px;
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.05);
      color: var(--muted);
      font-size: 12px;
      user-select:none;
    }
    .req{ color: var(--warn); font-weight: 700; }
    .divider{ height:1px; background: rgba(255,255,255,.08); margin: 12px 0; }
    .smallNote{ color: var(--muted); font-size: 12px; line-height:1.35; }
    .loadingDots{
      display:inline-block;
      width: 20px;
      text-align:left;
    }
    .loadingDots::after{
      content:"";
      animation: dots 1.2s infinite steps(4);
    }
    @keyframes dots{
      0%{ content:""; }
      25%{ content:"."; }
      50%{ content:".."; }
      75%{ content:"..."; }
      100%{ content:""; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="title">
        <h1>Chatbot Sandbox</h1>
        <div class="sub">Private tester page to evaluate responses, add notes, and improve quality before going live.</div>
      </div>
      <div class="pill" title="This is your staging environment (Render).">
        <span>🧪</span><strong>Staging</strong>
        <span class="badge" id="apiStatus">API: checking…</span>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="cardHeader">
          <div>
            <div class="h">Chat</div>
            <div class="hint">Tip: Press <span class="kbd">⌘</span> + <span class="kbd">Enter</span> to send.</div>
          </div>
          <button class="btn mini" id="clearBtn" title="Clears the on-screen chat (does not delete feedback).">🧹 Clear chat</button>
        </div>

        <div class="content">
          <div class="fieldRow">
            <div>
              <label>Tester name <span class="req">*</span></label>
              <input id="testerName" placeholder="e.g., Jeff" />
            </div>
            <div>
              <label>Optional Listing ID</label>
              <input id="listingId" placeholder="e.g., 214120" inputmode="numeric" />
            </div>
          </div>

          <div style="margin-top:12px;">
            <label>Message</label>
            <textarea id="question" placeholder="Ask a real guest question. Example: “Is the Joy Suite available from 2026-03-24 to 2026-03-26?”"></textarea>
            <div class="metaRow">
              <div class="smallNote" title="If you enter a Listing ID, we’ll send it to the API for exact unit answers.">
                ✅ Try with or without Listing ID
              </div>
              <div class="smallNote" id="charCount">0 chars</div>
            </div>
          </div>

          <div class="toolbar">
            <button class="btn primary" id="sendBtn" title="Send your question to the bot.">➡️ Send</button>
            <span class="badge" id="sendStatus">Ready</span>
          </div>

          <div class="divider"></div>

          <div class="chat" id="chat"></div>
        </div>
      </div>

      <div class="card">
        <div class="cardHeader">
          <div>
            <div class="h">Feedback</div>
            <div class="hint">Rate the most recent bot answer and explain what’s wrong (or what’s great).</div>
          </div>
        </div>
        <div class="content">
          <div class="smallNote">
            <strong>Guidance</strong><br/>
            • Use <em>👍 Good</em> if the answer is accurate and helpful.<br/>
            • Use <em>👎 Bad</em> if it’s wrong, vague, missing details, or unsafe.<br/>
            • Add notes: missing policy, wrong unit, bad tone, etc.
          </div>

          <div class="divider"></div>

          <div class="toolbar">
            <button class="btn good" id="thumbUp" title="Marks the last response as good.">👍 Good</button>
            <button class="btn bad" id="thumbDown" title="Marks the last response as bad.">👎 Bad</button>
          </div>

          <div style="margin-top:12px;">
            <label>Notes (what’s wrong / what’s missing)</label>
            <textarea id="feedbackText" rows="5" placeholder="Example: It should mention the 2-night minimum, and include the booking link only when exact dates are available."></textarea>
          </div>

          <div class="toolbar">
            <button class="btn primary" id="submitBtn" title="Saves your feedback to the database.">💾 Save feedback</button>
            <span class="badge" id="fbStatus">No rating yet</span>
          </div>

          <div class="divider"></div>
          <div class="smallNote">
            <span title="We store your question, the bot response, your rating, and notes in the staging database.">🔒 Stored in DB for analysis</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">
    <div class="t" id="toastTitle">Saved</div>
    <div class="m" id="toastMsg">Feedback saved.</div>
  </div>

<script>
  const el = (id) => document.getElementById(id);

  const chat = el("chat");
  const testerName = el("testerName");
  const listingId = el("listingId");
  const question = el("question");
  const sendBtn = el("sendBtn");
  const clearBtn = el("clearBtn");
  const sendStatus = el("sendStatus");
  const apiStatus = el("apiStatus");

  const thumbUp = el("thumbUp");
  const thumbDown = el("thumbDown");
  const feedbackText = el("feedbackText");
  const submitBtn = el("submitBtn");
  const fbStatus = el("fbStatus");

  const toast = el("toast");
  const toastTitle = el("toastTitle");
  const toastMsg = el("toastMsg");
  const charCount = el("charCount");

  let lastUserMessage = "";
  let lastBotReply = "";
  let lastListingId = null;
  let lastThumb = null;

  const savedName = localStorage.getItem("sandboxTesterName");
  if (savedName) testerName.value = savedName;

  testerName.addEventListener("input", () => {
    localStorage.setItem("sandboxTesterName", testerName.value.trim());
  });

  question.addEventListener("input", () => {
    charCount.textContent = (question.value || "").length + " chars";
  });

  function toastShow(title, msg){
    toastTitle.textContent = title;
    toastMsg.textContent = msg;
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 2400);
  }

 function addBubble(text, who){
  const div = document.createElement("div");
  div.className = "bubble " + (who === "me" ? "me" : "bot");
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div; // ✅ IMPORTANT: allows typing bubble to be updated later
}
 
function setTypingBubble(div, isTyping){
  if (!div) return;
  if (isTyping){
    div.textContent = "";
    div.innerHTML = "Typing<span class='loadingDots'></span>";
  }
  chat.scrollTop = chat.scrollHeight;
}

  function setSending(isSending){
    sendBtn.disabled = isSending;
    sendStatus.textContent = isSending ? "Sending" : "Ready";
    if (isSending) sendStatus.innerHTML = "Sending<span class='loadingDots'></span>";
  }

  function setFeedbackEnabled(enabled){
    thumbUp.disabled = !enabled;
    thumbDown.disabled = !enabled;
    submitBtn.disabled = !enabled;
  }

  function resetFeedbackUI(){
    lastThumb = null;
    fbStatus.textContent = "No rating yet";
    feedbackText.value = "";
    thumbUp.style.outline = "none";
    thumbDown.style.outline = "none";
  }

  function markThumb(which){
    lastThumb = which;
    fbStatus.textContent = which === "up" ? "Rated: 👍 Good" : "Rated: 👎 Bad";
    thumbUp.style.outline = which === "up" ? "2px solid rgba(34,197,94,.6)" : "none";
    thumbDown.style.outline = which === "down" ? "2px solid rgba(239,68,68,.6)" : "none";
  }

  async function checkApi(){
    try{
      const res = await fetch("/", { method: "GET" });
      if (res.ok){
        apiStatus.textContent = "API: online";
        apiStatus.style.color = "var(--good)";
        apiStatus.style.borderColor = "rgba(34,197,94,.25)";
        apiStatus.style.background = "rgba(34,197,94,.08)";
      } else {
        apiStatus.textContent = "API: issues";
      }
    }catch(e){
      apiStatus.textContent = "API: offline";
      apiStatus.style.color = "var(--bad)";
      apiStatus.style.borderColor = "rgba(239,68,68,.25)";
      apiStatus.style.background = "rgba(239,68,68,.08)";
    }
  }

  async function ask(){
  const name = testerName.value.trim();
  if (!name){
    toastShow("Missing tester name", "Please enter your name before testing.");
    testerName.focus();
    return;
  }

  const msg = (question.value || "").trim();
  if (!msg){
    toastShow("Missing message", "Type a question to send.");
    question.focus();
    return;
  }

  const lidRaw = (listingId.value || "").trim();
  const lid = lidRaw ? Number(lidRaw) : null;

  lastUserMessage = msg;
  lastListingId = lid;
  resetFeedbackUI();

  addBubble(msg, "me");
  setSending(true);
  setFeedbackEnabled(false);

  try{
    const payload = { message: msg };
    if (Number.isFinite(lid)) payload.listingId = lid;

    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    lastBotReply = data.reply || "(no reply)";
    addBubble(lastBotReply, "bot");

    setFeedbackEnabled(true);
    toastShow("Response received", "Rate the answer on the right.");
  }catch(e){
    addBubble("Server error. Check logs and try again.", "bot");
    toastShow("Error", "Could not reach the server.");
  }finally{
    setSending(false);
  }
}

  async function saveFeedback(){
  console.log("saveFeedback clicked");
    const name = testerName.value.trim();
    if (!name){
      toastShow("Missing tester name", "Please enter your name.");
      testerName.focus();
      return;
    }

    if (!lastUserMessage || !lastBotReply){
      toastShow("Nothing to rate", "Ask a question first.");
      return;
    }

    if (!lastThumb){
      toastShow("Pick a rating", "Click 👍 Good or 👎 Bad before saving.");
      return;
    }

    submitBtn.disabled = true;
    fbStatus.textContent = "Saving…";

    try{
      const body = {
        testerName: name,
        pageUrl: "/sandbox",
        listingId: Number.isFinite(lastListingId) ? lastListingId : null,
        userMessage: lastUserMessage,
        botReply: lastBotReply,
        thumbs: lastThumb,
        feedback: (feedbackText.value || "").trim()
      };

      const res = await fetch("/feedback", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      if (!data.ok){
        throw new Error(data.error || "Save failed");
      }

      fbStatus.textContent = "Saved ✅";
      toastShow("Saved", "Feedback stored in the database.");
      // Clear chat + input for next tester
    chat.innerHTML = "";
    question.value = "";
    lastListingId = null;
    lastUserMessage = "";
    lastBotReply = "";
    resetFeedbackUI();
    setFeedbackEnabled(false);
    question.focus();
    }catch(e){
      fbStatus.textContent = "Save failed";
      toastShow("Save failed", "Check server logs and DB connection.");
    }finally{
      submitBtn.disabled = false;
    }
  }
sendBtn.addEventListener("click", ask);

clearBtn.addEventListener("click", () => {
  chat.innerHTML = "";
  toastShow("Cleared", "Chat cleared on screen.");
  question.focus(); // ✅ put cursor back in message box
});

  thumbUp.addEventListener("click", () => markThumb("up"));
  thumbDown.addEventListener("click", () => markThumb("down"));
  submitBtn.addEventListener("click", saveFeedback);

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter"){
      ask();
    }
  });

  setFeedbackEnabled(false);
  checkApi();
</script>
</body>
</html>`;
}

export function getReviewHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Feedback Review</title>
  <style>
    :root{
      --bg:#0b1220;
      --card:#111a2e;
      --text:#e5e7eb;
      --muted:#9ca3af;
      --good:#22c55e;
      --bad:#ef4444;
      --line: rgba(255,255,255,.08);
      --shadow: 0 10px 30px rgba(0,0,0,.35);
      --radius: 16px;
      --brand:#60a5fa;
    }
    *{ box-sizing:border-box; }
    body{
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      background: radial-gradient(1200px 600px at 20% 0%, rgba(96,165,250,.15), transparent 60%),
                  radial-gradient(900px 500px at 80% 20%, rgba(34,197,94,.10), transparent 60%),
                  var(--bg);
      color: var(--text);
    }
    .wrap{ max-width: 1100px; margin: 28px auto; padding: 0 18px; }
    .top{
      display:flex; align-items:flex-end; justify-content:space-between; gap:12px;
      margin-bottom: 14px;
    }
    h1{ margin:0; font-size: 20px; }
    .sub{ color: var(--muted); font-size: 13px; margin-top: 4px; line-height:1.35; }
    .bar{
      display:flex; flex-wrap:wrap; gap:10px; align-items:center;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.06);
      border-radius: var(--radius);
      padding: 12px;
      box-shadow: var(--shadow);
      margin-bottom: 14px;
    }
    label{ font-size: 12px; color: var(--muted); display:block; margin-bottom: 6px; }
    input, select{
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(15,23,42,.65);
      color: var(--text);
      outline:none;
      min-width: 180px;
    }
    input:focus, select:focus{
      border-color: rgba(96,165,250,.45);
      box-shadow: 0 0 0 4px rgba(96,165,250,.12);
    }
    .btn{
      border:1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.06);
      color: var(--text);
      border-radius: 12px;
      padding: 10px 12px;
      cursor:pointer;
    }
    .btn.primary{
      background: rgba(96,165,250,.18);
      border-color: rgba(96,165,250,.35);
    }
    .stats{
      color: var(--muted);
      font-size: 12px;
      margin-left:auto;
      white-space:nowrap;
    }
    .grid{
      display:grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .card{
      background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01));
      border: 1px solid rgba(255,255,255,.06);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 12px;
    }
    .rowTop{
      display:flex; flex-wrap:wrap; justify-content:space-between; gap:10px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--line);
      margin-bottom: 10px;
    }
    .meta{ color: var(--muted); font-size: 12px; }
    .pill{
      display:inline-flex; align-items:center; gap:8px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.05);
      border-radius: 999px;
      padding: 6px 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .pill.good{ border-color: rgba(34,197,94,.25); background: rgba(34,197,94,.08); color: var(--good); }
    .pill.bad{ border-color: rgba(239,68,68,.25); background: rgba(239,68,68,.08); color: var(--bad); }
    .q{
      white-space: pre-wrap;
      line-height: 1.35;
      margin: 0;
    }
    .k{ color: var(--muted); font-size: 12px; margin: 8px 0 6px; }
    .mono{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono";
      font-size: 12px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Feedback Review</h1>
        <div class="sub">See what testers submitted. Filter by thumbs, listing ID, or tester name.</div>
      </div>
      <div class="mono">Tip: open <strong>/sandbox</strong> in another tab to test live.</div>
    </div>

    <div class="bar">
      <div>
        <label>Thumbs</label>
        <select id="thumbs">
          <option value="">All</option>
          <option value="up">👍 Good</option>
          <option value="down">👎 Bad</option>
        </select>
      </div>

      <div>
        <label>Listing ID</label>
        <input id="listingId" placeholder="e.g., 214120" inputmode="numeric" />
      </div>

      <div>
        <label>Tester</label>
        <input id="tester" placeholder="e.g., Jeff" />
      </div>

      <div>
        <label>Limit</label>
        <select id="limit">
          <option value="25">25</option>
          <option value="50" selected>50</option>
          <option value="100">100</option>
          <option value="200">200</option>
        </select>
      </div>

      <button class="btn primary" id="loadBtn">↻ Load</button>
      <div class="stats" id="stats">Loading…</div>
    </div>

    <div class="grid" id="list"></div>
  </div>

<script>
  const el = (id) => document.getElementById(id);

  const thumbsEl = el("thumbs");
  const listingIdEl = el("listingId");
  const testerEl = el("tester");
  const limitEl = el("limit");
  const loadBtn = el("loadBtn");
  const list = el("list");
  const stats = el("stats");

  function esc(s){
    return (s || "").replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[c]));
  }

  function pill(thumbs){
    if (thumbs === "up") return "<span class='pill good'>👍 Good</span>";
    if (thumbs === "down") return "<span class='pill bad'>👎 Bad</span>";
    return "<span class='pill'>No thumbs</span>";
  }

  function fmtDate(v){
    if (!v) return "";
    try { return new Date(v).toLocaleString(); } catch { return String(v); }
  }

  async function load(){
    list.innerHTML = "";
    stats.textContent = "Loading…";

    const params = new URLSearchParams();
    const thumbs = thumbsEl.value;
    const listingId = listingIdEl.value.trim();
    const tester = testerEl.value.trim();
    const limit = limitEl.value;

    if (thumbs) params.set("thumbs", thumbs);
    if (listingId) params.set("listingId", listingId);
    if (tester) params.set("tester", tester);
    if (limit) params.set("limit", limit);

    // Robust fetch + JSON parse (prevents the page from breaking on network/JSON errors)
    let data = null;
    try{
      const res = await fetch("/feedback/recent?" + params.toString());
      data = await res.json();
    }catch(e){
      stats.textContent = "Failed to load.";
      list.innerHTML = "<div class='card'>Could not reach the server or parse response.</div>";
      return;
    }

    if (!data.ok){
      stats.textContent = "Failed to load.";
      list.innerHTML = "<div class='card'>Server error loading feedback.</div>";
      return;
    }

    const rows = data.rows || [];
    stats.textContent = rows.length + " result(s)";

    if (rows.length === 0){
      list.innerHTML = "<div class='card'>No feedback found for those filters.</div>";
      return;
    }

    list.innerHTML = rows.map(r => \`
      <div class="card">
        <div class="rowTop">
          <div class="meta">
            <div><strong>\${esc(r.tester_name || "Unknown tester")}</strong> • \${esc(r.page_url || "")}</div>
            <div class="mono">\${fmtDate(r.created_at)} • Listing: \${esc(r.listing_id == null ? "-" : String(r.listing_id))}</div>
          </div>
          <div>\${pill(r.thumbs)}</div>
        </div>

        <div class="k">User message</div>
        <p class="q">\${esc(r.user_message)}</p>

        <div class="k">Bot reply</div>
        <p class="q">\${esc(r.bot_reply)}</p>

        <div class="k">Tester notes</div>
        <p class="q">\${esc(r.feedback || "(none)")}</p>
      </div>
    \`).join("");
  }

  loadBtn.addEventListener("click", load);

  // nice UX: pressing Enter in filter boxes reloads
  [listingIdEl, testerEl].forEach(inp => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") load();
    });
  });

  load();
</script>
</body>
</html>`;
}