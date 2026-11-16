'use strict';
/* AI ladder: what each TMS and EPM vendor's own public pages say its AI can do.
   Data lives in data/ai-capabilities.json, written by hand from public sources only. */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'ai-capabilities.json');
const RUNGS = [['answer', 'Answers'], ['act', 'Acts'], ['mcp', 'MCP'], ['build', 'Builds']];
const MARK = { available: '●', limited: '◐', announced: '○', none: '–' };
const WORD = { available: 'Live', limited: 'Limited or preview', announced: 'Announced', none: 'Not found' };

let data = null;
function load() {
  if (!data) data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return data;
}
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'k-phi';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(d) {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(d || '');
  if (!m) return '';
  return (m[2] ? MON[+m[2] - 1] + ' ' : '') + m[1];
}

/* compact form for the map: { "Kyriba": { answer: "available", ... , slug } } */
function aiMap() {
  const d = load(), out = {};
  for (const v of d.vendors) {
    if (v.self) continue;
    const r = { slug: slug(v.system) };
    for (const [k] of RUNGS) r[k] = v[k].s;
    out[v.system] = r;
    if (v.alias) out[v.alias] = r;
  }
  return { checked: d.checked, systems: out };
}

function row(v) {
  const cells = RUNGS.map(([k]) => {
    const c = v[k], dt = when(c.date);
    return '<td class="c ' + c.s + '" title="' + esc(WORD[c.s] + (c.note ? ': ' + c.note : '')) + '"><span class="m" aria-hidden="true">' + MARK[c.s] + '</span><span class="sr">' + WORD[c.s] + '</span>' + (dt && c.s !== 'none' ? '<small>' + dt + '</small>' : '') + '</td>';
  }).join('');
  const name = esc(v.system) + (v.alias ? ' <small class="al">now ' + esc(v.alias) + '</small>' : '');
  return '<tr id="' + slug(v.system) + '"><th scope="row"><a href="#src-' + slug(v.system) + '">' + name + '</a></th>' + cells + '</tr>';
}
function table(list, caption) {
  return '<div class="tw"><table><caption>' + esc(caption) + '</caption><thead><tr><th scope="col">System</th>' +
    RUNGS.map(([, l]) => '<th scope="col">' + l + '</th>').join('') + '</tr></thead><tbody>' + list.map(row).join('') + '</tbody></table></div>';
}
function sources(v) {
  const items = RUNGS.map(([k, l]) => {
    const c = v[k];
    if (c.s === 'none' && !c.note) return '';
    const txt = '<b>' + l + '</b> ' + esc(WORD[c.s]) + (c.date ? ', ' + when(c.date) : '') + (c.note ? '. ' + esc(c.note) : '');
    return '<li>' + txt + (c.src ? ' <a href="' + esc(c.src) + '" rel="noopener" target="_blank">source</a>' : '') + '</li>';
  }).filter(Boolean);
  if (v.other) items.push('<li>' + esc(v.other) + '</li>');
  if (!items.length) items.push('<li>Nothing found on the vendor\'s public pages for any of the four rungs.</li>');
  return '<section class="src" id="src-' + slug(v.system) + '"><h3>' + esc(v.system) + (v.self ? ' <small>runs this site</small>' : '') + '</h3><ul>' + items.join('') + '</ul></section>';
}

function aiPage(site) {
  const d = load();
  const others = d.vendors.filter(v => !v.self);
  /* alphabetical, not ranked: the page shows what is public, it does not score vendors */
  const by = seg => others.filter(v => v.segment === seg).sort((a, b) => a.system.localeCompare(b.system));
  const self = d.vendors.filter(v => v.self);
  const checked = new Date(d.checked + 'T12:00:00Z');
  const asof = checked.getUTCDate() + ' ' + MON[checked.getUTCMonth()] + ' ' + checked.getUTCFullYear();
  const desc = 'What TMS and EPM vendors\' own public pages say their AI can do: answer, act, MCP, build. Checked ' + asof + '.';
  const url = site + '/ai';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>AI on the Public Record · Treasury &amp; FP&amp;A Synapses</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article"><meta property="og:title" content="AI on the public record: TMS and EPM"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(site)}/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#07070f;--sheet:#13131f;--line:#23233a;--fg:#e8ecf5;--dim:#9a9ab8;--faint:#6a6a8e;--accent:#E6FF00;--live:#36d6a0;--lim:#8fb3ff;--ann:#ffb000;--link:#8fb3ff;color-scheme:dark;
  --font:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,Menlo,monospace}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f6fa;--sheet:#ffffff;--line:#dcdce8;--fg:#14142a;--dim:#4a4a68;--faint:#73738f;--accent:#5b4bd6;--live:#0f8a5f;--lim:#2f5fd0;--ann:#a36400;--link:#2f5fd0;color-scheme:light}}
