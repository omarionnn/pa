// Connect the rest (src/connectafter.js, REASON_CONNECT_AFTER): the page the one follow-up link opens.
//
//   GET  /web/connect-all/{token}               each service: ✓ connected, or a button
//   POST /web/connect-all/{token}/go/{service}  make that service's own link now, 303 to it
//
// The token is the person's (hashed in connect_after_links, 14 days). Nothing is connected by opening
// the page; each button only makes the link the chat would have sent for that service, and that link
// keeps its own proof (Google's code gate, the card page's token, Amazon's sign-in link).
import { esc } from "./render.js";
import { webPage } from "./webkit.js";
import { PAPER_CSS, header, frame, headline, lede, label, para, go, actions } from "./paperkit.js";
import { SECURITY_HEADERS, sameOrigin } from "./websignin.js";
import * as ca from "../connectafter.js";

const CSS = `${PAPER_CSS}
.ca-list{list-style:none;margin:18px 0 0;padding:0;display:flex;flex-direction:column;gap:14px}
.ca-row{display:flex;align-items:center;justify-content:space-between;gap:14px;border-top:1px dashed var(--rule,#d9cfc0);padding-top:14px}
.ca-row b{display:block;font-weight:600}
.ca-row span{font-size:14px;line-height:1.45}
.ca-row form{margin:0;flex:0 0 auto}
.ca-ok{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.12em}`;

const html = (status, body) => ({ status, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body });

export function renderPage(token, rows) {
  const left = rows.filter((r) => !r.connected);
  const main = headline(left.length ? "Connect the rest." : "All connected.", left.length ? "Once, then I stop asking." : "Nothing left to do.", "ca-h")
    + lede(left.length ? "Tap one and you'll sign in on that service's own page. Skip anything you don't want." : "Everything I can use is connected. You can close this.")
    + `<ul class="ca-list">${rows.map((r) => `<li class="ca-row"><div><b>${esc(r.label)}</b><span>${esc(r.what)}</span></div>`
      + (r.connected
        ? `<span class="ca-ok">CONNECTED ✓</span>`
        : `<form method="post" action="/web/connect-all/${esc(token)}/go/${esc(r.service)}">${actions(go("Connect", { type: "submit" }))}</form>`)
      + `</li>`).join("")}</ul>`;
  const margin = label("NOTHING BOUGHT") + para("Connecting buys nothing. Anything that costs money still waits for your yes.")
    + label("YOUR CALL", { sp: true }) + para("Leave any of these off. If a task needs one later, I'll send that one link then.");
  return webPage({ title: "Reason — connect the rest", body: `${header()}<main class="pf">${frame({ main, margin })}</main>`, css: CSS });
}

const ended = () => webPage({
  title: "Reason — link",
  body: `${header()}<main class="pf">${frame({ main: headline("This link has run out.", "Nothing was lost.") + lede("Ask me in the chat and I'll send the link for whatever you want to connect.") })}</main>`,
  css: CSS,
});

/** The route. null = not this route. */
export async function connectAllRequest({ sub, method, headers = {}, log = () => {} }) {
  const m = /^([A-Za-z0-9_-]{20,64})(?:\/go\/([a-z]+))?$/.exec(String(sub ?? ""));
  if (!m) return null;
  const [, token, service] = m;
  const link = ca.linkFor(token);
  if (!link || !ca.allowedFor(link.conversation_id)) return html(410, ended());
  const c = link.conversation_id;
  if (!service) {
    if (method !== "GET" && method !== "HEAD") return html(405, ended());
    return html(200, renderPage(token, ca.pageView(c)));
  }
  if (method !== "POST" || !sameOrigin(headers)) return html(405, ended());
  const out = ca.serviceLink(c, service);
  log({ connect_all_go: service, ok: !!out.ok, why: out.why ?? "" });
  if (!out.ok) return html(200, renderPage(token, ca.pageView(c)));
  return { status: 303, headers: { ...SECURITY_HEADERS, location: out.url, "cache-control": "no-store" }, body: "" };
}
