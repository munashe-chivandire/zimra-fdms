/* zimra-fdms — landing page animation and interaction */

if(!window.gsap){document.documentElement.classList.add('no-gsap')}

if(window.gsap&&window.ScrollTrigger){
gsap.registerPlugin(ScrollTrigger);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* intro */
gsap.set('#headline .w>span',{y:reduced?0:'110%'});
if (reduced){
  gsap.set('#headline .w>span,[data-intro],#nav,#receipt',{opacity:1,y:0});
} else {
  gsap.timeline({defaults:{ease:'power4.out'}})
    .from('#nav',{y:-24,opacity:0,duration:.8},.1)
    .to('#headline .w>span',{y:0,duration:1.05,stagger:.12},'-=.5')
    .from('[data-intro]',{y:30,opacity:0,duration:.85,stagger:.08},'-=.7')
    .from('#receipt',{y:60,opacity:0,rotate:7,duration:1.2,ease:'power4.out'},'-=.9');
}

/* receipt float on scroll */
if(!reduced){
  gsap.to('#receipt',{y:-26,rotate:.6,ease:'none',
    scrollTrigger:{trigger:'header',start:'top top',end:'bottom top',scrub:1.1}});
}

/* scroll progress */
gsap.to('#progress',{scaleX:1,ease:'none',scrollTrigger:{start:0,end:'max',scrub:.3}});

/* nav hide/show */
let lastY=0;
ScrollTrigger.create({start:0,end:'max',onUpdate:s=>{
  const y=s.scroll();
  if(!document.body.classList.contains('menu-open')){
    gsap.to('#nav',{yPercent:(y>120&&y>lastY)?-180:0,duration:.5,ease:'power3.out',overwrite:'auto'});
  }
  lastY=y;
}});

/* ambient parallax */
if(!reduced){
  gsap.to('.orb-a',{yPercent:28,ease:'none',scrollTrigger:{start:0,end:'max',scrub:1.2}});
  gsap.to('.orb-b',{yPercent:-20,ease:'none',scrollTrigger:{start:0,end:'max',scrub:1.6}});
  gsap.to('.orb-c',{yPercent:-32,ease:'none',scrollTrigger:{start:0,end:'max',scrub:1}});
}

/* reveals */
document.querySelectorAll('[data-rv]:not(.card)').forEach(el=>{
  gsap.fromTo(el,
    {y:reduced?0:48,opacity:reduced?1:0},
    {y:0,opacity:1,duration:1,ease:'power4.out',scrollTrigger:{trigger:el,start:'top 88%'}});
});
gsap.set('.bento .card',{y:reduced?0:60,opacity:reduced?1:0});
ScrollTrigger.batch('.bento .card',{start:'top 90%',onEnter:b=>{
  gsap.to(b,{y:0,opacity:1,duration:1.05,stagger:.09,ease:'power4.out',overwrite:true});
}});
gsap.from('#codeblock .ln',{opacity:0,x:reduced?0:-14,duration:.5,stagger:.05,ease:'power2.out',
  scrollTrigger:{trigger:'.codewin',start:'top 80%'}});
document.querySelectorAll('.note').forEach(n=>{
  gsap.from(n,{clipPath:reduced?'none':'inset(0 100% 0 0)',duration:1,ease:'power4.inOut',
    scrollTrigger:{trigger:n,start:'top 92%'}});
});

/* receipt counters */
document.querySelectorAll('[data-count]').forEach(el=>{
  const end=+el.dataset.count;
  ScrollTrigger.create({trigger:el,start:'top 95%',once:true,onEnter:()=>{
    gsap.fromTo(el,{innerText:0},{innerText:end,duration:1.6,delay:.6,ease:'power2.out',snap:{innerText:1}});
  }});
});

/* spotlight cards */
document.querySelectorAll('.card').forEach(card=>{
  card.addEventListener('pointermove',e=>{
    const r=card.getBoundingClientRect();
    card.style.setProperty('--mx',((e.clientX-r.left)/r.width*100)+'%');
    card.style.setProperty('--my',((e.clientY-r.top)/r.height*100)+'%');
  });
});

/* magnetic buttons */
if(matchMedia('(pointer:fine)').matches && !reduced){
  document.querySelectorAll('.magnet').forEach(btn=>{
    const xTo=gsap.quickTo(btn,'x',{duration:.6,ease:'elastic.out(1,.45)'});
    const yTo=gsap.quickTo(btn,'y',{duration:.6,ease:'elastic.out(1,.45)'});
    btn.addEventListener('pointermove',e=>{
      const r=btn.getBoundingClientRect();
      xTo((e.clientX-(r.left+r.width/2))*.28);
      yTo((e.clientY-(r.top+r.height/2))*.34);
    });
    btn.addEventListener('pointerleave',()=>{xTo(0);yTo(0);});
  });
}

/* terminal typing */
(()=>{
  const el=document.getElementById('typed'), cmd='npm install zimra-fdms';
  let i=0;
  ScrollTrigger.create({trigger:'.term',start:'top 95%',once:true,onEnter:()=>{
    if(reduced){el.textContent=cmd;return;}
    const t=setInterval(()=>{el.textContent=cmd.slice(0,++i);if(i>=cmd.length)clearInterval(t)},55);
  }});
})();
} else {
  document.getElementById('typed').textContent='npm install zimra-fdms';
}