:root[data-theme="light"]{--bg:#f6f6fa;--sheet:#ffffff;--line:#dcdce8;--fg:#14142a;--dim:#4a4a68;--faint:#73738f;--accent:#5b4bd6;--live:#0f8a5f;--lim:#2f5fd0;--ann:#a36400;--link:#2f5fd0;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:400 15px/1.55 var(--font)}
main{max-width:880px;margin:0 auto;padding-block:32px 64px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
a{color:var(--link)}
.back{font:500 12px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;text-decoration:none;color:var(--dim)}
h1{font-size:clamp(26px,5vw,38px);line-height:1.15;margin:18px 0 10px;text-wrap:balance}
h2{font-size:19px;margin:36px 0 10px}
.lede{color:var(--dim);max-width:64ch;margin:0 0 20px}
.asof{font:400 12px/1.4 var(--mono);color:var(--faint)}
.rungs{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin:22px 0}
.rungs div{background:var(--sheet);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
.rungs b{display:block;font:600 12px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:4px}
.rungs p{margin:0;color:var(--dim);font-size:13.5px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font:400 12.5px/1.4 var(--mono);color:var(--dim);margin:8px 0 4px}
.tw{overflow-x:auto;margin:10px 0;position:relative}
table{border-collapse:collapse;width:100%;min-width:300px;font-size:14px}
caption{text-align:left;font:600 12px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:0 0 8px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:center}
thead th:first-child{text-align:left}
thead th{font:500 11.5px/1.3 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
tbody th{text-align:left;font-weight:500}
tbody th a{color:var(--fg);text-decoration:none}
tbody th a:hover{text-decoration:underline}
.al{color:var(--faint);font-weight:400}
.c .m{font-size:16px;line-height:1}
.c small{display:block;font:400 10.5px/1.3 var(--mono);color:var(--faint);margin-top:2px}
.available .m{color:var(--live)}.limited .m{color:var(--lim)}.announced .m{color:var(--ann)}.none .m{color:var(--faint)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.self{margin-top:26px;border:1px dashed var(--line);border-radius:10px;padding:6px 10px 2px}
.self p{color:var(--dim);font-size:13.5px;margin:6px 4px 0}
.src{border-top:1px solid var(--line);padding:12px 0}
.src h3{font-size:15px;margin:0 0 6px}
.src h3 small{font:400 11px/1 var(--mono);color:var(--faint);margin-left:6px}
.src ul{margin:0;padding-left:18px;color:var(--dim);font-size:13.5px}
.src li{margin:3px 0}
.src b{color:var(--fg);font-weight:600}
.rules{color:var(--dim);font-size:13.5px;max-width:68ch}
@media (max-width:520px){th,td{padding:8px 4px}tbody th{font-size:13px}.al{display:block}thead th{font-size:10px;letter-spacing:.02em}}
footer{margin-top:40px;color:var(--faint);font-size:12.5px}
</style></head><body><main>
<a class="back" href="/">← Treasury &amp; FP&amp;A Synapses</a>
<h1>AI on the public record</h1>
<p class="lede">What each TMS and EPM vendor's own public pages, release notes and press releases say its AI can do today. Four rungs, the same rules for everyone, every cell sourced. Alphabetical, not ranked.</p>
<p class="asof">Checked ${esc(asof)}. A dash means we did not find it in public; it does not mean it does not exist.</p>
<div class="rungs">
<div><b>Answers</b><p>${esc(d.rungs.answer)}</p></div>
<div><b>Acts</b><p>${esc(d.rungs.act)}</p></div>
<div><b>MCP</b><p>${esc(d.rungs.mcp)}</p></div>
<div><b>Builds</b><p>${esc(d.rungs.build)}</p></div>
</div>
<div class="legend"><span><span style="color:var(--live)">●</span> Live</span><span><span style="color:var(--lim)">◐</span> Limited or preview</span><span><span style="color:var(--ann)">○</span> Announced</span><span><span style="color:var(--faint)">–</span> Not found</span></div>
<h2>Treasury management</h2>
${table(by('TMS'), 'TMS and treasury platforms')}
<h2>EPM and FP&amp;A</h2>
${table(by('EPM'), 'EPM and planning platforms')}
<div class="self">${table(self, 'The company that runs this site')}<p>K-φ runs this map, so it is shown apart. It is held to the same four rules and its sources are listed below like everyone else's.</p></div>
<h2>Sources</h2>
<p class="rules">Only the vendor's own pages, official directories (the Claude connector directory, the official MCP registry) and press coverage of announcements count. Third-party connectors built by someone else do not count as the vendor's MCP. A status can be out of date; it changes when a public source shows otherwise.</p>
${by('TMS').concat(by('EPM'), self).map(sources).join('\n')}
<footer>Part of <a href="/">Treasury &amp; FP&amp;A Synapses</a>. Public record only.</footer>
</main></body></html>`;
}

module.exports = { aiMap, aiPage, slug, load };
