// OpenWiki browser UI. Single-page app served inline by the worker.
// No CDN / npm deps. Vanilla HTML/CSS/JS.

export const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OpenWiki</title>
<style>
  :root{
    --bg:#0e0e11; --panel:#161619; --panel-2:#1c1c22; --border:#26262d;
    --text:#e7e7ec; --text-dim:#9a9aa5; --accent:#7c9cff; --accent-2:#a685ff;
    --danger:#ff6b6b;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;height:100%;background:var(--bg);color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;
    font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  button,input{font:inherit;color:inherit}
  button{cursor:pointer}

  #app{display:grid;grid-template-rows:48px 1fr;grid-template-columns:280px 1fr;
    grid-template-areas:"top top" "side main";height:100vh}
  .topbar{grid-area:top;display:flex;align-items:center;gap:16px;padding:0 16px;
    background:var(--panel);border-bottom:1px solid var(--border)}
  .brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.2px}
  .brand-dot{width:10px;height:10px;border-radius:50%;
    background:linear-gradient(135deg,var(--accent),var(--accent-2));
    box-shadow:0 0 12px rgba(124,156,255,.5)}
  .breadcrumb{color:var(--text-dim);font-size:13px;flex:0 1 auto;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .breadcrumb .sep{margin:0 8px;opacity:.5}
  .top-spacer{flex:1}
  .search{position:relative}
  .search input{width:280px;background:var(--panel-2);border:1px solid var(--border);
    border-radius:6px;padding:6px 10px;color:var(--text);outline:none;transition:border .15s}
  .search input:focus{border-color:var(--accent)}
  .search input::placeholder{color:var(--text-dim)}

  .sidebar{grid-area:side;background:var(--panel);border-right:1px solid var(--border);
    overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:20px}
  .side-section h3{margin:0 0 8px;font-size:11px;text-transform:uppercase;
    letter-spacing:.08em;color:var(--text-dim);font-weight:600}
  .newwiki{display:flex;flex-direction:column;gap:8px}
  .newwiki input{background:var(--panel-2);border:1px solid var(--border);
    border-radius:6px;padding:8px 10px;outline:none;color:var(--text)}
  .newwiki input:focus{border-color:var(--accent)}
  .newwiki button{background:linear-gradient(135deg,var(--accent),var(--accent-2));
    color:#0e0e11;border:0;border-radius:6px;padding:8px 12px;font-weight:600}
  .newwiki button:disabled{opacity:.4;cursor:not-allowed;filter:grayscale(.4)}

  .wikilist{display:flex;flex-direction:column;gap:2px}
  .wiki-item{padding:8px 10px;border-radius:6px;cursor:pointer;
    display:flex;flex-direction:column;gap:2px;border:1px solid transparent}
  .wiki-item:hover{background:var(--panel-2)}
  .wiki-item.active{background:var(--panel-2);border-color:var(--border)}
  .wiki-item .name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wiki-item .meta{font-size:11px;color:var(--text-dim)}
  .wiki-item .progressbar{margin-top:6px;height:4px;background:#2a2a33;
    border-radius:2px;overflow:hidden}
  .wiki-item .progressbar > div{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-2));
    transition:width .3s}

  .cat{margin-top:6px}
  .cat-head{display:flex;align-items:center;gap:6px;padding:6px 4px;cursor:pointer;
    color:var(--text-dim);font-size:12px;text-transform:uppercase;letter-spacing:.05em;
    font-weight:600;user-select:none}
  .cat-head .caret{display:inline-block;transition:transform .15s;font-size:9px;opacity:.6}
  .cat.collapsed .caret{transform:rotate(-90deg)}
  .cat.collapsed .pages{display:none}
  .pages{display:flex;flex-direction:column;gap:1px;margin-left:2px}
  .page-item{padding:5px 10px;border-radius:5px;cursor:pointer;color:var(--text);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;outline:none;
    border:1px solid transparent}
  .page-item:hover{background:var(--panel-2)}
  .page-item.active{background:var(--panel-2);color:var(--accent);border-color:var(--border)}
  .page-item:focus{border-color:var(--accent)}
  .page-snippet{font-size:11px;color:var(--text-dim);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 10px 4px}

  .main{grid-area:main;overflow-y:auto;padding:32px 48px 64px;max-width:900px;width:100%}
  .page-head{margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:16px}
  .page-title{margin:0 0 8px;font-size:28px;font-weight:700;letter-spacing:-.01em}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{background:var(--panel-2);border:1px solid var(--border);
    padding:2px 8px;border-radius:99px;font-size:11px;color:var(--text-dim)}
  .chip.cat{color:var(--accent)}

  .md h1,.md h2,.md h3,.md h4{margin:1.6em 0 .6em;font-weight:600;line-height:1.3}
  .md h1{font-size:1.8em;border-bottom:1px solid var(--border);padding-bottom:.3em}
  .md h2{font-size:1.4em}
  .md h3{font-size:1.15em}
  .md h4{font-size:1em;color:var(--text-dim)}
  .md p{margin:.7em 0}
  .md ul,.md ol{margin:.6em 0;padding-left:1.6em}
  .md li{margin:.2em 0}
  .md code{background:var(--panel-2);border:1px solid var(--border);
    padding:1px 5px;border-radius:4px;font-size:.9em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .md pre{background:var(--panel-2);border:1px solid var(--border);border-radius:6px;
    padding:12px 14px;overflow-x:auto;margin:.8em 0}
  .md pre code{background:transparent;border:0;padding:0;font-size:.88em;line-height:1.5}
  .md blockquote{border-left:3px solid var(--accent);
    background:rgba(124,156,255,.06);margin:.8em 0;padding:.4em 12px;color:var(--text-dim)}
  .md hr{border:0;border-top:1px solid var(--border);margin:1.5em 0}
  .md img{max-width:100%;border-radius:6px}
  .md a{color:var(--accent)}
  .md table{border-collapse:collapse;margin:.8em 0}
  .md th,.md td{border:1px solid var(--border);padding:6px 10px}

  .hero{display:flex;flex-direction:column;align-items:center;justify-content:center;
    text-align:center;height:100%;color:var(--text-dim);gap:12px}
  .hero h1{margin:0;font-size:28px;color:var(--text);
    background:linear-gradient(135deg,var(--accent),var(--accent-2));
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .hero p{margin:0;max-width:420px}

  .banner{position:fixed;top:60px;left:50%;transform:translateX(-50%);
    background:rgba(255,107,107,.14);border:1px solid var(--danger);
    color:#ffbcbc;padding:8px 14px;border-radius:6px;font-size:13px;z-index:100;
    box-shadow:0 8px 24px rgba(0,0,0,.4)}

  .spinner{width:14px;height:14px;border:2px solid var(--border);
    border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;
    display:inline-block;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}

  .phase{font-size:11px;color:var(--accent);text-transform:capitalize;margin-top:2px}
  .phase.error{color:var(--danger)}

  .footer{padding:16px 0 0;border-top:1px solid var(--border);margin-top:auto;
    font-size:12px;color:var(--text-dim)}
  .footer a{color:var(--text-dim)}
  .footer a:hover{color:var(--accent)}

  .modal-back{position:fixed;inset:0;background:rgba(0,0,0,.6);
    display:flex;align-items:center;justify-content:center;z-index:200}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:10px;
    max-width:520px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .modal h2{margin:0 0 10px}
  .modal button{margin-top:14px;background:var(--panel-2);border:1px solid var(--border);
    color:var(--text);border-radius:6px;padding:6px 12px}

  .empty{color:var(--text-dim);font-size:12px;padding:8px 4px}
</style>
</head>
<body>
<div id="app">
  <div class="topbar">
    <div class="brand"><span class="brand-dot"></span>OpenWiki</div>
    <div class="breadcrumb" id="breadcrumb"></div>
    <div class="top-spacer"></div>
    <div class="search">
      <input id="search" type="search" placeholder="Search this wiki\u2026" disabled />
    </div>
  </div>
  <aside class="sidebar">
    <div class="side-section">
      <h3>New wiki</h3>
      <form class="newwiki" id="newwiki-form">
        <input id="repo-url" placeholder="https://github.com/owner/repo" autocomplete="off" />
        <button type="submit" id="gen-btn" disabled>Generate</button>
      </form>
    </div>
    <div class="side-section">
      <h3>Wikis</h3>
      <div class="wikilist" id="wikilist"><div class="empty">Loading\u2026</div></div>
    </div>
    <div class="side-section" id="pages-section" style="display:none">
      <h3>Pages</h3>
      <div id="pagelist"></div>
    </div>
    <div class="footer">
      <a href="#" id="about-link">about openwiki</a>
    </div>
  </aside>
  <main class="main" id="main"></main>
</div>

<script>
(() => {
  'use strict';

  //--- state
  const state = {
    wikis: [],
    currentWikiId: null,
    currentWiki: null,      // full detail
    pages: [],              // pages for current wiki
    pagesByCat: new Map(),  // catId -> [pages]
    currentSlug: null,
    searchResults: null,    // null = show pages, [] = show empty results
    generating: new Map(),  // wiki_id -> {phase, progress, message}
    pollTimers: new Map(),
    collapsedCats: new Set(),
  };

  //--- helpers
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) n.setAttribute(k, '');
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    for (const k of kids) {
      if (k == null || k === false) continue;
      n.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    }
    return n;
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);

  async function api(path, opts) {
    const r = await fetch('/openwiki/api' + path, opts);
    let body = null;
    try { body = await r.json(); } catch(_) {}
    if (!r.ok) {
      const msg = (body && (body.error || body.message)) || (r.status + ' ' + r.statusText);
      throw new Error(msg);
    }
    return body;
  }

  let bannerTimer = null;
  function flashError(msg) {
    const existing = document.querySelector('.banner');
    if (existing) existing.remove();
    if (bannerTimer) clearTimeout(bannerTimer);
    const b = el('div', { class:'banner', text: msg });
    document.body.appendChild(b);
    bannerTimer = setTimeout(() => b.remove(), 6000);
  }

  //--- markdown renderer (self-contained, safe)
  function renderMarkdown(src, opts) {
    const wikiId = opts && opts.wikiId;
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let out = '';
    let i = 0;

    // Inline rendering with HTML escaping.
    function inline(text) {
      // Extract code spans first (protect from other rules).
      const spans = [];
      let t = text.replace(/\`([^\`\n]+)\`/g, (_, code) => {
        spans.push('<code>' + escapeHtml(code) + '</code>');
        return '\u0001' + (spans.length - 1) + '\u0001';
      });
      // Escape remaining html.
      t = escapeHtml(t);
      // Images: ![alt](src)
      t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
        if (!/^(https?:|data:|\/)/i.test(src)) return '';
        return '<img alt="' + escapeHtml(alt) + '" src="' + escapeHtml(src) + '" />';
      });
      // Links: [text](url)
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
        let href = url;
        let target = '';
        if (/^https?:/i.test(url)) {
          target = ' target="_blank" rel="noopener noreferrer"';
        } else if (/^(\.\/)?([\w\-]+)\.md$/i.test(url) && wikiId) {
          const m = url.match(/([\w\-]+)\.md$/i);
          href = '#/wiki/' + wikiId + '/page/' + m[1];
        } else if (url.startsWith('#')) {
          href = url;
        } else {
          // relative/unknown -> keep as text
          return escapeHtml(label);
        }
        return '<a href="' + escapeHtml(href) + '"' + target + '>' + label + '</a>';
      });
      // Bold **x** then italic *x*.
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
      // Restore code spans.
      t = t.replace(/\u0001(\d+)\u0001/g, (_, idx) => spans[+idx]);
      return t;
    }

    function closeLists(stack) {
      let s = '';
      while (stack.length) s += '</li></' + stack.pop().type + '>';
      return s;
    }

    const listStack = []; // {type:'ul'|'ol', indent}
    let para = [];
    function flushPara() {
      if (para.length) {
        out += '<p>' + inline(para.join(' ')) + '</p>';
        para = [];
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^\`\`\`\s*([\w.+-]*)\s*$/);
      if (fence) {
        flushPara();
        out += closeLists(listStack);
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^\`\`\`\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // consume closing fence
        const cls = lang ? ' class="lang-' + escapeHtml(lang) + '"' : '';
        out += '<pre><code' + cls + '>' + escapeHtml(buf.join('\n')) + '</code></pre>';
        continue;
      }

      // blank line
      if (/^\s*$/.test(line)) {
        flushPara();
        out += closeLists(listStack);
        i++;
        continue;
      }

      // heading
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara();
        out += closeLists(listStack);
        const lvl = h[1].length;
        out += '<h' + lvl + '>' + inline(h[2].trim()) + '</h' + lvl + '>';
        i++;
        continue;
      }

      // hr
      if (/^\s{0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushPara();
        out += closeLists(listStack);
        out += '<hr/>';
        i++;
        continue;
      }

      // blockquote (consume run)
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        out += closeLists(listStack);
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out += '<blockquote>' + inline(buf.join(' ')) + '</blockquote>';
        continue;
      }

      // list item
      const li = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
      if (li) {
        flushPara();
        const indent = li[1].length;
        const type = /\d/.test(li[2]) ? 'ol' : 'ul';
        // pop deeper lists
        while (listStack.length && listStack[listStack.length - 1].indent > indent) {
          out += '</li></' + listStack.pop().type + '>';
        }
        // same-level: close previous li
        const top = listStack[listStack.length - 1];
        if (top && top.indent === indent) {
          if (top.type !== type) {
            out += '</li></' + listStack.pop().type + '>';
            out += '<' + type + '>';
            listStack.push({ type, indent });
          } else {
            out += '</li>';
          }
        } else if (!top || top.indent < indent) {
          out += '<' + type + '>';
          listStack.push({ type, indent });
        }
        out += '<li>' + inline(li[3]);
        i++;
        continue;
      }

      // paragraph accumulate
      para.push(line.trim());
      i++;
    }
    flushPara();
    out += closeLists(listStack);
    return out;
  }

  //--- URL hash routing
  function parseHash() {
    const h = location.hash || '';
    const m = h.match(/^#\/wiki\/([^\/]+)(?:\/page\/(.+))?$/);
    if (!m) return { wikiId: null, slug: null };
    return { wikiId: m[1], slug: m[2] || null };
  }
  function setHash(wikiId, slug) {
    const target = '#/wiki/' + wikiId + (slug ? '/page/' + slug : '');
    if (location.hash !== target) {
      history.replaceState(null, '', target);
    }
  }

  //--- wiki list
  async function loadWikis() {
    try {
      state.wikis = await api('/wikis');
    } catch (e) {
      flashError('Failed to load wikis: ' + e.message);
      state.wikis = [];
    }
    renderWikiList();
  }

  function renderWikiList() {
    const root = $('wikilist');
    root.textContent = '';
    if (!state.wikis.length && !state.generating.size) {
      root.appendChild(el('div', { class:'empty', text:'No wikis yet.' }));
      return;
    }
    // generating entries first
    for (const [wid, gen] of state.generating.entries()) {
      if (state.wikis.find((w) => w.id === wid)) continue;
      root.appendChild(renderWikiItem({ id: wid, repo_name: gen.repo_name || wid, page_count: 0 }, gen));
    }
    for (const w of state.wikis) {
      const gen = state.generating.get(w.id);
      root.appendChild(renderWikiItem(w, gen));
    }
  }

  function renderWikiItem(w, gen) {
    const node = el('div', {
      class: 'wiki-item' + (state.currentWikiId === w.id ? ' active' : ''),
      onclick: () => selectWiki(w.id),
    },
      el('div', { class:'name', text: w.repo_name || w.id }),
      el('div', { class:'meta', text: (w.page_count || 0) + ' pages' + (w.category_count ? ' \u00b7 ' + w.category_count + ' categories' : '') }),
    );
    if (gen && gen.phase && gen.phase !== 'ready') {
      const pct = Math.round((gen.progress || 0) * 100);
      node.appendChild(el('div', { class:'phase' + (gen.phase === 'error' ? ' error' : ''),
        text: (gen.phase === 'error' ? 'error: ' + (gen.message || 'failed') : gen.phase + ' \u2014 ' + pct + '%') }));
      if (gen.phase !== 'error') {
        const bar = el('div', { class:'progressbar' }, el('div', { style: 'width:' + pct + '%' }));
        node.appendChild(bar);
      }
    }
    return node;
  }

  //--- generation flow
  async function generateWiki(repoUrl) {
    let resp;
    try {
      resp = await api('/wikis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo_url: repoUrl }),
      });
    } catch (e) {
      flashError('Generate failed: ' + e.message);
      return;
    }
    const wid = resp.wiki_id;
    state.generating.set(wid, { phase: resp.status || 'cloning', progress: 0, repo_name: repoUrl.split('/').slice(-1)[0] });
    renderWikiList();
    pollStatus(wid);
  }

  function pollStatus(wid) {
    if (state.pollTimers.has(wid)) return;
    const tick = async () => {
      let st;
      try {
        st = await api('/wikis/' + wid + '/status');
      } catch (e) {
        state.generating.set(wid, { phase: 'error', progress: 0, message: e.message });
        renderWikiList();
        clearInterval(state.pollTimers.get(wid));
        state.pollTimers.delete(wid);
        return;
      }
      state.generating.set(wid, {
        phase: st.phase,
        progress: st.progress || 0,
        message: st.message || st.error,
        repo_name: state.generating.get(wid) && state.generating.get(wid).repo_name,
      });
      renderWikiList();
      if (st.phase === 'ready' || st.phase === 'error') {
        clearInterval(state.pollTimers.get(wid));
        state.pollTimers.delete(wid);
        if (st.phase === 'error') {
          flashError('Generation failed: ' + (st.error || st.message || 'unknown'));
        } else {
          state.generating.delete(wid);
          await loadWikis();
          selectWiki(wid);
        }
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    state.pollTimers.set(wid, t);
  }

  //--- select wiki / page
  async function selectWiki(id, slugHint) {
    if (state.currentWikiId !== id) {
      state.currentWikiId = id;
      state.currentWiki = null;
      state.pages = [];
      state.pagesByCat = new Map();
      state.currentSlug = null;
      state.searchResults = null;
    }
    renderWikiList();
    setHash(id, slugHint || null);
    $('search').disabled = false;
    try {
      const [wiki, pages] = await Promise.all([
        api('/wikis/' + id),
        api('/wikis/' + id + '/pages'),
      ]);
      state.currentWiki = wiki;
      state.pages = pages;
      groupPages();
    } catch (e) {
      flashError('Failed to load wiki: ' + e.message);
      return;
    }
    renderBreadcrumb();
    renderPageList();
    // pick a page
    let target = slugHint;
    if (!target || !state.pages.find((p) => p.slug === target)) {
      const prefer = state.pages.find((p) => p.slug === 'overview')
        || state.pages.find((p) => p.slug === 'readme')
        || state.pages[0];
      target = prefer && prefer.slug;
    }
    if (target) selectPage(target);
    else renderMain(null);
  }

  function groupPages() {
    const byCat = new Map();
    const cats = (state.currentWiki && state.currentWiki.categories) || [];
    for (const c of cats) byCat.set(c.id, []);
    for (const p of state.pages) {
      const cid = p.category || 'uncategorized';
      if (!byCat.has(cid)) byCat.set(cid, []);
      byCat.get(cid).push(p);
    }
    state.pagesByCat = byCat;
  }

  function renderBreadcrumb() {
    const b = $('breadcrumb');
    b.textContent = '';
    if (!state.currentWiki) return;
    b.appendChild(el('span', { text: state.currentWiki.repo_name || state.currentWiki.id }));
    if (state.currentSlug) {
      const p = state.pages.find((x) => x.slug === state.currentSlug);
      if (p) {
        b.appendChild(el('span', { class:'sep', text:'/' }));
        b.appendChild(el('span', { text: p.title || p.slug }));
      }
    }
  }

  function renderPageList() {
    const root = $('pagelist');
    root.textContent = '';
    $('pages-section').style.display = state.currentWikiId ? '' : 'none';
    if (!state.currentWikiId) return;

    if (state.searchResults !== null) {
      if (!state.searchResults.length) {
        root.appendChild(el('div', { class:'empty', text:'No results.' }));
        return;
      }
      for (const r of state.searchResults) {
        const item = el('div', {
          class: 'page-item' + (r.slug === state.currentSlug ? ' active' : ''),
          tabindex: '0',
          onclick: () => selectPage(r.slug),
          onkeydown: (e) => pageKey(e, r.slug),
        }, r.title || r.slug);
        root.appendChild(item);
        if (r.snippet) root.appendChild(el('div', { class:'page-snippet', text: r.snippet }));
      }
      return;
    }

    const cats = (state.currentWiki && state.currentWiki.categories) || [];
    const seen = new Set();
    for (const c of cats) {
      seen.add(c.id);
      root.appendChild(renderCategory(c.id, c.title, state.pagesByCat.get(c.id) || []));
    }
    // uncategorized / extras
    for (const [cid, arr] of state.pagesByCat.entries()) {
      if (seen.has(cid)) continue;
      root.appendChild(renderCategory(cid, cid, arr));
    }
  }

  function renderCategory(cid, title, pages) {
    const collapsed = state.collapsedCats.has(cid);
    const node = el('div', { class: 'cat' + (collapsed ? ' collapsed' : '') });
    const head = el('div', { class:'cat-head',
      onclick: () => {
        if (state.collapsedCats.has(cid)) state.collapsedCats.delete(cid);
        else state.collapsedCats.add(cid);
        renderPageList();
      },
    },
      el('span', { class:'caret', text: '\u25BC' }),
      el('span', { text: title }),
    );
    node.appendChild(head);
    const ul = el('div', { class:'pages' });
    for (const p of pages) {
      ul.appendChild(el('div', {
        class: 'page-item' + (p.slug === state.currentSlug ? ' active' : ''),
        tabindex: '0',
        'data-slug': p.slug,
        onclick: () => selectPage(p.slug),
        onkeydown: (e) => pageKey(e, p.slug),
      }, p.title || p.slug));
    }
    node.appendChild(ul);
    return node;
  }

  function pageKey(e, slug) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPage(slug); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(document.querySelectorAll('#pagelist .page-item'));
    const idx = items.findIndex((n) => n === e.target);
    if (idx < 0) return;
    const next = items[idx + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  }

  async function selectPage(slug) {
    if (!state.currentWikiId) return;
    state.currentSlug = slug;
    setHash(state.currentWikiId, slug);
    renderPageList();
    renderBreadcrumb();
    renderMain('loading');
    try {
      const page = await api('/wikis/' + state.currentWikiId + '/pages/' + encodeURIComponent(slug));
      renderMain(page);
    } catch (e) {
      flashError('Failed to load page: ' + e.message);
      renderMain(null);
    }
  }

  function renderMain(page) {
    const root = $('main');
    root.textContent = '';
    if (page === 'loading') {
      root.appendChild(el('div', { class:'hero' }, el('div', { class:'spinner' })));
      return;
    }
    if (!page) {
      if (!state.wikis.length && !state.generating.size) {
        root.appendChild(el('div', { class:'hero' },
          el('h1', { text:'OpenWiki' }),
          el('p', { text:'Enter a repo URL to get started.' }),
          el('p', { text:'OpenWiki generates a browsable knowledge base from any source repository.' }),
        ));
      } else {
        root.appendChild(el('div', { class:'hero' },
          el('p', { text:'Select a wiki from the left to browse it.' })));
      }
      return;
    }
    const head = el('div', { class:'page-head' });
    head.appendChild(el('h1', { class:'page-title', text: page.title || page.slug }));
    const chips = el('div', { class:'chips' });
    if (page.category) chips.appendChild(el('span', { class:'chip cat', text: page.category }));
    for (const sp of (page.source_paths || [])) chips.appendChild(el('span', { class:'chip', text: sp }));
    head.appendChild(chips);
    root.appendChild(head);
    const body = el('div', { class:'md' });
    body.innerHTML = renderMarkdown(page.markdown || '', { wikiId: state.currentWikiId });
    // rewrite same-page anchor links to be safe
    root.appendChild(body);
  }

  //--- search
  let searchTimer = null;
  function onSearchInput(e) {
    const q = e.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    if (!q) {
      state.searchResults = null;
      renderPageList();
      return;
    }
    if (!state.currentWikiId) return;
    searchTimer = setTimeout(async () => {
      try {
        const res = await api('/wikis/' + state.currentWikiId + '/search?q=' + encodeURIComponent(q));
        state.searchResults = res || [];
        renderPageList();
      } catch (err) {
        flashError('Search failed: ' + err.message);
      }
    }, 250);
  }

  //--- about modal
  function openAbout() {
    const back = el('div', { class:'modal-back', onclick: (e) => { if (e.target === back) back.remove(); } });
    const box = el('div', { class:'modal' },
      el('h2', { text:'About OpenWiki' }),
      el('p', { text:'OpenWiki turns any code repository into a browsable, LLM-generated knowledge base \u2014 categories, pages, and searchable content, produced from the source itself.' }),
      el('p', {}, 'Inspired by ',
        el('a', { href:'https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f', target:'_blank', rel:'noopener noreferrer', text:'Karpathy\u2019s gist on repo-to-wiki generation' }),
        '.'),
      el('button', { onclick: () => back.remove(), text:'Close' }),
    );
    back.appendChild(box);
    document.body.appendChild(back);
  }

  //--- init
  function bindUI() {
    const input = $('repo-url');
    const btn = $('gen-btn');
    input.addEventListener('input', () => { btn.disabled = !input.value.trim(); });
    $('newwiki-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      btn.disabled = true;
      generateWiki(v);
    });
    $('search').addEventListener('input', onSearchInput);
    $('about-link').addEventListener('click', (e) => { e.preventDefault(); openAbout(); });
    window.addEventListener('hashchange', onHashChange);
  }

  function onHashChange() {
    const { wikiId, slug } = parseHash();
    if (!wikiId) return;
    if (wikiId !== state.currentWikiId) {
      selectWiki(wikiId, slug);
    } else if (slug && slug !== state.currentSlug) {
      selectPage(slug);
    }
  }

  async function boot() {
    bindUI();
    await loadWikis();
    const { wikiId, slug } = parseHash();
    if (wikiId) {
      selectWiki(wikiId, slug);
    } else {
      renderMain(null);
    }
  }

  boot();
})();
</script>
</body>
</html>`;
