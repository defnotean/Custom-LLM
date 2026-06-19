export function renderLearningReviewPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Irene Learning Review</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --panel-strong: #f0f4f8;
      --ink: #17202a;
      --muted: #5c6674;
      --line: #d9e0e8;
      --accent: #0f766e;
      --accent-strong: #115e59;
      --warn: #9a3412;
      --danger: #b42318;
      --ok: #166534;
      --focus: #2563eb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      letter-spacing: 0;
    }
    button, input, select, textarea {
      font: inherit;
      letter-spacing: 0;
    }
    button {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      padding: 0 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    button.primary:hover { background: var(--accent-strong); }
    button.danger {
      color: var(--danger);
      border-color: #f1b7b1;
      background: #fff7f6;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    input, select, textarea {
      min-height: 36px;
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 7px 9px;
    }
    textarea { min-height: 72px; resize: vertical; }
    input:focus, select:focus, textarea:focus, button:focus {
      outline: 2px solid var(--focus);
      outline-offset: 1px;
    }
    .shell {
      width: min(1440px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 18px 0 28px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 700;
    }
    .subtitle {
      margin-top: 3px;
      color: var(--muted);
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel-strong);
      border-radius: 8px 8px 0 0;
    }
    .panel-title {
      font-weight: 700;
      font-size: 14px;
    }
    .panel-body {
      padding: 14px;
    }
    .filters {
      display: grid;
      gap: 12px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 9px;
      background: #fff;
      min-width: 0;
    }
    .metric-value {
      font-weight: 700;
      font-size: 18px;
      line-height: 1.1;
      overflow-wrap: anywhere;
    }
    .metric-label {
      color: var(--muted);
      font-size: 11px;
      margin-top: 3px;
      overflow-wrap: anywhere;
    }
    .batch-actions {
      display: grid;
      gap: 8px;
    }
    .action-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .status {
      min-height: 22px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.bad { color: var(--danger); }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 8px;
      vertical-align: top;
      text-align: left;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      background: #fbfcfd;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .select-cell { width: 42px; }
    .id-cell { width: 180px; }
    .kind-cell { width: 130px; }
    .status-cell { width: 160px; }
    .confidence-cell { width: 100px; }
    .actions-cell { width: 180px; }
    .item-id, .content {
      overflow-wrap: anywhere;
    }
    .content {
      color: var(--ink);
      max-height: 108px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 5px;
    }
    .chip {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 7px;
      color: var(--muted);
      background: #fff;
      font-size: 11px;
      max-width: 100%;
      overflow-wrap: anywhere;
    }
    .chip.ok { color: var(--ok); border-color: #b7d7bd; background: #f3fbf4; }
    .chip.warn { color: var(--warn); border-color: #f4c7a6; background: #fff8ed; }
    .chip.bad { color: var(--danger); border-color: #efb2aa; background: #fff7f6; }
    .item-actions {
      display: grid;
      gap: 6px;
    }
    .report {
      margin-top: 14px;
      max-height: 300px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #111827;
      color: #f9fafb;
      padding: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }
    .empty {
      padding: 34px 14px;
      color: var(--muted);
      text-align: center;
    }
    @media (max-width: 900px) {
      .shell { width: min(100vw - 20px, 760px); padding-top: 12px; }
      .topbar { align-items: stretch; flex-direction: column; }
      .toolbar { justify-content: flex-start; }
      .grid { grid-template-columns: 1fr; }
      table { min-width: 900px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div>
        <h1>Irene Learning Review</h1>
        <div class="subtitle">Live memory, skill, preference, correction, voice, document, and eval-failure queue</div>
      </div>
      <div class="toolbar">
        <button id="refresh">Refresh</button>
        <button id="plan-growth" class="primary">Plan Growth</button>
      </div>
    </div>
    <section class="grid">
      <aside class="panel">
        <div class="panel-header">
          <div class="panel-title">Queue Controls</div>
        </div>
        <div class="panel-body filters">
          <div class="metrics" id="metrics"></div>
          <label>Kind
            <select id="kind">
              <option value="">all</option>
              <option value="memory">memory</option>
              <option value="skill">skill</option>
              <option value="preference">preference</option>
              <option value="correction">correction</option>
              <option value="eval_failure">eval_failure</option>
              <option value="voice_summary">voice_summary</option>
              <option value="document">document</option>
            </select>
          </label>
          <label>Review
            <select id="reviewStatus">
              <option value="candidate">candidate</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
              <option value="">all</option>
            </select>
          </label>
          <label>Training
            <select id="trainingStatus">
              <option value="not_queued">not_queued</option>
              <option value="queued">queued</option>
              <option value="trained">trained</option>
              <option value="blocked">blocked</option>
              <option value="">all</option>
            </select>
          </label>
          <label>Limit
            <input id="limit" type="number" min="1" max="200" value="50">
          </label>
          <label>Reviewer
            <input id="reviewerId" value="operator">
          </label>
          <label>Dataset
            <input id="datasetId" value="live-learning-review">
          </label>
          <label>Reason
            <textarea id="reason">reviewed for parameter-growth training</textarea>
          </label>
          <div class="batch-actions">
            <div class="action-row">
              <button id="select-all">Select All</button>
              <button id="clear-selection">Clear</button>
            </div>
            <button id="dry-run">Dry Run Approve + Queue</button>
            <button id="apply" class="primary">Apply Approve + Queue</button>
            <button id="reject" class="danger">Reject Selected</button>
          </div>
          <div id="status" class="status"></div>
        </div>
      </aside>
      <section class="panel">
        <div class="panel-header">
          <div class="panel-title">Learned Items</div>
          <div class="status" id="count"></div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="select-cell"></th>
                <th class="id-cell">ID</th>
                <th class="kind-cell">Kind</th>
                <th>Content</th>
                <th class="status-cell">State</th>
                <th class="confidence-cell">Score</th>
                <th class="actions-cell">Actions</th>
              </tr>
            </thead>
            <tbody id="items"></tbody>
          </table>
          <div id="empty" class="empty" hidden>No learned items returned</div>
        </div>
        <pre id="report" class="report" hidden></pre>
      </section>
    </section>
  </main>
  <script>
    const state = { items: [], selected: new Set() };
    const $ = (id) => document.getElementById(id);
    const controls = ["kind", "reviewStatus", "trainingStatus", "limit"];
    for (const id of controls) $(id).addEventListener("change", refresh);
    $("refresh").addEventListener("click", refresh);
    $("select-all").addEventListener("click", () => {
      state.items.forEach((item) => state.selected.add(item.id));
      renderItems();
    });
    $("clear-selection").addEventListener("click", () => {
      state.selected.clear();
      renderItems();
    });
    $("dry-run").addEventListener("click", () => batchReview({ execute: false, reviewStatus: "approved", queue: true }));
    $("apply").addEventListener("click", () => batchReview({ execute: true, reviewStatus: "approved", queue: true }));
    $("reject").addEventListener("click", () => batchReview({ execute: true, reviewStatus: "rejected", queue: false }));
    $("plan-growth").addEventListener("click", planGrowth);

    async function refresh() {
      setStatus("Loading learned items...");
      const params = new URLSearchParams();
      for (const id of controls) {
        const value = $(id).value.trim();
        if (value) params.set(id, value);
      }
      try {
        const [status, list] = await Promise.all([
          fetchJson("/learning/status"),
          fetchJson("/learning/items?" + params.toString()),
        ]);
        state.items = Array.isArray(list.items) ? list.items : [];
        state.selected = new Set([...state.selected].filter((id) => state.items.some((item) => item.id === id)));
        renderMetrics(status);
        renderItems();
        setStatus("Loaded " + state.items.length + " items", "ok");
      } catch (err) {
        setStatus(String(err.message || err), "bad");
      }
    }

    async function batchReview(options) {
      const ids = [...state.selected];
      if (ids.length === 0) {
        setStatus("Select at least one item", "warn");
        return;
      }
      const payload = {
        ids,
        reviewStatus: options.reviewStatus,
        reviewerId: $("reviewerId").value.trim() || null,
        reviewReason: $("reason").value.trim() || null,
        queue: options.queue,
        datasetId: $("datasetId").value.trim() || undefined,
        queueReason: $("reason").value.trim() || undefined,
        execute: options.execute,
      };
      if (!options.execute) payload.dryRun = true;
      try {
        setStatus(options.execute ? "Applying batch..." : "Running dry run...");
        const result = await fetchJson("/learning/items/batch-review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        showReport(result);
        setStatus(result.status + ": " + result.summary.matched + " matched, " + result.summary.queued + " queued", result.summary.errors ? "warn" : "ok");
        if (options.execute) await refresh();
      } catch (err) {
        setStatus(String(err.message || err), "bad");
      }
    }

    async function planGrowth() {
      try {
        setStatus("Planning parameter growth...");
        const result = await fetchJson("/learning/parameter-growth/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: 250, minItems: 2, gate: { allowRiskReview: true } }),
        });
        showReport(result);
        setStatus(result.status + ": " + (result.plan?.summary?.readyBatches ?? 0) + " ready batches", result.gateReport?.status === "pass" ? "ok" : "warn");
      } catch (err) {
        setStatus(String(err.message || err), "bad");
      }
    }

    async function reviewOne(id, status) {
      try {
        const item = await fetchJson("/learning/items/" + encodeURIComponent(id) + "/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status, reviewerId: $("reviewerId").value.trim() || null, reason: $("reason").value.trim() || null }),
        });
        showReport(item);
        setStatus(id + " marked " + status, "ok");
        await refresh();
      } catch (err) {
        setStatus(String(err.message || err), "bad");
      }
    }

    async function queueOne(id) {
      try {
        const item = await fetchJson("/learning/items/" + encodeURIComponent(id) + "/queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ datasetId: $("datasetId").value.trim() || undefined, reason: $("reason").value.trim() || undefined }),
        });
        showReport(item);
        setStatus(id + " queued", "ok");
        await refresh();
      } catch (err) {
        setStatus(String(err.message || err), "bad");
      }
    }

    async function fetchJson(url, init) {
      const response = await fetch(url, init);
      const text = await response.text();
      const body = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(body.reason || body.error || response.statusText);
      return body;
    }

    function renderMetrics(stats) {
      const metrics = [
        ["Learned", stats.learnedItems],
        ["Candidates", stats.candidateItems],
        ["Approved", stats.approvedItems],
        ["Queued", stats.queuedItems],
        ["Modules", stats.parameterModules],
        ["Active Params", compact(stats.activeParamsPerRequest)],
      ];
      $("metrics").replaceChildren(...metrics.map(([label, value]) => {
        const node = document.createElement("div");
        node.className = "metric";
        const valueNode = document.createElement("div");
        valueNode.className = "metric-value";
        valueNode.textContent = value ?? "0";
        const labelNode = document.createElement("div");
        labelNode.className = "metric-label";
        labelNode.textContent = label;
        node.append(valueNode, labelNode);
        return node;
      }));
    }

    function renderItems() {
      $("count").textContent = state.items.length + " rows, " + state.selected.size + " selected";
      $("empty").hidden = state.items.length !== 0;
      $("items").replaceChildren(...state.items.map((item) => {
        const row = document.createElement("tr");
        row.append(cell(checkbox(item)), cell(idBlock(item)), cell(text(item.kind)), cell(contentBlock(item)), cell(stateBlock(item)), cell(text(String(Math.round((item.confidence ?? 0) * 100)) + "%")), cell(actionBlock(item)));
        return row;
      }));
    }

    function checkbox(item) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = state.selected.has(item.id);
      input.setAttribute("aria-label", "select " + item.id);
      input.addEventListener("change", () => {
        if (input.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        renderItems();
      });
      return input;
    }

    function idBlock(item) {
      const wrap = document.createElement("div");
      const id = document.createElement("div");
      id.className = "item-id";
      id.textContent = item.id;
      const chips = document.createElement("div");
      chips.className = "chips";
      chips.append(chip(item.scope?.type || "scope"), chip(item.source?.type || "source"));
      wrap.append(id, chips);
      return wrap;
    }

    function contentBlock(item) {
      const wrap = document.createElement("div");
      const content = document.createElement("div");
      content.className = "content";
      content.textContent = item.content || "";
      const chips = document.createElement("div");
      chips.className = "chips";
      for (const tag of item.tags || []) chips.append(chip(tag));
      for (const path of item.accessPaths || []) chips.append(chip(path, "ok"));
      wrap.append(content, chips);
      return wrap;
    }

    function stateBlock(item) {
      const wrap = document.createElement("div");
      const reviewClass = item.reviewStatus === "approved" ? "ok" : item.reviewStatus === "rejected" ? "bad" : "warn";
      const trainingClass = item.training?.status === "queued" || item.training?.status === "trained" ? "ok" : item.training?.status === "blocked" ? "bad" : "warn";
      wrap.append(chip(item.reviewStatus, reviewClass), chip(item.training?.status || "not_queued", trainingClass));
      if (item.retention?.canTrain === false) wrap.append(chip("no-train", "bad"));
      return wrap;
    }

    function actionBlock(item) {
      const wrap = document.createElement("div");
      wrap.className = "item-actions";
      const approve = document.createElement("button");
      approve.textContent = "Approve";
      approve.addEventListener("click", () => reviewOne(item.id, "approved"));
      const queue = document.createElement("button");
      queue.textContent = "Queue";
      queue.addEventListener("click", () => queueOne(item.id));
      const reject = document.createElement("button");
      reject.textContent = "Reject";
      reject.className = "danger";
      reject.addEventListener("click", () => reviewOne(item.id, "rejected"));
      wrap.append(approve, queue, reject);
      return wrap;
    }

    function cell(child) {
      const td = document.createElement("td");
      if (child instanceof Node) td.append(child);
      else td.textContent = String(child);
      return td;
    }

    function text(value) {
      const span = document.createElement("span");
      span.textContent = value;
      return span;
    }

    function chip(value, tone) {
      const span = document.createElement("span");
      span.className = "chip" + (tone ? " " + tone : "");
      span.textContent = value;
      return span;
    }

    function showReport(value) {
      $("report").hidden = false;
      $("report").textContent = JSON.stringify(value, null, 2);
    }

    function setStatus(message, tone) {
      $("status").className = "status" + (tone ? " " + tone : "");
      $("status").textContent = message;
    }

    function compact(value) {
      const number = Number(value || 0);
      if (number >= 1_000_000_000) return (number / 1_000_000_000).toFixed(2) + "B";
      if (number >= 1_000_000) return (number / 1_000_000).toFixed(2) + "M";
      if (number >= 1_000) return (number / 1_000).toFixed(1) + "K";
      return String(number);
    }

    refresh();
  </script>
</body>
</html>`;
}
