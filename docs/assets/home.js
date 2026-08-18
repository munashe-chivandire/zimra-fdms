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
