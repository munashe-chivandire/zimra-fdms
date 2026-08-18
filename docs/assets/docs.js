/* zimra-fdms — documentation page: syntax highlighting, scrollspy, on-this-page, spotlight search */

const body = document.body;

/* ---------- sidebar drawer ---------- */
const scrim = document.getElementById('scrim');
const closeSb = () => body.classList.remove('sb-open');
document.getElementById('dhmenu').addEventListener('click', () => body.classList.toggle('sb-open'));
scrim.addEventListener('click', closeSb);

/* ---------- syntax highlighting ---------- */
const KEYWORDS = new Set(('import export from const let var await async function return new class implements ' +
'interface type extends if else for while try catch finally throw of in as void null undefined true false ' +
'private public readonly constructor typeof instanceof do switch case break continue default this satisfies').split(' '));

function tsTokens(line, out) {
  const re = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1]) out(m[1], 'tc');
    else if (m[2]) out(m[2], 'ts');
    else if (m[3]) out(m[3], 'tn');
    else if (m[4]) out(m[4], KEYWORDS.has(m[4]) ? 'tk' : (line[re.lastIndex] === '(' ? 'tf' : ''));
    else out(m[0], '');
  }
}
function shTokens(line, out) {
  const re = /(#.*$)|("(?:[^"\\]|\\.)*"|'[^']*')|(^\s*[\w./-]+)|(--?[A-Za-z][\w-]*)|([\s\S])/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1]) out(m[1], 'tc');
    else if (m[2]) out(m[2], 'ts');
    else if (m[3]) out(m[3], 'tf');
    else if (m[4]) out(m[4], 'tk');
    else out(m[0], '');
  }
}
function jsonTokens(line, out) {
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(\b-?\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([\s\S])/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1]) { out(m[1], m[2] ? 'tf' : 'ts'); if (m[2]) out(m[2], ''); }
    else if (m[3]) out(m[3], 'tn');
    else if (m[4]) out(m[4], 'tk');
    else out(m[0], '');
  }
}
const TOKENIZERS = { ts: tsTokens, js: tsTokens, sh: shTokens, json: jsonTokens };
const LANG_LABEL = { ts: 'TypeScript', js: 'JavaScript', sh: 'Shell', json: 'JSON', txt: 'Format' };

function parseHl(spec) {
  const set = new Set();
  if (!spec) return set;
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(n => parseInt(n.trim(), 10));
    if (isNaN(a)) continue;
    for (let i = a; i <= (isNaN(b) ? a : b); i++) set.add(i);
  }
  return set;
}

document.querySelectorAll('.codewin').forEach(win => {
  const codeEl = win.querySelector('code');
  if (!codeEl) return;
  const raw = codeEl.textContent.replace(/\s+$/, '');
  const lang = (win.dataset.lang || 'ts').toLowerCase();
  const tokenize = TOKENIZERS[lang] || null;
  const hl = parseHl(win.dataset.hl);

  /* window chrome */
  const bar = document.createElement('div');
  bar.className = 'term-bar';
  bar.innerHTML = '<span></span><span></span><span></span>';
  if (win.dataset.file) {
    const b = document.createElement('b');
    b.textContent = win.dataset.file;
    bar.appendChild(b);
  }
  const tag = document.createElement('span');
  tag.className = 'lang';
  tag.textContent = LANG_LABEL[lang] || lang;
  bar.appendChild(tag);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copybtn';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(raw).then(() => {
      copy.textContent = 'Copied';
      copy.classList.add('ok');
      setTimeout(() => { copy.textContent = 'Copy'; copy.classList.remove('ok'); }, 1600);
    }).catch(() => {
      copy.textContent = 'Failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
    });
  });
  bar.appendChild(copy);
  win.insertBefore(bar, win.firstChild);

  /* line-numbered, tokenised body */
  codeEl.textContent = '';
  raw.split('\n').forEach((line, i) => {
    const ln = document.createElement('span');
    ln.className = 'ln' + (hl.has(i + 1) ? ' hl' : '');
    if (line.trim() === '') {
      ln.innerHTML = '&nbsp;';
    } else if (tokenize) {
      tokenize(line, (text, cls) => {
        if (!cls) { ln.appendChild(document.createTextNode(text)); return; }
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        ln.appendChild(s);
      });
    } else {
      ln.textContent = line;
    }
    /* .ln is display:block, so no newline text node — it would add a blank line inside <pre> */
    codeEl.appendChild(ln);
  });
});

/* ---------- headings get ids ---------- */
const sections = [...document.querySelectorAll('.doc-sec')];
const slug = t => t.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
sections.forEach(sec => {
  sec.querySelectorAll('h3').forEach(h => { if (!h.id) h.id = sec.id + '--' + slug(h.textContent); });
});