/* copy buttons */
function wireCopy(id,text){
  const b=document.getElementById(id);
  if(!b)return;
  b.addEventListener('click',async()=>{
    await navigator.clipboard.writeText(typeof text==='function'?text():text);
    b.textContent='Copied ✓';b.classList.add('ok');
    setTimeout(()=>{b.textContent='Copy';b.classList.remove('ok')},1700);
  });
}
wireCopy('copy','npm install zimra-fdms');
wireCopy('copycode',()=>document.querySelector('.codewin pre:not([hidden]) code').innerText);

/* pos.ts / MCP tab toggle */
(function(){
  const tabSdk=document.getElementById('tab-sdk'),tabMcp=document.getElementById('tab-mcp');
  if(!tabSdk||!tabMcp)return;
  const sdkPre=document.getElementById('codeblock').parentElement;
  const mcpPre=document.getElementById('mcpblock');
  const lang=document.getElementById('codelang');
  function pick(mcp){
    sdkPre.hidden=mcp;mcpPre.hidden=!mcp;
    tabSdk.classList.toggle('active',!mcp);tabMcp.classList.toggle('active',mcp);
    lang.textContent=mcp?'MCP':'TypeScript';
  }
  tabSdk.addEventListener('click',()=>pick(false));
  tabMcp.addEventListener('click',()=>pick(true));
})();

