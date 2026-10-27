// A small confetti pop, drawn on a throwaway canvas (owner, 2026-10-26: tap the INVITE pill on the
// invite page and confetti bursts). No library and no network: the script rides inline in the page
// like every other script Reason's pages carry, and it touches nothing but the pill it is bound to.
//
// The colours are the site's own: the brand red (src/pages/brand.js), a warm sand, ink and the paper
// rule on a light page; the brighter dark-page red and the paper tones on a dark one, so every piece
// shows against its ground. It bursts from the pill, falls and fades inside ~1.7 s, then the canvas
// removes itself. A second tap within 400 ms is ignored; after that a tap starts a fresh burst.
// Someone who asked their phone for less motion gets a dozen still sparkles that fade where they are.
//
// Wire it with shell({ pillButton: "…", script: CONFETTI_JS, css: CONFETTI_CSS }).

import { BRAND_PEN, BRAND_PEN_DARK } from "./brand.js";

export const CONFETTI_CSS = `canvas.confetti{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50}`;

export const CONFETTI_JS = `
(function(){
var b=document.querySelector('header .pill[data-pop]');if(!b)return;
var LIGHT=['${BRAND_PEN}','${BRAND_PEN}','${BRAND_PEN}','#c9a46a','#2a2520','#d4c9b5'],
DARK=['${BRAND_PEN_DARK}','${BRAND_PEN_DARK}','#e0b779','#faf6ee','#ede5d8','#d4c9b5'],
last=0,live=null,raf=0;
function dark(){var t=document.documentElement.getAttribute('data-theme');return t?t==='dark':matchMedia('(prefers-color-scheme:dark)').matches}
b.addEventListener('click',function(){
var now=performance.now();if(now-last<400)return;last=now;
if(live){cancelAnimationFrame(raf);live.remove()}
var calm=matchMedia('(prefers-reduced-motion:reduce)').matches,r=b.getBoundingClientRect(),
ox=r.left+r.width/2,oy=r.top+r.height/2,W=innerWidth,H=innerHeight,d=Math.min(devicePixelRatio||1,2),
c=document.createElement('canvas'),x=c.getContext('2d'),pal=dark()?DARK:LIGHT,ps=[],n=calm?12:90,T=calm?900:1700,i;
c.className='confetti';c.setAttribute('aria-hidden','true');c.width=W*d;c.height=H*d;x.scale(d,d);
document.body.appendChild(c);live=c;
for(i=0;i<n;i++){
var a=calm?Math.random()*6.283:Math.PI*(.3+Math.random()*1.4),v=calm?.15+Math.random()*.3:3+Math.random()*7;
ps.push({x:calm?ox+(Math.random()-.5)*r.width*1.6:ox,y:calm?oy+(Math.random()-.5)*r.height*2.4:oy,
vx:Math.cos(a)*v,vy:Math.sin(a)*v-(calm?0:3+Math.random()*2),w:calm?2.5:5+Math.random()*5,h:calm?2.5:3+Math.random()*3,
rot:Math.random()*6.283,spin:(Math.random()-.5)*.35,round:calm||Math.random()<.25,col:pal[i%pal.length]})}
var t0=now,prev=now;
function frame(t){
var k=Math.max(0,Math.min((t-prev)/16.7,3)),e=Math.max(0,(t-t0)/T);prev=Math.max(prev,t);
if(e>=1){c.remove();if(live===c)live=null;return}
x.clearRect(0,0,W,H);x.globalAlpha=calm?Math.sin(Math.PI*e):e<.6?1:1-(e-.6)/.4;
for(var j=0;j<ps.length;j++){var p=ps[j];
if(!calm){p.vy+=.28*k;p.vx*=Math.pow(.985,k);p.vy*=Math.pow(.985,k);p.rot+=p.spin*k}
p.x+=p.vx*k;p.y+=p.vy*k;x.fillStyle=p.col;x.save();x.translate(p.x,p.y);x.rotate(p.rot);
if(p.round){x.beginPath();x.arc(0,0,p.w/2,0,6.283);x.fill()}else x.fillRect(-p.w/2,-p.h/2,p.w,p.h*Math.abs(Math.cos(p.rot*2)));
x.restore()}
raf=requestAnimationFrame(frame)}
raf=requestAnimationFrame(frame)});
})();
`;