/* ---------- on this page ---------- */
const tocNav = document.getElementById('tocnav');
function buildToc(sec) {
  tocNav.innerHTML = '';
  sec.querySelectorAll('h3').forEach(h => {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent.replace(/#$/, '');
    tocNav.appendChild(a);
  });
}

/* ---------- scrollspy ---------- */
const sbLinks = [...document.querySelectorAll('#sbnav a')];
const byHash = new Map(sbLinks.map(a => [a.getAttribute('href'), a]));
let currentSec = null;

function setActive(sec) {
  if (!sec || sec === currentSec) return;
  currentSec = sec;
  sbLinks.forEach(a => a.classList.remove('active'));
  const link = byHash.get('#' + sec.id);
  if (link) {
    link.classList.add('active');
    const sb = document.getElementById('sidebar');
    const top = link.offsetTop;
    const bottom = top + link.offsetHeight;
    if (top < sb.scrollTop || bottom > sb.scrollTop + sb.clientHeight) sb.scrollTop = top - sb.clientHeight / 2;
  }
  buildToc(sec);
}

function onScroll() {
  const line = window.scrollY + 140;
  let active = sections[0];
  for (const sec of sections) { if (sec.offsetTop <= line) active = sec; }
  setActive(active);

  const subs = [...currentSec.querySelectorAll('h3')];
  let activeSub = null;
  for (const h of subs) { if (h.getBoundingClientRect().top <= 160) activeSub = h; }
  tocNav.querySelectorAll('a').forEach(a => {
    a.classList.toggle('active', !!activeSub && a.getAttribute('href') === '#' + activeSub.id);
  });

  const max = document.documentElement.scrollHeight - window.innerHeight;
  document.getElementById('progress').style.transform = 'scaleX(' + (max > 0 ? window.scrollY / max : 0) + ')';
}
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', onScroll);
onScroll();

sbLinks.forEach(a => a.addEventListener('click', closeSb));

/* ==================================================================
   Spotlight search
   ================================================================== */
const spot = document.getElementById('spot');
const spotInput = document.getElementById('spotinput');
const spotResults = document.getElementById('spotresults');
const spotCount = document.getElementById('spotcount');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
document.getElementById('spotkbd').textContent = isMac ? '⌘K' : 'Ctrl K';

/* --- build the index once, from the rendered page --- */
const INDEX = [];

/* Badges and anchor marks are decoration — they must not end up glued onto indexed titles. */
function cleanText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.badge, .anchor').forEach(n => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}
sections.forEach(sec => {
  const secTitle = cleanText(sec.querySelector('h2'));

  INDEX.push({ kind: 'section', icon: 'ph-bookmark-simple', title: secTitle, group: 'Sections', text: '', id: sec.id, weight: 0 });

  let anchor = sec.id;
  let heading = secTitle;
  sec.querySelectorAll('h3, h4, p, li, .api > h4, tbody tr').forEach(el => {
    const tag = el.tagName;
    const text = cleanText(el);
    if (!text) return;

    if (tag === 'H3') {
      anchor = el.id || sec.id;
      heading = text;
      INDEX.push({ kind: 'heading', icon: 'ph-text-h', title: heading, group: secTitle, text: '', id: anchor, weight: 1 });
      return;
    }
    if (tag === 'H4') {
      INDEX.push({ kind: 'member', icon: 'ph-code', title: text, group: secTitle, text: '', id: anchor, weight: 1 });
      return;
    }
    /* A table row is one fact: the first cell names it, the rest explains it.
       Indexing cells separately would drop short but highly searchable keys
       like RCPT010, --profile or MoneyType. */
    if (tag === 'TR') {
      const cells = [...el.children].map(c => cleanText(c)).filter(Boolean);
      if (!cells.length) return;
      INDEX.push({ kind: 'row', icon: 'ph-rows', title: cells[0], group: secTitle,
        text: cells.slice(1).join(' — '), id: anchor, weight: 2 });
      return;
    }
    if (text.length < 12) return;
    INDEX.push({ kind: 'text', icon: 'ph-article', title: heading, group: secTitle, text, id: anchor, weight: 3 });
  });
});

/* --- scoring --- */
function score(entry, terms) {
  const title = entry.title.toLowerCase();
  const text = entry.text.toLowerCase();
  let total = 0;
  for (const term of terms) {
    const inTitle = title.indexOf(term);
    const inText = text.indexOf(term);
    if (inTitle === -1 && inText === -1) return -1;
    if (inTitle === 0) total += 12;
    else if (inTitle > 0) total += title[inTitle - 1] === ' ' ? 9 : 6;
    if (inText > -1) total += 2;
  }
  return total - entry.weight;
}

function mark(text, terms, max) {
  let snippet = text;
  if (max && text.length > max) {
    const first = terms.map(t => text.toLowerCase().indexOf(t)).filter(i => i > -1).sort((a, b) => a - b)[0] || 0;
    const start = Math.max(0, first - 40);
    snippet = (start > 0 ? '…' : '') + text.slice(start, start + max);
  }
  const frag = document.createDocumentFragment();
  const re = new RegExp('(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig');
  let last = 0, m;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(snippet.slice(last, m.index)));
    const el = document.createElement('mark');
    el.textContent = m[0];
    frag.appendChild(el);
    last = m.index + m[0].length;
  }
  if (last < snippet.length) frag.appendChild(document.createTextNode(snippet.slice(last)));
  return frag;
}

