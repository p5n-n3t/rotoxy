/** Shared HTML helpers for the admin console. Every dynamic value must pass through esc(). */

export function esc(v: unknown): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function adminNav(base: string, active: string): string {
  const link = (href: string, label: string, key: string) =>
    `<a class="btn ${active === key ? "" : "secondary"}" href="${esc(base)}${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<div class="nav"><div class="brand"><div class="logo">T2</div><div><strong>Token2OAuth</strong><div class="eyebrow">Control plane</div></div></div><nav class="actions" aria-label="Admin">${link("/admin", "Pool", "pool")}${link("/admin/supervisor", "Supervisor", "supervisor")}${link("/admin/tools", "Tools", "tools")}${link("/admin/diagnostics", "Diagnostics", "diagnostics")}${link("/admin/security", "Security", "security")}<a class="btn secondary" href="${esc(base)}/">Gateway</a><form class="inline" method="post" action="${esc(base)}/admin/logout"><button class="secondary">Sign out</button></form></nav></div>`;
}

/** Inject the session CSRF token into every POST form of an admin page. */
export function withCsrf(html: string, csrf: string): string {
  return html.replace(/(<form\b[^>]*\bmethod="post"[^>]*>)/gi, `$1<input type="hidden" name="_csrf" value="${esc(csrf)}">`);
}

