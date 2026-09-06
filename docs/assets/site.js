/* zimra-fdms — shared behaviour: theme toggle, mobile menu */
/* Both pages load this; the docs page has no marketing nav, so every lookup is optional. */

/* theme toggle */
const themeBtn = document.getElementById('tt');
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('zf-theme', next); } catch (e) {}
  });
}

/* mobile menu */
const burger = document.getElementById('burger');
if (burger) {
  burger.addEventListener('click', () => document.body.classList.toggle('menu-open'));
  document.querySelectorAll('#mmenu a').forEach(a =>
    a.addEventListener('click', () => document.body.classList.remove('menu-open')));
}

/* live GitHub stars + forks in the header */
/* Both pages carry the same markup; the docs header just scales it down. */
(() => {
  const box = document.getElementById('ghstats');
  if (!box) return;

  const REPO = 'munashe-chivandire/zimra-fdms';
  const KEY  = 'zf-ghstats';
  const TTL  = 5 * 60 * 1000;   // anonymous GitHub API allows 60 calls/hour per IP
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const els = {
    stars: box.querySelector('#gh-stars .num'),
    forks: box.querySelector('#gh-forks .num')
  };

  const fmt = n => n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);

  const readCache = () => {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  };
  const writeCache = v => {
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
  };

  /* count up from what is already on screen, so a refetch animates only the delta */
  function roll(el, to) {
    if (!el) return;
    const had = 'v' in el.dataset;
    const from = +(el.dataset.v || 0);
    if (had && from === to) return;
    el.dataset.v = to;

    if (had) {
      const chip = el.closest('.ghstat');
      chip.classList.remove('bumped');
      void chip.offsetWidth;               // restart the animation
      chip.classList.add('bumped');
      chip.addEventListener('animationend', () => chip.classList.remove('bumped'), { once: true });
    }

    /* a backgrounded tab throttles rAF, which would strand the count at 0 */
    if (reduced || document.visibilityState === "hidden") { el.textContent = fmt(to); return; }

    const start = performance.now(), span = to - from, dur = 900;
    (function step(now) {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = fmt(Math.round(from + span * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    })(start);
  }

  function render(d) {
    roll(els.stars, d.stars);
    roll(els.forks, d.forks);
    box.classList.add('ready');
  }

  async function refresh() {
    const cached = readCache();
    if (cached && Date.now() - cached.t < TTL) return;
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO,
        { headers: { accept: 'application/vnd.github+json' } });
      if (!res.ok) return;                 // rate limited or offline: keep whatever is showing
      const j = await res.json();
      const d = { stars: j.stargazers_count | 0, forks: j.forks_count | 0, t: Date.now() };
      writeCache(d);
      render(d);
    } catch (e) { /* offline — the cached numbers stay up */ }
  }

  const cached = readCache();
  if (cached) render(cached);              // paint instantly, then correct it in the background
  refresh();

  /* re-check when the tab comes back, still bounded by the TTL */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
})();
