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

    .mainGrid{
      display:grid;
      grid-template-columns:minmax(0, 1fr) 320px;
      min-height:560px;
      height:min(72vh, 780px);
    }

    @media (max-width: 980px){
      .mainGrid{
        grid-template-columns:1fr;
        height:auto;
      }
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
      min-height:0;
      height:100%;
    }

    .chat{
      flex:1;
      min-height:0;
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

    .feedbackBtn{
      border:1px solid rgba(148,163,184,.24);
      background:rgba(148,163,184,.1);
      color:var(--text);
      border-radius:8px;
      padding:4px 8px;
      cursor:pointer;
      font-size:12px;
      line-height:1.1;
    }

    .feedbackBtn:hover{
      border-color:rgba(125,211,252,.55);
      background:rgba(56,189,248,.16);
    }

    .feedbackBtn.active{
      border-color:rgba(34,197,94,.65);
      background:rgba(34,197,94,.18);
    }

    .feedbackSaved{
      color:#86efac;
    }

    .feedbackPanel{
      border-left:1px solid rgba(148,163,184,.16);
      background:rgba(15,23,42,.42);
      padding:14px;
      display:flex;
      flex-direction:column;
      gap:10px;
      overflow:auto;
    }

    .feedbackPanel h3{
      margin:0;
      font-family:"Space Grotesk", ui-sans-serif, system-ui, sans-serif;
      font-size:16px;
      letter-spacing:.2px;
    }

    .feedbackHint{
      margin:0;
      font-size:12px;
      color:var(--muted);
      line-height:1.4;
    }

    .voteRow{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }

    .feedbackPanel textarea{
      min-height:120px;
      resize:vertical;
    }

    .optionalDetails{
      border:1px solid rgba(148,163,184,.2);
      border-radius:10px;
      padding:8px 10px;
      background:rgba(15,23,42,.32);
    }

    .optionalDetails summary{
      cursor:pointer;
      color:var(--muted);
      font-size:12px;
      font-weight:600;
      outline:none;
      list-style:none;
    }

    .optionalDetails summary::-webkit-details-marker{
      display:none;
    }

    .optionalDetails summary::before{
      content:"▸";
      margin-right:6px;
      color:var(--muted);
    }

    .optionalDetails[open] summary::before{
      content:"▾";
    }

    .optionalBody{
      margin-top:8px;
      display:flex;
      flex-direction:column;
      gap:8px;
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

      <div class="mainGrid">
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
                <span class="badge" id="codeVersionBadge">code: unknown</span>
              </div>
            </div>
          </div>
        </div>
        <aside class="feedbackPanel">
          <h3>Conversation Feedback</h3>
          <p class="feedbackHint">Rate the full chat, then submit. This saves feedback, starts a new session ID, and clears the conversation.</p>
          <div class="voteRow">
            <button class="feedbackBtn" id="convUpBtn" type="button">👍</button>
            <button class="feedbackBtn" id="convDownBtn" type="button">👎</button>
          </div>
          <details class="optionalDetails">
            <summary>Add details (optional)</summary>
            <div class="optionalBody">
              <div>
                <label>Tags (comma-separated)</label>
                <input id="convTags" placeholder="e.g., wrong_route, context_lost, good_tone" />
              </div>
              <div>
                <label>Notes</label>
                <textarea id="convNote" placeholder="What worked or what failed?"></textarea>
              </div>
            </div>
          </details>
          <div class="btnRow">
            <button class="btn primary" id="submitFeedbackBtn" type="button">Submit Feedback</button>
            <button class="btn" id="resetFeedbackBtn" type="button">Reset Feedback</button>
          </div>
          <div class="meta">
            <span class="dot" id="feedbackDot"></span>
            <span id="feedbackStatus">Not submitted</span>
          </div>
        </aside>
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
    const codeVersionBadge = el("codeVersionBadge");
    const convUpBtn = el("convUpBtn");
    const convDownBtn = el("convDownBtn");
    const convTags = el("convTags");
    const convNote = el("convNote");
    const submitFeedbackBtn = el("submitFeedbackBtn");
    const resetFeedbackBtn = el("resetFeedbackBtn");
    const feedbackStatus = el("feedbackStatus");
    const feedbackDot = el("feedbackDot");
    let currentCodeVersion = "unknown";
    let turnNumber = 0;
    const transcript = [];
    let conversationVote = null;

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

    function addUserBubble(text){
      const div = document.createElement("div");
      div.className = "bubble user";
      div.textContent = text;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    async function sendFeedback(payload, rowEl){
      try {
        const res = await fetch("/feedback", {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "feedback failed");
        feedbackStatus.textContent = "Feedback saved";
        feedbackStatus.classList.add("feedbackSaved");
        feedbackDot.classList.add("good");
        if (rowEl) rowEl.innerHTML = '<span class="feedbackSaved">Saved feedback</span>';
      } catch (err) {
        feedbackStatus.textContent = "Feedback failed to save";
        feedbackStatus.classList.remove("feedbackSaved");
        feedbackDot.classList.remove("good");
        if (rowEl) rowEl.innerHTML = '<span>Feedback failed to save</span>';
      }
    }

    function addBotBubble(text, ctx){
      const div = document.createElement("div");
      div.className = "bubble bot";
      div.innerHTML = formatBotText(text);
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
    }

    function setConversationVote(vote){
      conversationVote = vote;
      convUpBtn.classList.toggle("active", vote === "up");
      convDownBtn.classList.toggle("active", vote === "down");
    }

    function resetConversationState(){
      chat.innerHTML = "";
      transcript.length = 0;
      turnNumber = 0;
    }

    function resetFeedbackForm(){
      setConversationVote(null);
      convTags.value = "";
      convNote.value = "";
      feedbackStatus.textContent = "Not submitted";
      feedbackStatus.classList.remove("feedbackSaved");
      feedbackDot.classList.remove("good");
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
          const data = await res.json();
          currentCodeVersion = data.codeVersion || currentCodeVersion;
          codeVersionBadge.textContent = "code: " + currentCodeVersion;
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

      addUserBubble(msg);
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

        const versionHeader = res.headers.get("x-code-version");
        if (versionHeader) {
          currentCodeVersion = versionHeader;
          codeVersionBadge.textContent = "code: " + currentCodeVersion;
        }
        const data = await res.json();
        turnNumber += 1;
        const botText = data.reply || "(no reply)";
        transcript.push({
          turnNumber,
          sessionId: sid,
          userMessage: msg,
          botReply: botText,
          ts: new Date().toISOString()
        });
        addBotBubble(botText, {
          turnNumber,
          sessionId: sid,
          userMessage: msg,
          listingId: Number.isFinite(lid) ? lid : null
        });
      } catch (e) {
        addBotBubble("Server error. Please retry.", {
          turnNumber: turnNumber + 1,
          sessionId: (sessionId.value || "").trim(),
          userMessage: msg,
          listingId: Number.isFinite(lid) ? lid : null
        });
      } finally {
        setSending(false);
      }
    }

    sendBtn.addEventListener("click", ask);
    clearBtn.addEventListener("click", () => {
      resetConversationState();
      question.focus();
    });
    convUpBtn.addEventListener("click", () => setConversationVote("up"));
    convDownBtn.addEventListener("click", () => setConversationVote("down"));
    resetFeedbackBtn.addEventListener("click", () => resetFeedbackForm());
    submitFeedbackBtn.addEventListener("click", async () => {
      if (!conversationVote) {
        feedbackStatus.textContent = "Select thumbs up or down first";
        feedbackStatus.classList.remove("feedbackSaved");
        feedbackDot.classList.remove("good");
        return;
      }
      if (!transcript.length) {
        feedbackStatus.textContent = "No conversation to submit yet";
        feedbackStatus.classList.remove("feedbackSaved");
        feedbackDot.classList.remove("good");
        return;
      }
      const sid = (sessionId.value || "").trim();
      const lidRaw = (listingId.value || "").trim();
      const lid = lidRaw ? Number(lidRaw) : null;
      const tags = String(convTags.value || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 12);
      const lastTurn = transcript[transcript.length - 1] || {};
      const payload = {
        feedback: conversationVote,
        codeVersion: currentCodeVersion,
        testerName: testerName.value.trim() || null,
        sessionId: sid,
        listingId: Number.isFinite(lid) ? String(lid) : null,
        turnNumber: Math.max(1, transcript.length),
        userMessage: String(lastTurn.userMessage || ""),
        botReply: String(lastTurn.botReply || ""),
        tags,
        note: String(convNote.value || "").trim(),
        transcript: transcript.slice(-40),
        meta: {
          page: "sandbox",
          scope: "conversation",
          turns: transcript.length,
          sentAt: new Date().toISOString()
        }
      };
      await sendFeedback(payload, null);
      if (feedbackStatus.classList.contains("feedbackSaved")) {
        const sidNew = generateSessionId();
        sessionId.value = sidNew;
        localStorage.setItem("sandboxSessionId", sidNew);
        resetConversationState();
        resetFeedbackForm();
      }
    });

    question.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ask();
      }
    });

    setSending(false);
    resetFeedbackForm();
    checkApi();
  </script>
</body>
</html>`;
}
