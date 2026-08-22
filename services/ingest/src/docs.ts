/**
 * The error reference, served at GET /docs/errors.
 *
 * Every 4xx/5xx body the SDK emits links to
 * `https://octroi.ai/docs/errors#<code>` (§10). Serving the page from the
 * service means the links resolve the moment anything is deployed behind that
 * domain — a docs site can replace this later without changing a single
 * emitted URL.
 *
 * One entry per code the SDK actually emits. Adding a code without adding it
 * here fails the service's own test suite.
 */

export interface ErrorDoc {
  code: string;
  status: string;
  meaning: string;
  action: string;
}

export const ERROR_DOCS: ErrorDoc[] = [
  {
    code: "payment_required",
    status: "402",
    meaning: "First contact: the route costs money and the request carried no payment.",
    action:
      "Not an error. Read `accepts`, produce a payment with an x402 client, retry with the X-PAYMENT header.",
  },
  {
    code: "invalid_payment",
    status: "402",
    meaning: "The payment payload was missing, malformed, or failed facilitator verification.",
    action: "Rebuild the payment from a fresh challenge. Check the signature and the payload shape.",
  },
  {
    code: "expired",
    status: "402",
    meaning: "The payment authorization lapsed before it was verified.",
    action:
      "Sign a fresh authorization. If this recurs with fresh signatures, compare your clock to the facilitator's — `npx @octroi/gate doctor` measures exactly this.",
  },
  {
    code: "wrong_amount",
    status: "402",
    meaning: "The settled amount is less than the route's price.",
    action: "Authorize at least `maxAmountRequired` from the challenge. Prices can be dynamic per request.",
  },
  {
    code: "wrong_network",
    status: "402",
    meaning: "The payment was made on a network this route does not accept.",
    action: "Pay on one of the networks listed in the challenge's `accepts`.",
  },
  {
    code: "replay",
    status: "402",
    meaning: "This payment payload — or its settled transaction — was already used.",
    action: "Each request needs a fresh payment. A retry of a failed request is fine; a reuse of a settled one is not.",
  },
  {
    code: "rate_limited",
    status: "429",
    meaning: "Too many requests from this client IP or payer address (§9).",
    action: "Honour Retry-After. Sustained 429s mean you are polling a paid route like a free one.",
  },
  {
    code: "payer_denied",
    status: "403",
    meaning: "This payer address is on the merchant's denylist.",
    action: "There is nothing to retry. Contact the merchant if you believe this is an error.",
  },
  {
    code: "facilitator_unreachable",
    status: "503",
    meaning:
      "The payment facilitator could not be reached or gave no usable answer; the merchant runs fail_closed, so the request was not served.",
    action: "Retry after the Retry-After interval. Your payment was not consumed.",
  },
  {
    code: "invalid_config",
    status: "500",
    meaning: "The merchant's gate is misconfigured (for example, a price resolver threw).",
    action: "Merchant-side. Run `npx @octroi/gate doctor` against the same config.",
  },
  {
    code: "invalid_resource",
    status: "500",
    meaning: "The gate could not build an absolute URL for the x402 `resource` field.",
    action: "Merchant-side: pass `req.url` from the adapter or set `resourceBase` on the gate.",
  },
  {
    code: "no_scheme_available",
    status: "500",
    meaning: "No configured facilitator could produce a challenge for this route.",
    action: "Merchant-side: check the facilitator's networks against the gate's.",
  },
  {
    code: "unauthorized",
    status: "401",
    meaning: "Cloud API: the request carried no valid API key.",
    action: "Send `Authorization: Bearer <key>`. Missing and wrong keys get identical answers.",
  },
  {
    code: "invalid_body",
    status: "400",
    meaning: "Cloud API: the body was not valid JSON (or not valid gzip), or `events` was not an array.",
    action: "Client-side encoding bug; the SDK's ingest clients do not produce this.",
  },
  {
    code: "not_found",
    status: "404",
    meaning: "Cloud API: no such receipt, endpoint, or refundable record for this account.",
    action: "Check the id and that you are using the right account's key.",
  },
  {
    code: "already_refunded",
    status: "409",
    meaning: "Cloud API: this receipt is already marked refunded.",
    action: "Nothing to do — refund marking is idempotent in effect.",
  },
  {
    code: "config_unavailable",
    status: "503",
    meaning: "Cloud API: this deployment has no config signer, so signed remote config is off.",
    action: "Self-hosters: set OCT_CONFIG_SIGNER_JWK. SDK clients keep their local prices.",
  },
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function errorDocsHtml(): string {
  const rows = ERROR_DOCS.map(
    (doc) => `
  <section id="${esc(doc.code)}">
    <h2><a href="#${esc(doc.code)}">${esc(doc.code)}</a> <span class="status">${esc(doc.status)}</span></h2>
    <p>${esc(doc.meaning)}</p>
    <p class="action"><strong>What to do:</strong> ${esc(doc.action)}</p>
  </section>`,
  ).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Octroi — error reference</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0 auto; max-width: 720px; padding: 32px 20px 80px; line-height: 1.55; }
  h1 { font-size: 22px; letter-spacing: -0.01em; }
  .sub { color: #777; font-size: 14px; margin-bottom: 28px; }
  section { border-top: 1px solid rgba(127,127,127,.25); padding: 14px 0 4px; }
  h2 { font-size: 15px; font-family: ui-monospace, Menlo, monospace; margin: 0 0 6px; }
  h2 a { color: inherit; text-decoration: none; }
  h2 a:hover { text-decoration: underline; }
  .status { font-size: 12px; color: #777; font-weight: 400; margin-left: 8px; }
  p { margin: 4px 0; font-size: 14.5px; }
  .action { color: #555; } @media (prefers-color-scheme: dark) { .action { color: #aaa; } }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
</style>
</head>
<body>
<h1>Octroi error reference</h1>
<p class="sub">Every 4xx/5xx from a Octroi gate carries
<code>{ error: { code, message, doc } }</code> (on 402s, under
<code>errorDetail</code>, with the spec-shaped x402 <code>error</code> beside
it). The <code>doc</code> link points here.</p>
${rows}
</body>
</html>`;
}
