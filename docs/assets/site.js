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