/* testimonial wall — curated tweets from data/tweets.json */
/* The section ships hidden and only unhides once there is something real to show, */
/* so an empty or unreachable file leaves no empty shelf on the page. */
(async () => {
  const sec  = document.getElementById('voices');
  const grid = document.getElementById('tweets');
  if (!sec || !grid) return;

  /* placeholder entries are for judging the layout locally; they never reach production */
  const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);

  let data;
  try {
    const res = await fetch('data/tweets.json', { cache: 'no-cache' });
    if (!res.ok) return;
    data = await res.json();
  } catch (e) { return; }

  const list = (data.tweets || []).filter(t => local || !t.placeholder);
  if (!list.length) return;

  const esc = s => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* tint @handles and #tags after escaping, never before */
  const rich = s => esc(s)
    .replace(/(^|\s)(@[A-Za-z0-9_]{1,15})/g, '$1<b>$2</b>')
    .replace(/(^|\s)(#[A-Za-z0-9_]+)/g, '$1<b>$2</b>');

  const HUES = [212, 38, 268, 152, 340];
  const hueOf = s => {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return HUES[Math.abs(h) % HUES.length];
  };

  const when = d => {
    const t = new Date(d);
    return isNaN(t) ? '' : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const X_PATH = 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z';

  grid.innerHTML = list.map(t => {
    const label = (t.name || t.handle || '?').replace(/^@/, '');
    const initial = esc(label.charAt(0).toUpperCase());
    const hue = hueOf(t.handle || label);
    /* initial and hue ride along so a dead image can rebuild the monogram */
    const avatar = t.avatar
      ? `<img class="tw-av" src="${esc(t.avatar)}" alt="" loading="lazy" data-initial="${initial}" data-hue="${hue}">`
      : `<span class="tw-av" style="background:hsl(${hue} 58% 42%)">${initial}</span>`;
    return `<a class="tw" href="${esc(t.url || '#')}" target="_blank" rel="noopener">
  <div class="tw-in">
    <div class="tw-top">${avatar}
      <span class="tw-id"><b>${esc(t.name || t.handle)}</b><span>${esc(t.handle)}</span></span>
      <svg class="tw-x" viewBox="0 0 24 24" aria-hidden="true"><path d="${X_PATH}"/></svg>
    </div>
    <div class="tw-body">${rich(t.text)}</div>
    <div class="tw-foot"><span>${esc(when(t.date))}</span>${t.placeholder ? '<span class="tw-flag">placeholder</span>' : ''}</div>
  </div></a>`;
  }).join('');

  sec.hidden = false;


  const cards = [...grid.children];

  /* same spotlight the bento cards use; those were bound before these existed */
  /* hotlinked pbs.twimg.com URLs rotate; a 404 becomes the monogram, not a broken icon */
  const wireAvatars = scope => scope.querySelectorAll('img.tw-av').forEach(img => {
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = 'tw-av';
      span.style.background = `hsl(${img.dataset.hue} 58% 42%)`;
      span.textContent = img.dataset.initial || '?';
      img.replaceWith(span);
    }, { once: true });
  });
  wireAvatars(grid);
  const spotlight = card => card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
    card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
  });
  cards.forEach(spotlight);

  /* the section was display:none at load, so triggers below it need remeasuring */
  if (window.ScrollTrigger) ScrollTrigger.refresh();

  /* no GSAP or reduced motion: the plain grid above is the fallback */
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !window.gsap) return;

  /* ---------- looping marquee, right to left ---------- */
  const track = document.createElement('div');
  track.className = 'tw-track';
  cards.forEach(c => track.appendChild(c));
  grid.appendChild(track);
  grid.classList.add('marquee');

  const gap = parseFloat(getComputedStyle(track).gap) || 0;
  /* the loop distance has to include one trailing gap, or the seam shows */
  const setWidth = track.scrollWidth + gap;

  /* clone whole sets until the track can cover the viewport plus one full set */
  while (track.scrollWidth < grid.clientWidth + setWidth) {
    cards.forEach(c => {
      const copy = c.cloneNode(true);
      copy.setAttribute('aria-hidden', 'true');
      copy.tabIndex = -1;
      spotlight(copy);
      wireAvatars(copy);
      track.appendChild(copy);
    });
  }

  let x = 0, hovering = false, onScreen = true, running = false;
  grid.addEventListener('pointerenter', () => { hovering = true; });
  grid.addEventListener('pointerleave', () => { hovering = false; });

  gsap.ticker.add(() => {
    if (!onScreen || !running) return;
    x -= 0.75 * gsap.ticker.deltaRatio(60) * (hovering ? 0.25 : 1);   // slow down to read
    if (x <= -setWidth) x += setWidth;
    gsap.set(track, { x });
  });

  /* cards fly in on load; the marquee stays parked until the intro lands */
  gsap.from(track.children, {
    y: 36, scale: .94, opacity: 0, duration: 1.05, ease: "power4.out",
    stagger: { amount: .7 }, delay: .45
  });
  /* spread over a fixed window, so clone count never stretches the intro */
  gsap.delayedCall(1.15, () => { running = true; });

  if (window.ScrollTrigger) {
    ScrollTrigger.create({ trigger: sec, start: 'top bottom', end: 'bottom top',
      onToggle: self => { onScreen = self.isActive; } });
  }
})();
