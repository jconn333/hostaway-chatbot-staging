// src/ui.js

export function getSandboxHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Amish Country Lodging Chat</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap");

    :root{
      --bg:#07101d;
      --bg-2:#0d1728;
      --card:rgba(16, 24, 40, .78);
      --card-border:rgba(148, 163, 184, .22);
      --text:#e2e8f0;
      --muted:#94a3b8;
      --accent:#38bdf8;
      --accent-2:#22d3ee;
      --good:#22c55e;
      --warning:#f59e0b;
      --bubble-bot:rgba(148, 163, 184, .16);
      --bubble-user:linear-gradient(130deg, rgba(56,189,248,.22), rgba(34,211,238,.22));
      --shadow:0 18px 40px rgba(2, 6, 23, .45);
      --radius-xl:20px;
      --radius-lg:14px;
      --radius-md:10px;
    }

    * { box-sizing: border-box; }

    body{
      margin:0;
      font-family:"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
      color:var(--text);
      background:
        radial-gradient(900px 520px at 5% -10%, rgba(56,189,248,.2), transparent 55%),
        radial-gradient(800px 480px at 100% 0%, rgba(34,211,238,.16), transparent 58%),
        linear-gradient(160deg, var(--bg), var(--bg-2));
      min-height:100vh;
    }

    .shell{
      max-width:1040px;
      margin:22px auto;
      padding:0 16px;
    }

    .hero{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:14px;
      margin-bottom:14px;
    }

    .hero h1{
      margin:0;
      font-family:"Space Grotesk", ui-sans-serif, system-ui, sans-serif;
      font-size:26px;
      letter-spacing:.25px;
    }

    .sub{
      margin-top:6px;
      color:var(--muted);
      font-size:13px;
      line-height:1.4;
      max-width:760px;
    }

    .status{
      display:inline-flex;
      align-items:center;
      gap:8px;
      border:1px solid rgba(56,189,248,.42);
      background:linear-gradient(135deg, rgba(56,189,248,.16), rgba(34,211,238,.16));
      border-radius:999px;
      padding:8px 12px;
      font-size:12px;
      white-space:nowrap;
    }

    .app{
      background:var(--card);
      border:1px solid var(--card-border);
      border-radius:var(--radius-xl);
      box-shadow:var(--shadow);
      overflow:hidden;
    }

    .toolbar{
      display:grid;
      grid-template-columns:1fr 1fr auto;
      gap:10px;
      padding:14px;
      border-bottom:1px solid rgba(148,163,184,.16);
      background:linear-gradient(180deg, rgba(15,23,42,.65), rgba(15,23,42,.3));
    }

    @media (max-width: 740px){
      .toolbar{ grid-template-columns:1fr; }
    }

    label{
      display:block;
      color:var(--muted);
      font-size:12px;
      margin-bottom:6px;
      font-weight:500;
    }

    input, textarea{
      width:100%;
      border:1px solid rgba(148,163,184,.24);
      background:rgba(15,23,42,.56);
      color:var(--text);
      border-radius:var(--radius-md);
      padding:10px 11px;
      outline:none;
      transition:border-color .18s ease, box-shadow .18s ease;
    }

    input:focus, textarea:focus{
      border-color:rgba(56,189,248,.55);
      box-shadow:0 0 0 4px rgba(56,189,248,.14);
    }

    .chatWrap{
      display:flex;
      flex-direction:column;
      min-height:560px;
      max-height:72vh;
    }

    .chat{
      flex:1;
      overflow:auto;
      padding:14px;
      display:flex;
      flex-direction:column;
      gap:10px;
      scrollbar-width:thin;
    }

    .bubble{
      max-width:86%;
      padding:11px 13px;
      border-radius:14px;
      border:1px solid rgba(148,163,184,.22);
      line-height:1.45;
      white-space:pre-wrap;
      font-size:14px;
    }

    .bubble.bot{
      background:var(--bubble-bot);
      align-self:flex-start;
    }

    .bubble.user{
      background:var(--bubble-user);
      border-color:rgba(56,189,248,.36);
      align-self:flex-end;
    }

    .bubble a{
      color:#7dd3fc;
      text-decoration:none;
      border-bottom:1px solid rgba(125,211,252,.42);
    }

    .bubble a:hover{
      color:#bae6fd;
      border-bottom-color:rgba(186,230,253,.8);
    }

    .composer{
      border-top:1px solid rgba(148,163,184,.16);
      padding:12px 14px 14px;
      background:rgba(15,23,42,.5);
    }

    .composer textarea{
      min-height:90px;
      resize:vertical;
      line-height:1.45;
      margin-bottom:10px;
    }

    .actions{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      flex-wrap:wrap;
    }

    .btnRow{
      display:flex;
      align-items:center;
      gap:8px;
      flex-wrap:wrap;
    }

    .btn{
      border:1px solid rgba(148,163,184,.24);
      background:rgba(148,163,184,.12);
      color:var(--text);
      border-radius:10px;
      padding:9px 12px;
      cursor:pointer;
      font-size:13px;
      font-weight:500;
      transition:all .16s ease;
    }

    .btn:hover{
      border-color:rgba(148,163,184,.34);
      background:rgba(148,163,184,.18);
    }

    .btn:disabled{
      opacity:.55;
      cursor:not-allowed;
    }

    .btn.primary{
      border-color:rgba(56,189,248,.42);
      background:linear-gradient(130deg, rgba(56,189,248,.28), rgba(34,211,238,.24));
    }

    .badge{
      font-size:12px;
      color:var(--muted);
      border:1px solid rgba(148,163,184,.2);
      border-radius:999px;
      padding:6px 10px;
      background:rgba(15,23,42,.42);
    }

    .meta{
      display:flex;
      align-items:center;
      gap:8px;
      color:var(--muted);
      font-size:12px;
    }

    .dot{
      width:8px;
      height:8px;
      border-radius:999px;
      background:var(--warning);
      display:inline-block;
    }

    .dot.good{
      background:var(--good);
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div>
        <h1>Amish Country Lodging Chat</h1>
        <div class="sub">Ask about amenities, policies, availability, and booking details. Session memory keeps context for follow-up questions.</div>
      </div>
      <div class="status"><strong>Staging</strong> <span id="apiStatus">API: checking...</span></div>
    </div>

    <div class="app">
      <div class="toolbar">
        <div>
          <label>Tester Name</label>
          <input id="testerName" placeholder="e.g., Jeff" />
        </div>
        <div>
          <label>Session ID</label>
          <input id="sessionId" placeholder="auto-generated if blank" />
        </div>
        <div>
          <label>Optional Listing ID</label>
          <input id="listingId" placeholder="e.g., 214124" inputmode="numeric" />
        </div>
      </div>

      <div class="chatWrap">
        <div class="chat" id="chat"></div>
        <div class="composer">
          <label>Message</label>
          <textarea id="question" placeholder="Example: Is Red Fern Cabin available from 2026-03-24 to 2026-03-26?"></textarea>
          <div class="actions">
            <div class="btnRow">
              <button class="btn primary" id="sendBtn">Send</button>
              <button class="btn" id="clearBtn">Clear Chat</button>
              <button class="btn" id="resetSessionBtn">Reset Session</button>
            </div>
            <div class="meta">
              <span class="dot" id="sendDot"></span>
              <span id="sendStatus">Ready</span>
              <span class="badge" id="charCount">0 chars</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const el = (id) => document.getElementById(id);
    const chat = el("chat");
    const testerName = el("testerName");
    const listingId = el("listingId");
    const sessionId = el("sessionId");
    const question = el("question");
    const sendBtn = el("sendBtn");
    const clearBtn = el("clearBtn");
    const resetSessionBtn = el("resetSessionBtn");
    const sendStatus = el("sendStatus");
    const sendDot = el("sendDot");
    const apiStatus = el("apiStatus");
    const charCount = el("charCount");

    const savedName = localStorage.getItem("sandboxTesterName");
    if (savedName) testerName.value = savedName;

    function generateSessionId(){
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
      return "sess-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    const savedSessionId = localStorage.getItem("sandboxSessionId");
    if (savedSessionId) {
      sessionId.value = savedSessionId;
    } else {
      const sid = generateSessionId();
      sessionId.value = sid;
      localStorage.setItem("sandboxSessionId", sid);
    }

    testerName.addEventListener("input", () => {
      localStorage.setItem("sandboxTesterName", testerName.value.trim());
    });

    sessionId.addEventListener("input", () => {
      localStorage.setItem("sandboxSessionId", sessionId.value.trim());
    });

    resetSessionBtn.addEventListener("click", () => {
      const sid = generateSessionId();
      sessionId.value = sid;
      localStorage.setItem("sandboxSessionId", sid);
    });

    question.addEventListener("input", () => {
      charCount.textContent = (question.value || "").length + " chars";
    });

    function escapeHtml(s){
      return (s || "").replace(/[&<>"']/g, (c) => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
      }[c]));
    }

    function formatBotText(text){
      const s = text || "";
      let out = "";
      let i = 0;
      while (i < s.length) {
        const open = s.indexOf("[", i);
        if (open === -1) {
          out += escapeHtml(s.slice(i));
          break;
        }
        const mid = s.indexOf("](", open + 1);
        const close = mid !== -1 ? s.indexOf(")", mid + 2) : -1;
        if (mid === -1 || close === -1) {
          out += escapeHtml(s.slice(i));
          break;
        }
        out += escapeHtml(s.slice(i, open));
        const label = s.slice(open + 1, mid);
        const url = s.slice(mid + 2, close);
        if (url.startsWith("http://") || url.startsWith("https://")) {
          out +=
            '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(label) + "</a>";
        } else {
          out += escapeHtml(s.slice(open, close + 1));
        }
        i = close + 1;
      }
      return out;
    }

    function addBubble(text, who){
      const div = document.createElement("div");
      div.className = "bubble " + (who === "user" ? "user" : "bot");
      if (who === "bot") {
        div.innerHTML = formatBotText(text);
      } else {
        div.textContent = text;
      }
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    function setSending(isSending){
      sendBtn.disabled = isSending;
      sendStatus.textContent = isSending ? "Sending..." : "Ready";
      sendDot.classList.toggle("good", !isSending);
    }

    async function checkApi(){
      try{
        const res = await fetch("/healthz", { method: "GET" });
        if (res.ok){
          apiStatus.textContent = "online";
        } else {
          apiStatus.textContent = "issues";
        }
      }catch(e){
        apiStatus.textContent = "offline";
      }
    }

    async function ask(){
      const name = testerName.value.trim();
      if (!name) {
        testerName.focus();
        return;
      }

      const msg = (question.value || "").trim();
      if (!msg) {
        question.focus();
        return;
      }

      const lidRaw = (listingId.value || "").trim();
      const lid = lidRaw ? Number(lidRaw) : null;

      addBubble(msg, "user");
      question.value = "";
      charCount.textContent = "0 chars";
      setSending(true);

      try{
        const payload = { message: msg };
        if (Number.isFinite(lid)) payload.listingId = lid;

        let sid = (sessionId.value || "").trim();
        if (!sid) {
          sid = generateSessionId();
          sessionId.value = sid;
          localStorage.setItem("sandboxSessionId", sid);
        }
        payload.sessionId = sid;

        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        addBubble(data.reply || "(no reply)", "bot");
      } catch (e) {
        addBubble("Server error. Please retry.", "bot");
      } finally {
        setSending(false);
      }
    }

    sendBtn.addEventListener("click", ask);
    clearBtn.addEventListener("click", () => {
      chat.innerHTML = "";
      question.focus();
    });

    question.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ask();
      }
    });

    setSending(false);
    checkApi();
  </script>
</body>
</html>`;
}
