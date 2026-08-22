/**
 * Dashboard v1 (§8): revenue by route/day, receipts list, tolls by payer,
 * reject rates, refund candidates.
 *
 * A single self-contained page that reads `/v1/dashboard`. Everything it shows
 * is derived from the event stream — there is no separate write path, which is
 * what §1.5 means by "the dashboard is a pure function of the event stream".
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Octroi</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b66; --line: #e4e4e0;
    --card: #fff; --accent: #1c6b45; --warn: #9a4b1f;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16161a; --fg:#ececea; --muted:#9a9a96; --line:#2c2c32;
            --card:#1e1e24; --accent:#5fbf8f; --warn:#e0915c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-size:15px; line-height:1.5; }
  header { padding:24px 28px 8px; }
  h1 { margin:0; font-size:20px; font-weight:650; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:13px; margin-top:2px; }
  main { padding:16px 28px 48px; display:grid; gap:20px; max-width:1100px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:0.04em; }
  .card .v { font-size:24px; font-weight:640; margin-top:4px; font-variant-numeric:tabular-nums; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  section h2 { margin:0; padding:12px 16px; font-size:13px; font-weight:640; text-transform:uppercase;
                letter-spacing:0.04em; color:var(--muted); border-bottom:1px solid var(--line); }
  .scroll { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th, td { text-align:left; padding:9px 16px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:560; font-size:12px; }
  tr:last-child td { border-bottom:none; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
  .empty { padding:20px 16px; color:var(--muted); font-size:13.5px; }
  .pill { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11.5px;
          border:1px solid var(--line); color:var(--muted); }
  .pill.warn { color:var(--warn); border-color:var(--warn); }
  .pill.ok { color:var(--accent); border-color:var(--accent); }
  form { padding:12px 16px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  input { font:inherit; padding:6px 9px; border:1px solid var(--line); border-radius:7px;
          background:var(--bg); color:var(--fg); min-width:280px; }
  button { font:inherit; padding:6px 12px; border:1px solid var(--line); border-radius:7px;
           background:var(--bg); color:var(--fg); cursor:pointer; }
  .err { color:var(--warn); padding:12px 16px; }
</style>
</head>
<body>
<header>
  <h1>Octroi</h1>
  <div class="sub" id="sub">dashboard v1 — revenue, receipts, rejects, refund candidates</div>
</header>
<main>
  <form id="auth">
    <input id="key" type="password" placeholder="API key" autocomplete="off" spellcheck="false">
    <button type="submit">Load</button>
    <span class="sub" id="status"></span>
  </form>
  <div id="body"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const usdc = (atomic) => "$" + (Number(atomic || 0) / 1e6).toFixed(4);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (s) => { s = String(s ?? ""); return s.length > 18 ? s.slice(0, 10) + "…" + s.slice(-6) : s; };

function table(cols, rows, render) {
  if (!rows.length) return '<div class="empty">Nothing yet.</div>';
  return '<div class="scroll"><table><thead><tr>' +
    cols.map((c) => '<th' + (c.num ? ' class="num"' : '') + '>' + esc(c.label) + '</th>').join("") +
    "</tr></thead><tbody>" + rows.map(render).join("") + "</tbody></table></div>";
}

async function load(key) {
  $("status").textContent = "loading…";
  let data;
  try {
    const res = await fetch("/v1/dashboard", { headers: { authorization: "Bearer " + key } });
    if (!res.ok) {
      $("status").textContent = res.status === 401 ? "invalid API key" : "error " + res.status;
      $("body").innerHTML = "";
      return;
    }
    data = await res.json();
  } catch (e) {
    $("status").textContent = "could not reach the server";
    return;
  }
  sessionStorage.setItem("tw_key", key);
  $("status").textContent = "";
  $("sub").textContent = data.merchant + " — " + data.events + " events";
  render(data, key);
}

function render(d, key) {
  const revenue = d.revenueByRouteDay.reduce((sum, r) => sum + Number(r.revenue), 0);
  const refunded = d.revenueByRouteDay.reduce((sum, r) => sum + Number(r.refunded), 0);

  $("body").innerHTML = [
    '<div class="cards">',
    card("Revenue", usdc(revenue)),
    card("Tolls", d.rejects.settled),
    card("Reject rate", (d.rejects.rate * 100).toFixed(1) + "%"),
    card("Refund candidates", d.refundCandidates.filter((r) => !r.refunded).length),
    "</div>",

    '<section><h2>Revenue by route / day</h2>' +
      table(
        [{ label: "Day" }, { label: "Route" }, { label: "Tolls", num: true },
         { label: "Revenue", num: true }, { label: "Refunded", num: true }],
        d.revenueByRouteDay,
        (r) => "<tr><td>" + esc(r.day) + "</td><td class='mono'>" + esc(r.route) +
          "</td><td class='num'>" + r.tolls + "</td><td class='num'>" + usdc(r.revenue) +
          "</td><td class='num'>" + (Number(r.refunded) ? usdc(r.refunded) : "—") + "</td></tr>",
      ) + "</section>",

    '<section><h2>Receipts</h2>' +
      table(
        [{ label: "Receipt" }, { label: "Route" }, { label: "Payer" },
         { label: "Amount", num: true }, { label: "When" }],
        d.receipts.slice(0, 100),
        (r) => "<tr><td class='mono'>" + esc(short(r.id)) + "</td><td class='mono'>" + esc(r.route) +
          "</td><td class='mono'>" + esc(short(r.payer)) + "</td><td class='num'>" + usdc(r.amount) +
          "</td><td>" + new Date(r.ts * 1000).toISOString().replace("T", " ").slice(0, 19) +
          "</td></tr>",
      ) + "</section>",

    '<section><h2>Refund candidates — paid, then failed</h2>' +
      table(
        [{ label: "Receipt" }, { label: "Route" }, { label: "Status", num: true },
         { label: "Amount", num: true }, { label: "" }],
        d.refundCandidates,
        (r) => "<tr><td class='mono'>" + esc(short(r.receipt_id)) + "</td><td class='mono'>" +
          esc(r.route) + "</td><td class='num'>" + r.status + "</td><td class='num'>" +
          usdc(r.amount) + "</td><td>" + (r.refunded
            ? "<span class='pill ok'>refunded</span>"
            : "<button data-refund='" + esc(r.receipt_id) + "'>Mark refunded</button>") +
          "</td></tr>",
      ) + "</section>",

    '<section><h2>Tolls by payer</h2>' +
      table(
        [{ label: "Payer" }, { label: "Tolls", num: true }, { label: "Amount", num: true }],
        d.tollsByPayer.slice(0, 50),
        (r) => "<tr><td class='mono'>" + esc(short(r.payer)) + "</td><td class='num'>" + r.tolls +
          "</td><td class='num'>" + usdc(r.amount) + "</td></tr>",
      ) + "</section>",

    '<section><h2>Rejects by code</h2>' +
      table(
        [{ label: "Code" }, { label: "Count", num: true }],
        Object.entries(d.rejects.byCode).map(([code, count]) => ({ code, count })),
        (r) => "<tr><td class='mono'>" + esc(r.code) + "</td><td class='num'>" + r.count + "</td></tr>",
      ) + "</section>",
  ].join("");

  for (const button of document.querySelectorAll("[data-refund]")) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      await fetch("/v1/refunds", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key },
        body: JSON.stringify({ receipt_id: button.dataset.refund, reason: "marked in dashboard" }),
      });
      load(key);
    });
  }
}

function card(k, v) {
  return '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + "</div></div>";
}

$("auth").addEventListener("submit", (e) => { e.preventDefault(); load($("key").value.trim()); });
const saved = sessionStorage.getItem("tw_key");
if (saved) { $("key").value = saved; load(saved); }
</script>
</body>
</html>`;
}