let hits = [], cursor = 0;

function renderHits(terms) {
  spotResults.innerHTML = '';
  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'spot-empty';
    empty.innerHTML = '<b>No matches</b>Try a method name, an error code, or a concept like "hash chain".';
    spotResults.appendChild(empty);
    spotCount.textContent = '';
    return;
  }
  let lastGroup = null;
  hits.forEach((hit, i) => {
    if (hit.group !== lastGroup) {
      lastGroup = hit.group;
      const g = document.createElement('div');
      g.className = 'spot-group';
      g.textContent = hit.group;
      spotResults.appendChild(g);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'spot-hit' + (i === cursor ? ' on' : '');
    btn.dataset.i = i;

    const t = document.createElement('div');
    t.className = 't';
    const ic = document.createElement('i');
    ic.className = 'ph-light ' + hit.icon;
    t.appendChild(ic);
    const label = document.createElement('span');
    label.appendChild(mark(hit.title, terms, 0));
    t.appendChild(label);
    btn.appendChild(t);

    if (hit.text) {
      const s = document.createElement('div');
      s.className = 's';
      s.appendChild(mark(hit.text, terms, 150));
      btn.appendChild(s);
    }
    btn.addEventListener('click', () => go(i));
    btn.addEventListener('mousemove', () => {
      if (cursor === i) return;
      cursor = i;
      spotResults.querySelectorAll('.spot-hit').forEach(b => b.classList.toggle('on', +b.dataset.i === cursor));
    });
    spotResults.appendChild(btn);
  });
  spotCount.textContent = hits.length + (hits.length === 1 ? ' result' : ' results');
}

function search(q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) { hits = []; cursor = 0; renderHits(terms); return; }
  const scored = [];
  const seen = new Set();
  for (const entry of INDEX) {
    const s = score(entry, terms);
    if (s < 0) continue;
    const key = entry.kind + '|' + entry.title + '|' + entry.text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ ...entry, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  hits = scored.slice(0, 20);
  cursor = 0;
  renderHits(terms);
}

function go(i) {
  const hit = hits[i];
  if (!hit) return;
  closeSpot();
  const target = document.getElementById(hit.id);
  if (!target) return;
  history.replaceState(null, '', '#' + hit.id);
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('hit');
  void target.offsetWidth;
  target.classList.add('hit');
  setTimeout(() => target.classList.remove('hit'), 1800);
}

function openSpot() {
  spot.hidden = false;
  body.style.overflow = 'hidden';
  spotInput.value = '';
  search('');
  spotInput.focus();
}
function closeSpot() {
  spot.hidden = true;
  body.style.overflow = '';
}

document.getElementById('spotopen').addEventListener('click', openSpot);
document.querySelectorAll('[data-spot-close]').forEach(el => el.addEventListener('click', closeSpot));
spotInput.addEventListener('input', () => search(spotInput.value.trim()));

spotInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
    e.preventDefault();
    if (!hits.length) return;
    cursor = (cursor + 1) % hits.length;
  } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
    e.preventDefault();
    if (!hits.length) return;
    cursor = (cursor - 1 + hits.length) % hits.length;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    go(cursor);
    return;
  } else {
    return;
  }
  spotResults.querySelectorAll('.spot-hit').forEach(b => b.classList.toggle('on', +b.dataset.i === cursor));
  const on = spotResults.querySelector('.spot-hit.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
});

document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    spot.hidden ? openSpot() : closeSpot();
    return;
  }
  if (e.key === '/' && !typing && spot.hidden) {
    e.preventDefault();
    openSpot();
    return;
  }
  if (e.key === 'Escape') {
    if (!spot.hidden) closeSpot();
    closeSb();
  }
});
