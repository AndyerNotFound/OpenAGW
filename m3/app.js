// ============ Material Web component library (local vendor, zero external deps) ============
// Note: this bundle fully inlines lit with no bare module references, so browsers can load it directly.
const MW_OK = await import('./vendor/mw-v2.js').then(()=>true).catch(e=>{
  console.error('[MW] 组件库加载失败：', e); return false;
});

// ============ Feature detection: Form Association / dialog are hard dependencies of Material Web form components ============
(function detectCompat(){
  const miss=[];
  if(!('attachInternals' in HTMLElement.prototype)) miss.push('Element Internals');
  else if(typeof ElementInternals!=='undefined' && !('setFormValue' in ElementInternals.prototype)) miss.push('Form Association');
  if(!('showModal' in HTMLDialogElement.prototype)) miss.push('<dialog>');
  if(!customElements.get('md-filled-button')) miss.push('组件库未加载');
  if(miss.length){
    const b=document.getElementById('compatBar');
    b.textContent='⚠ 当前浏览器缺少 '+miss.join(' / ')+'，按钮/选择框/输入框可能失效。请用 Chrome 90+ / Edge 90+ / Safari 16.4+ / Firefox 143+ 打开。';
    b.classList.add('show');
  }
})();

// ============ Tools ============
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const escAttr = s => esc(s).replace(/\s/g,' ');
const stripTags = s => String(s==null?'':s).replace(/<[^>]+>/g,'');
// esc() already turned & < > " into entities; a title= built from that escaped markup would show "&amp;amp;"
// on hover. Decode the same five entities first, then let escAttr() encode exactly once.
const unesc = s => String(s==null?'':s).replace(/&(amp|lt|gt|quot|#39);/g, (m,e)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[e]));
const fmtNum = n => n?.toLocaleString?.() ?? '-';
const fmtDur = s => { if(!s||s<0)return '-'; const h=Math.floor(s/3600),m=Math.floor(s%3600/60); return h?`${h}h${m}m`:`${m}m`; };
//// abbreviated Base URL: strip the scheme and trailing /v1 to fit ~40% more useful info at the same width; the full value goes in title
const fmtHost = u => String(u||'-')
  .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  .replace(/\/+$/, '')
  .replace(/\/v1\d*$/i, '');

function snack(msg, isErr=false){
  const el=$('#snackbar'); el.textContent=msg;
  el.classList.toggle('err', !!isErr); el.classList.add('show');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'), isErr?4000:2000);
}

// ============ Dropdown: truncate the selected value ============
// md-outlined-select prints the current value into a shadow-DOM #label node that exposes no ::part and no
// token of its own, so a long instance/model name wraps and makes the field taller. Inject the rule once per
// element, then keep title= in sync so the full value is still readable on hover.
const SEL_LABEL_CSS='#label{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
  +'md-menu{min-width:max(var(--__menu-min-width,0px),240px)!important;max-width:calc(100vw - 24px)!important}';
function selLabelText(el){
  const o=[...el.querySelectorAll('md-select-option')].find(x=>x.value===el.value);
  return (o?o.textContent.trim():'')||el.value||'';
}
function patchSelect(el){
  try{
    const root=el.shadowRoot;
    if(root && !root.__agwLabelCss){
      const st=document.createElement('style'); st.textContent=SEL_LABEL_CSS; root.appendChild(st); root.__agwLabelCss=st;
    }
    el.title=selLabelText(el);
  }catch(_){}
}
function patchSelects(root=document){ try{ root.querySelectorAll?.('md-outlined-select').forEach(patchSelect); }catch(_){} }
patchSelects();
// selects are re-created by dialogs and re-filled by every render: patch them as they land (shadow-root
// writes do not touch the document tree, so this observer cannot feed itself)
let selPatchQueued=false;
new MutationObserver(()=>{ if(selPatchQueued) return; selPatchQueued=true;
  requestAnimationFrame(()=>{ selPatchQueued=false; patchSelects(); }); }).observe(document.body,{childList:true,subtree:true});
document.body.addEventListener('change',e=>{ const s=e.target.closest?.('md-outlined-select'); if(s) s.title=selLabelText(s); });

// ============ Data adapter layer (contract identical to the hand-written version) ============
class BaseAdapter{
  async _fetch(url, opts={}, signal){
    if(!Store.online) throw new Error('网络已断开');
    let res;
    try{ res = await fetch(url, {...opts, signal}); }
    catch(e){ if(e.name==='AbortError') throw e;
      throw new Error('无法连接到 ' + url.split('/admin/api/')[0] + ' （实例可能未运行或正在重启中）'); }
if(res.status===401){ // session gone (or a wrong token): the login page is the only re-entry
  if(!localStorage.getItem('agw-admin-key') && !window.__agwAuthRedirect){
    window.__agwAuthRedirect=true;
    const m=location.pathname.match(/^\/([A-Za-z0-9_-]{16,128})\/admin(?:\/|$)/);
    location.replace((m?'/'+m[1]+'/admin':'')+'/login');
  } else openKeyDialog();
}
    if(!res.ok){
// Best-effort parse {error:{message}} / {error:"..."} into readable text (balance failures must show why)
      let msg='';
      try{
        const t=await res.text();
        try{ const j=JSON.parse(t); msg=(j&&j.error&&(j.error.message||j.error))||(j&&j.message)||t; }catch(_){ msg=t; }
      }catch(_){}
      throw new Error(msg || `HTTP ${res.status}`);
    }
    const ct = res.headers.get('content-type')||'';
    return ct.includes('json') ? res.json() : res.text();
  }
}
class HttpAdapter extends BaseAdapter{
  constructor(base){
    super();
    const pm=location.pathname.match(/^\/([A-Za-z0-9_-]{16,128})\/admin(?:\/|$)/);
    const prefix=pm?'/'+pm[1]:''; // base + '/admin/api/...' rebuilds /<sid>/admin/api/...
    this.base=(base||(location.origin+prefix)).replace(/\/$/,'');
  }
  _hdr(){ const h={'Content-Type':'application/json'}; const k=localStorage.getItem('agw-admin-key'); if(k)h['x-agw-token']=k; return h; }
  async getInstances(signal){ return this._fetch(`${this.base}/admin/api/instances`,{headers:this._hdr()},signal); }
  async getConfig(name,signal){ return this._fetch(`${this.base}/admin/api/config/${encodeURIComponent(name)}?reveal=1`,{headers:this._hdr()},signal); }
  async saveConfig(name,patch,signal){
    const r=await this._fetch(`${this.base}/admin/api/config/${encodeURIComponent(name)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(patch)},signal);
    if(r&&r.restarting){ snack('已保存，实例 '+name+' 重启中…'); await this._waitUp(name); snack('实例 '+name+' 已重启'); }
    return r;
  }
  // wait for the instance to finish restarting (poll the instance list until running)
  async _waitUp(name,timeoutMs=40000){
    const t0=Date.now();
await new Promise(r=>setTimeout(r,3500)); // let the old process exit and the new one start first (the self-restart script takes ~2-3s)
    while(Date.now()-t0<timeoutMs){
      try{ const d=await this.getInstances(); const i=(d.instances||[]).find(x=>x.name===name); if(i&&i.running) return true; }catch(_){}
      await new Promise(r=>setTimeout(r,1000));
    }
    return false;
  }
  async getRecordBody(name,id,signal){ return this._fetch(`${this.base}/admin/api/record-body/${encodeURIComponent(name)}?id=${encodeURIComponent(id)}`,{headers:this._hdr()},signal); }
  async createInstance(name,body,signal){ return this._fetch(`${this.base}/admin/api/instance-create/${encodeURIComponent(name)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async saveChannel(inst,ch,signal){ const r=await this._fetch(`${this.base}/admin/api/channel/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(ch)},signal);
    if(r&&r.restarting){ snack('已保存，实例 '+inst+' 重启中…'); await this._waitUp(inst); snack('实例 '+inst+' 已重启'); } return r; }
  async deleteChannel(inst,chName,signal){ const r=await this._fetch(`${this.base}/admin/api/channel/${encodeURIComponent(inst)}/${encodeURIComponent(chName)}`,{method:'DELETE',headers:this._hdr()},signal);
    if(r&&r.restarting){ snack('已删除，实例 '+inst+' 重启中…'); await this._waitUp(inst); snack('实例 '+inst+' 已重启'); } return r; }
  async deleteInstance(name,signal){ return this._fetch(`${this.base}/admin/api/instance/${encodeURIComponent(name)}`,{method:'DELETE',headers:this._hdr()},signal); }
  async renameInstance(name,newName,signal){ return this._fetch(`${this.base}/admin/api/instance-rename/${encodeURIComponent(name)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify({newName})},signal); }
  async fetchModels(inst,body,signal){ return this._fetch(`${this.base}/admin/api/channel-models/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async syncModels(inst,signal){ return this._fetch(`${this.base}/admin/api/sync-models`,{method:'POST',headers:this._hdr()},signal); }
  async getWebSessions(signal){ return this._fetch(`${this.base}/admin/api/web-sessions`,{headers:this._hdr()},signal); }
  async getAnnouncements(signal){ return this._fetch(`${this.base}/admin/api/announcements`,{headers:this._hdr()},signal); }
  async saveAnnouncement(a,signal){ return this._fetch(`${this.base}/admin/api/announcements`,{method:'POST',headers:this._hdr(),body:JSON.stringify(a)},signal); }
  async deleteAnnouncement(id,signal){ return this._fetch(`${this.base}/admin/api/announcements-delete`,{method:'POST',headers:this._hdr(),body:JSON.stringify({id})},signal); }
  async revokeWebSession(sid,signal){ return this._fetch(`${this.base}/admin/api/web-expired`,{method:'POST',headers:this._hdr(),body:JSON.stringify(sid?{sid}:{})},signal); }
  async setAdminExpire(at,signal){ return this._fetch(`${this.base}/admin/api/admin-expire`,{method:'POST',headers:this._hdr(),body:JSON.stringify({at:Number(at)||0})},signal); }
  async getMdu(signal){ return this._fetch(`${this.base}/admin/api/mdu`,{headers:this._hdr()},signal); }
  async getLogCfg(name,signal){ return this._fetch(`${this.base}/admin/api/log-cfg/${encodeURIComponent(name)}`,{headers:this._hdr()},signal); }
  async saveLogCfg(name,body,signal){ return this._fetch(`${this.base}/admin/api/log-cfg/${encodeURIComponent(name)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async getStats(name,signal){ return this._fetch(`${this.base}/admin/api/stats?instance=${encodeURIComponent(name)}`,{headers:this._hdr()},signal); }
  async getLogs(name,lines,signal){ const r=await fetch(`${this.base}/admin/api/logs/${encodeURIComponent(name)}?lines=${lines}`,{headers:this._hdr(),signal}); if(!r.ok) throw new Error(await r.text().catch(()=>'')); return r.text(); }
  async getRequests(name,signal){ return this._fetch(`${this.base}/admin/api/requests/${encodeURIComponent(name)}`,{headers:this._hdr()},signal); }
  async action(name,cmd,signal){ return this._fetch(`${this.base}/admin/api/action/${encodeURIComponent(name)}/${cmd}`,{method:'POST',headers:this._hdr()},signal); }
  async getKeys(inst,signal){ return this._fetch(`${this.base}/admin/api/keys/${encodeURIComponent(inst)}`,{headers:this._hdr()},signal); }
  async createKey(inst,body,signal){ return this._fetch(`${this.base}/admin/api/keys/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async updateKey(inst,body,signal){ return this._fetch(`${this.base}/admin/api/keys-update/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async deleteKey(inst,key,signal){ return this._fetch(`${this.base}/admin/api/keys/${encodeURIComponent(inst)}/${encodeURIComponent(key)}`,{method:'DELETE',headers:this._hdr()},signal); }
  async getAdminAuth(inst,signal){ return this._fetch(`${this.base}/admin/api/admin-auth/${encodeURIComponent(inst)}`,{headers:this._hdr()},signal); }
  async setAdminAuth(inst,body,signal){ return this._fetch(`${this.base}/admin/api/admin-auth/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr(),body:JSON.stringify(body)},signal); }
  async getTunnel(signal){ return this._fetch(`${this.base}/admin/api/tunnel`,{headers:this._hdr()},signal); }
  async tunnelAction(action,signal){ return this._fetch(`${this.base}/admin/api/tunnel`,{method:'POST',headers:this._hdr(),body:JSON.stringify({action})},signal); }
  async getBalance(inst,ch,signal){ return this._fetch(`${this.base}/admin/api/balance/${encodeURIComponent(inst)}/${encodeURIComponent(ch)}`,{headers:this._hdr()},signal); }
  async getBalances(inst,signal){ return this._fetch(`${this.base}/admin/api/balances/${encodeURIComponent(inst)}`,{headers:this._hdr()},signal); }
  async probeNow(inst,signal){ return this._fetch(`${this.base}/admin/api/probe/${encodeURIComponent(inst)}`,{method:'POST',headers:this._hdr()},signal); }
  async shutdownAll(signal){ return this._fetch(`${this.base}/admin/api/shutdown-all`,{method:'POST',headers:this._hdr()},signal); }
}

// ============ State ============
const VIEWS = [
// icons use Material Symbols word forms (local font ligatures; see @font-face)
  {id:'overview', label:'首页',   icon:'home'},
  {id:'announce', label:'公告',   icon:'campaign'},
  {id:'providers',label:'提供商', icon:'business'},
  {id:'routing',  label:'路由',   icon:'sync'},
  {id:'stats',    label:'统计',   icon:'bar_chart'},
  {id:'logs',     label:'日志',   icon:'description'},
  {id:'keys',     label:'密钥',   icon:'key'},
  {id:'cards',    label:'用户',   icon:'confirmation_number'},
  {id:'ports',    label:'端口',   icon:'power'},
  {id:'session',  label:'会话',   icon:'devices'},
  {id:'replace',  label:'替换',   icon:'find_replace'},
];
const TITLES = {overview:'首页',announce:'公告',providers:'提供商',routing:'路由策略',keys:'API 密钥',cards:'用户与卡密',ports:'服务端口',session:'面板会话',replace:'文本替换',stats:'统计',logs:'日志'};
const Store = {
  page:'overview', instances:[], configs:new Map(), aborts:new Map(), timer:null,
  online:navigator.onLine, currentName:'',
  inst:'default',
  charts:null,
  chartMode:{daily:'bar',model:'bar',dist:'hbar'},
  gran:'1D',
  abort(key){ const c=this.aborts.get(key); if(c){ try{c.abort();}catch(e){} }
    const n=new AbortController(); this.aborts.set(key,n); return n.signal; },
  armTimeout(key,ms,onFire){ const c=this.aborts.get(key); if(!c) return ()=>{};
    const t=setTimeout(()=>{ try{ if(onFire) onFire(); c.abort(); }catch(_){} },ms);
    return ()=>clearTimeout(t); },
  clearRefresh(){ if(this.timer){ clearInterval(this.timer); this.timer=null; } },
  startRefresh(fn,ms){ this.clearRefresh(); this.timer=setInterval(fn,ms); },
};
let adapter = new HttpAdapter();

// ============ Navigation ============
function buildNav(){
// Sidebar items are custom buttons: md-list-item's line-height/spacing misbehaves on some screens
// The active highlight is one sliding pill (rail-glider) under the items, not per-item backgrounds:
// switching pages glides it to the target item instead of snapping (see .rail-glider in app.css).
  $('#railList').innerHTML = VIEWS.map(v=>
    `<button type="button" class="rail-item" data-page="${v.id}" title="${escAttr(v.label)}" ${v.id===Store.page?'active':''}>
       <span class="msym" aria-hidden="true">${v.icon}</span><span class="lbl">${v.label}</span>
     </button>`).join('') + '<span class="rail-glider" id="railGlider" aria-hidden="true"></span>';
}
function syncNav(instant){
  $$('#railList .rail-item').forEach(el=>el.toggleAttribute('active', el.dataset.page===Store.page));
  moveRailGlider(instant);
}
// instant=true skips the slide (first paint); offsetTop is layout-relative, so it scrolls with the list.
function moveRailGlider(instant){
  const g=$('#railGlider'); if(!g) return;
  const act=$('#railList .rail-item[active]');
  if(!act){ g.style.opacity='0'; return; }
  if(instant) g.style.transition='none';
  g.style.transform=`translateY(${act.offsetTop}px)`;
  g.style.opacity='1';
  if(instant){ void g.offsetWidth; g.style.transition=''; }
}
// ============ Sidebar open / close ============
// Collapsed = 56px icon rail: every item ends up 44x44, the label is clipped away and only the icon shows.
// Expanded = 236px drawer: the shell is pushed right and everything outside the rail is dimmed by the scrim.
function railOpen(){ return $('#rail')?.dataset.open==='true'; }
function setRail(open, save=true){
  const rail=$('#rail'); if(!rail) return;
  rail.dataset.open=open?'true':'false';
  const btn=$('#railToggle');
  if(btn){ btn.setAttribute('aria-expanded',open?'true':'false'); btn.setAttribute('aria-label',open?'收起侧边栏':'展开侧边栏'); }
  const ic=$('#railToggleIc'); if(ic) ic.textContent=open?'menu_open':'menu';
  const sc=$('#railScrim'); if(sc) sc.classList.toggle('show', !!open);
  if(save){ try{ localStorage.setItem('agw-rail', open?'open':'closed'); }catch(_){} }
}
function toggleRail(){ setRail(!railOpen()); }
// Title roll: the old caption rolls out (clipped by the h1's own overflow), then the new one rolls
// in from the opposite edge. Direction matches the page push: forward = up, back = down.
// Durations mirror .topbar h1.t-out/.t-in in app.css — keep the two in sync.
const TITLE_OUT_MS = 130, TITLE_IN_MS = 190;
let titleT = 0;
function setPageTitle(text, fwd=true){
  const el=$('#pageTitle'); if(!el) return;
  clearTimeout(titleT);
  el.classList.remove('t-out','t-in','rev');
  if(reducedMotion() || el.textContent===text){ el.textContent=text; return; }
  const off = fwd ? [] : ['rev'];
  el.classList.add('t-out', ...off);
  titleT=setTimeout(()=>{
    el.textContent=text;
    el.classList.remove('t-out', ...off);
    el.classList.add('t-in', ...off);
    titleT=setTimeout(()=>el.classList.remove('t-in','rev'), TITLE_IN_MS+20);
  }, TITLE_OUT_MS);
}
// Page switch: push — the leaving page slides up out while the incoming one is pushed in from below,
// one simultaneous move with the two pages tiled (no gap, no empty frame). The old two-phase
// animation hid the leaving page before showing the next one, and that gap was the flicker.
// Direction follows the sidebar order: down the list pushes up, back up pushes down.
// PAGE_PUSH_MS mirrors the .page.push.* duration in app.css — keep the two in sync.
const PAGE_PUSH_MS = 280;
let navSeq = 0;
const waitMs = ms => new Promise(r=>setTimeout(r,ms));
function reducedMotion(){ try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(_){ return false; } }
/* ============ Expand / collapse (animated) ============
 * Replaces <details>, which snaps open and shut with no transition. The head is a real button; the body
 * is measured and height-animated so the card grows into view, then the inline styles are cleared (the
 * body goes back to being auto-heighted, never stuck at a stale pixel height). reducedMotion skips it. */
const XC_MS = 240;
function xcToggle(head, force){
  const wrap=head.closest('[data-xc]'); if(!wrap) return;
  const body=wrap.querySelector('.xc-body'); if(!body) return;
  const wasOpen=wrap.classList.contains('open');
  const open=force==null?!wasOpen:!!force;
  if(open===wasOpen && !body._xcBusy) return;
  head.setAttribute('aria-expanded', open?'true':'false');
  wrap.classList.toggle('open', open);
  clearTimeout(body._xcT);
  if(reducedMotion()){
    body.style.height=''; body.style.opacity=''; body.style.transition=''; body.style.overflow='';
    body.hidden=!open; body._xcBusy=false; return;
  }
  // Start from the height actually on screen: 0 when it is closed, the live pixel height when it is
  // open or still moving (a tap in the middle of an animation then reverses instead of jumping).
  const from=body.hidden?0:body.getBoundingClientRect().height;
  body.hidden=false;
  body.style.transition='none'; body.style.height='auto'; body.style.overflow='hidden';
  const natural=body.getBoundingClientRect().height;
  body.style.height=from+'px';
  if(open) body.style.opacity='0';
  void body.offsetHeight;
  body._xcBusy=true;
  body.style.transition=`height ${XC_MS}ms cubic-bezier(.2,0,0,1), opacity ${XC_MS}ms ease`;
  body.style.height=(open?natural:0)+'px';
  body.style.opacity=open?'1':'0';
  body._xcT=setTimeout(()=>{
    body.style.transition=''; body.style.height=''; body.style.overflow=''; body.style.opacity='';
    if(!open) body.hidden=true;
    body._xcBusy=false;
  }, XC_MS+20);
}
function viewIdx(id){ return VIEWS.findIndex(v=>v.id===id); }
function clearPageFx(el){ if(!el) return; el.classList.remove('push','out','in','rev','is-out','is-in'); }
function hidePageEl(el){ if(!el) return; clearPageFx(el); el.hidden=true; el.classList.add('hidden'); }
function showPageEl(el){
  if(!el) return;
  clearPageFx(el); el.hidden=false; el.classList.remove('hidden');
}
async function go(page){
  if(!VIEWS.some(v=>v.id===page)) return;
  const seq=++navSeq;
  const prev=Store.page, prevEl=$(`#page-${prev}`), nextEl=$(`#page-${page}`);
  const same=prev===page, main=$('#main');
  Store.page=page;
  syncNav();
  Store.clearRefresh();
  if(page!=='overview') ovCarStop();
  if(!same && prevEl && nextEl && !prevEl.hidden && !reducedMotion()){
    const fwd=viewIdx(page)>viewIdx(prev);
    // Both pages are lifted out of the flow while pushing, so reset scroll before the move starts:
    // absolute children of a scrolled container anchor to the content top, not the scrollport.
    setPageTitle(TITLES[page]||page, fwd);
    if(main) main.scrollTop=0;
    // A switch that interrupted an earlier push leaves those pages mid-flight; tuck them away.
    $$('.page.push').forEach(p=>{ if(p!==prevEl && p!==nextEl) hidePageEl(p); });
    clearPageFx(prevEl); clearPageFx(nextEl);
    prevEl.classList.add('push','out', ...(fwd?[]:['rev']));
    nextEl.hidden=false; nextEl.classList.remove('hidden');
    nextEl.classList.add('push','in', ...(fwd?[]:['rev']));
    await waitMs(PAGE_PUSH_MS);
    if(seq!==navSeq) return;  // a later switch took over and does the cleanup
    hidePageEl(prevEl);
    clearPageFx(nextEl);
  }else{
    $$('.page').forEach(p=>{ if(p!==nextEl) hidePageEl(p); });
    setPageTitle(TITLES[page]||page, viewIdx(page)>=viewIdx(prev));
    if(!same && main) main.scrollTop=0;
    showPageEl(nextEl);
  }
  if(page==='overview') Store.startRefresh(()=>{ if(Store.page==='overview' && !Store._ovBusy) renderOverview(); },5000);
  else if(page==='stats') Store.startRefresh(()=>{ if(Store.page==='stats' && !Store._stBusy) renderStats(); },5000);
  const R={overview:renderOverview,announce:renderAnnounce,providers:renderProviders,routing:renderRouting,
    keys:renderKeys,cards:renderCards,ports:renderPorts,session:renderSession,replace:renderReplace,
    stats:renderStats,logs:renderLogs};
  await R[page]?.();
}

// ============ Render: text replacement ============
let rpLists={out:[],inc:[]};
function rpCompileCli(rules){
  const out=[];
  for(const r of (rules||[])){ if(!r||!r.re) continue; try{ out.push({re:new RegExp(r.re,(r.ci?'i':'')+'g'),to:String(r.to==null?'':r.to)}); }catch(_){}}
  return out;
}
function rpApplyCli(s,rules){ for(const r of rules) s=s.replace(r.re,r.to); return s; }
function rpRenderChips(dir){
  const box=$('#rp-'+dir+'-chips'); if(!box) return;
  const list=rpLists[dir];
  box.innerHTML=list.length?list.map((r,i)=>
    '<span class="mm-chip" data-i="'+i+'"><span class="nm">'+esc(r.re)+'</span><span class="arrow">→</span><span class="nm">'+esc(r.to||'（删除匹配）')+'</span>'
    +(r.ci?'<span class="tag default" style="margin-left:2px">Aa</span>':'')
    +'<button class="mm-x" data-i="'+i+'" aria-label="删除">✕</button></span>').join('')
    :'<span style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">暂无规则 — 请填写上方两栏后点击 + 添加（点击 ✕ 删除）</span>';
}
async function rpSave(){
  try{
    await adapter.saveConfig(Store.inst,{replace:{out:rpLists.out,inc:rpLists.inc}});
    snack('已保存');
  }catch(e){ snack(e.message,true); }
}
function rpAdd(dir){
  const f=$('#rp-'+dir+'-find'), t=$('#rp-'+dir+'-to'), ci=$('#rp-'+dir+'-ci');
  const re=(f.value||'').trim(), to=(t.value==null?'':t.value);
  if(!re){ snack('请先填写查找正则',true); return; }
  try{ new RegExp(re, ci&&ci.selected?'i':''); }catch(e){ snack('正则表达式无效： '+e.message,true); return; }
  if(rpLists[dir].some(x=>x.re===re&&x.to===to&&!!x.ci===!!(ci&&ci.selected))){ snack('该规则已存在',true); return; }
  rpLists[dir].push({re,to,ci:!!(ci&&ci.selected)});
  f.value=''; if(t) t.value='';
  rpRenderChips(dir); rpSave(dir);
}
function rpDel(dir,i){ rpLists[dir].splice(i,1); rpRenderChips(dir); rpSave(dir); }
function rpBindSwipe(dir){
  const box=$('#rp-'+dir+'-chips'); let sx=0,sy=0,chip=null,idx=-1,dx=0;
  box.addEventListener('touchstart',e=>{
    const t=e.target.closest('.mm-chip'); if(!t) return;
    chip=t; idx=+t.dataset.i; sx=e.touches[0].clientX; sy=e.touches[0].clientY; dx=0;
    t.style.transition='none';
  },{passive:true});
  box.addEventListener('touchmove',e=>{
    if(!chip) return;
    dx=e.touches[0].clientX-sx;
    const dy=e.touches[0].clientY-sy;
    if(Math.abs(dx)>6&&Math.abs(dx)>Math.abs(dy)) chip.style.transform='translateX('+Math.max(-140,Math.min(140,dx))+'px)';
  },{passive:true});
  box.addEventListener('touchend',()=>{
    if(!chip) return;
    if(Math.abs(dx)>64){ chip.style.transition='transform .18s,opacity .18s'; chip.style.transform='translateX('+(dx>0?160:-160)+'px)'; chip.style.opacity='0'; const i=idx; setTimeout(()=>rpDel(dir,i),180); }
    else { chip.style.transition='transform .18s'; chip.style.transform=''; }
    chip=null; idx=-1; dx=0;
  });
}
async function renderReplace(){
  const signal=Store.abort('replace');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal);
    const rp=cfg.replace||{};
    rpLists.out=Array.isArray(rp.out)?rp.out.map(r=>({re:String(r.re||''),to:String(r.to==null?'':r.to),ci:!!r.ci})):[];
    rpLists.inc=Array.isArray(rp.inc)?rp.inc.map(r=>({re:String(r.re||''),to:String(r.to==null?'':r.to),ci:!!r.ci})):[];
    rpRenderChips('out'); rpRenderChips('inc');
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}

// ============ Instance dropdown (md-select needs options attached before value is set, otherwise it is ignored) ============
async function fillInstSelect(sel, current, signal){
  if(!sel) return;
  try{
    const {instances}=await adapter.getInstances(signal);
    Store.instances=instances;
    if(!current || !instances.some(i=>i.name===current)) current = instances[0]?.name || '';
    // Rebuilding identical options makes the select flash on every refresh; only touch the DOM when the set changes
    const sig = instances.map(i=>i.name).join('\u0001');
    if(sel.dataset.instSig !== sig){
      sel.dataset.instSig = sig;
      sel.innerHTML = instances.map(i=>`<md-select-option value="${escAttr(i.name)}" title="${escAttr(i.name)}" ${i.name===current?'selected':''}>${esc(i.name)}</md-select-option>`).join('');
      await sel.updateComplete;
      await Promise.all([...sel.querySelectorAll('md-select-option')].map(o=>o.updateComplete||Promise.resolve()));
    }
    sel.value = current;
    await sel.updateComplete;
    patchSelect(sel);
    return current;
  }catch(e){ if(e.name!=='AbortError') console.error(e); }
  return current;
}
// ============ Card item: head (name) / body (details) / foot (actions) ============
// Three stacked rows instead of one squeezed line: name+tags+status on top, detail lines in the middle,
// action buttons on their own row at the bottom. Every detail line is single-line with an ellipsis and
// keeps the full text in title=, so a long path or note never reflows the card.
function cardItem({dot='', name='', tags='', state='', stateCls='', tail='', side='', lines=[], acts='', data=''}){
  const body=(lines||[]).filter(Boolean);
  return `<div class="card-item"${data?' '+data:''}>
    <div class="card-item-head">
      ${dot?`<span class="card-item-dot ${dot}" aria-hidden="true"></span>`:''}
      <span class="card-item-name" title="${escAttr(name)}">${esc(name)}</span>
      ${tags?`<span class="card-item-tags">${tags}</span>`:''}
      ${side?`<span class="card-item-side">${side}</span>`:''}
      ${state?`<span class="card-item-state ${stateCls}">${state}</span>`:''}
      ${tail?`<span class="card-item-tail">${tail}</span>`:''}
    </div>
    ${body.length?`<div class="card-item-detail">${body.map(l=>`<div class="card-item-line" title="${escAttr(unesc(stripTags(l)))}">${l}</div>`).join('')}</div>`:''}
    ${acts?`<div class="card-item-acts">${acts}</div>`:''}
  </div>`;
}

// ============ Overview: instance-card carousel ============
// Advances one page per tick — a page is the number of fully visible cards (3 on wide screens,
// 1 on phones) — and wraps to the start at the end. Paused while the pointer rests on the list
// or the tab is hidden. OV_CAR_MS is the tick interval.
const OV_CAR_MS = 4000;
const OV_CAR_LISTS = ['#ov-inst-list','#ov-stat-list','#ov-model-list','#ov-ann-list'];
let ovCarTimer=null;
function ovCarTickList(list){
  const card=list.querySelector('.card-item,.stat-box'); if(!card) return;
  const gap=parseFloat(getComputedStyle(list).columnGap)||0;
  const w=card.getBoundingClientRect().width+gap; if(w<=0) return;
  const per=Math.max(1,Math.round(list.clientWidth/w));
  const items=list.children.length;
  if(items<=per) return;
  const max=list.scrollWidth-list.clientWidth;
  const left=list.scrollLeft>=max-1 ? 0 : Math.min(list.scrollLeft+w*per, max);
  list.scrollTo({left});
}
function ovCarTick(){ OV_CAR_LISTS.forEach(sel=>{ const l=$(sel); if(l) ovCarTickList(l); }); }
// Model plaza data: channels (+ their model lists) of the managed instance, cached for 60s so the
// 5s overview refresh does not refetch the whole config every tick.
let plazaCache={inst:'',channels:[],at:0};
async function plazaChannels(signal){
  const inst=Store.inst||'default', now=Date.now();
  if(plazaCache.inst===inst && now-plazaCache.at<60000) return plazaCache.channels;
  const cfg=await adapter.getConfig(inst,signal);
  const channels=(cfg&&cfg.channels||[]).map(c=>({name:c.name,models:(c.models||[]).filter(Boolean)})).filter(c=>c.models.length);
  plazaCache={inst,channels,at:now};
  return channels;
}
function ovCarStart(){ if(ovCarTimer) return; if(reducedMotion()) return;
  ovCarTimer=setInterval(()=>{ if(!document.hidden && !Store._ovHover) ovCarTick(); }, OV_CAR_MS); }
function ovCarStop(){ if(ovCarTimer){ clearInterval(ovCarTimer); ovCarTimer=null; } }

// ============ Render: overview ============
async function renderOverview(){
  if(Store._ovBusy) return;
  Store._ovBusy=true;
  let ovDisarm=()=>{};
  let ovTimedOut=false;
  try{
    const signal=Store.abort('overview');
    ovDisarm=Store.armTimeout('overview',20000,()=>{ ovTimedOut=true; });
    const {instances,current}=await adapter.getInstances(signal);
    Store.instances=instances; if(current) Store.currentName=current;
    $('#ov-instances').textContent=instances.length;
    $('#ov-running').textContent=instances.filter(i=>i.running).length;
    $('#ov-channels').textContent=instances.reduce((a,i)=>a+(i.chCount||0),0);
// Per-instance stats in parallel: the old sequential loop overran the 5s refresh and kept aborting itself
    const stats=await Promise.all(instances.map(i=>adapter.getStats(i.name,signal).catch(e=>{ if(e.name==='AbortError') ovTimedOut=true; return {}; })));
    if(ovTimedOut){ $('#ov-inst-list').innerHTML='<div class="empty">实例数据读取超时，正在重试…</div>'; return; }
    let req=0,err=0,inTok=0,outTok=0,cached=0,maxUp=0;
    const models=new Set();
    for(const st of stats){
      req+=st.requests||0; err+=st.errors||0;
      if((st.uptime||0)>maxUp) maxUp=st.uptime||0;
      for(const v of Object.values(st.byChannel||{})){ inTok+=v.inputTokens||0; outTok+=v.outputTokens||0; }
      for(const [m,v] of Object.entries(st.byModel||{})){
        cached+=v.cached||0;
        if(((v.inputTokens||0)+(v.outputTokens||0)+(v.requests||0))>0) models.add(m);
      }
    }
    $('#ov-requests').textContent=fmtNum(req);
    $('#ov-errors').textContent=fmtNum(err);
    $('#ov-intok').textContent=fmtTok(inTok);
    $('#ov-outtok').textContent=fmtTok(outTok);
    $('#ov-cached').textContent=fmtTok(cached);
    $('#ov-hitrate').textContent=inTok?((cached/inTok)*100).toFixed(1)+'%':'-';
    $('#ov-models').textContent=models.size||'-';
    $('#ov-uptime').textContent=fmtDur(maxUp);
// About card: custom gateway name + one-glance summary from the data just gathered
    {
      const run=instances.filter(i=>i.running).length;
      const an=$('#ov-about-name'), av=$('#ov-about-ver'), al=$('#ov-about-lines');
      if(an) an.textContent=brandState.name;
      if(av){ av.textContent=brandState.ver; av.style.display=brandState.ver?'':'none'; }
      if(al) al.innerHTML=[
        `运行中 <b>${run}</b> / ${instances.length} 个实例 · 共 <b>${instances.reduce((a,i)=>a+(i.chCount||0),0)}</b> 个渠道`,
        `累计 <b>${fmtNum(req)}</b> 次请求 · 错误 <b>${fmtNum(err)}</b> · 使用模型 <b>${models.size}</b> 个`,
        `最长运行 <b>${fmtDur(maxUp)}</b> · 当前管理实例 <b>${esc(Store.inst||'default')}</b>`,
      ].map(l=>`<div>${l}</div>`).join('');
    }
    const ovList=$('#ov-inst-list');
    const ovLeft=ovList.scrollLeft;  // keep the carousel position across the 5s refresh
    ovList.innerHTML=instances.map(i=>cardItem({
      dot:i.running?'ok':'err',
      name:i.name,
      tags:i.tlsOn?'<span class="tag default">TLS</span>':'',
      state:i.running?'运行中':'已停止',
      stateCls:i.running?'ok':'err',
      tail:'<span class="msym" style="font-size:11px">chevron_right</span>',
      lines:[`端口 <b>${esc(i.port)}</b> · ${esc(i.chCount)} 渠道`],
      data:'data-goto="ports"',
    })).join('');
    ovList.scrollLeft=Math.min(ovLeft, ovList.scrollWidth-ovList.clientWidth);
    ovCarStart();
// Model plaza: pages of up to 8 models, in channel order — the carousel walks one channel's pages,
// then moves on to the next channel. Position is preserved across the 5s refresh like the inst list.
    try{
      const chans=await plazaChannels(signal);
      const ml=$('#ov-model-list');
      if(ml){
        const mLeft=ml.scrollLeft;
        const pages=[];
        for(const ch of chans){
          const pt=Math.ceil(ch.models.length/8);
          for(let i=0;i<ch.models.length;i+=8)
            pages.push({ch:ch.name,pi:Math.floor(i/8)+1,pt,total:ch.models.length,models:ch.models.slice(i,i+8)});
        }
        ml.innerHTML=pages.length?pages.map(p=>`
          <div class="model-page">
            <div class="model-page-head"><span class="nm">${esc(p.ch)}</span><span class="cnt">${p.pi}/${p.pt} 页 · 共 ${p.total} 个模型</span></div>
            <div class="model-grid">${p.models.map(m=>`<span class="model-chip" title="${escAttr(m)}">${esc(m)}</span>`).join('')}</div>
          </div>`).join('')
          :'<div class="empty">当前实例的渠道尚未配置模型</div>';
        ml.scrollLeft=Math.min(mLeft, ml.scrollWidth-ml.clientWidth);
      }
    }catch(e){ if(e.name!=='AbortError' && !$('#ov-model-list .model-page')) $('#ov-model-list').innerHTML='<div class="empty">模型列表读取失败： '+esc(e.message)+'</div>'; }
// Announcement carousel: latest 5, one page each, non-fatal on failure
    try{
      const d=await adapter.getAnnouncements(signal);
      const al=$('#ov-ann-list');
      anItems=d.items||[];  // anView resolves the clicked page here (the carousel previews only 5)
      if(al){
        const aLeft=al.scrollLeft;  // keep the carousel position across the 5s refresh
        al.innerHTML=anItems.slice(0,5).map(anPage).join('')||'<div class="empty">暂无公告</div>';
        al.scrollLeft=Math.min(aLeft, al.scrollWidth-al.clientWidth);
      }
    }catch(_){}
  }catch(e){ if(e.name!=='AbortError'){ console.error(e); snack(e.message,true); } }
  finally{ ovDisarm(); Store._ovBusy=false; }
}

// ============ Render: announcements ============
let anItems=[];
function anCard(a){
  return cardItem({
    name:a.title,
    state:fmtDateTime(a.at),
    lines:String(a.body||'').split('\n').filter(Boolean),
    data:`data-action="anView" data-name="${escAttr(a.id)}"`,
    acts:`<button class="pbtn pbtn-text" data-action="anView" data-name="${escAttr(a.id)}">查看</button>`+
         `<button class="pbtn pbtn-text" data-action="anEdit" data-name="${escAttr(a.id)}">编辑</button>`+
         `<button class="pbtn pbtn-text" data-action="anDel" data-name="${escAttr(a.id)}">删除</button>`,
  });
}
// Announcement detail -> the drawer (the same bottom sheet the dialogs use). The home carousel only
// previews three lines and the list page clamps one line per row, so this is the only place the full
// text lives -- and a long notice can never stretch a card again.
function openAnnounceView(a){
  if(!a) return;
  openDialog(a.title||'公告', `<div class="an-detail">
    <div class="an-detail-meta">${fmtDateTime(a.at)}</div>
    <div class="an-detail-body">${esc(a.body||'（无内容）')}</div>
  </div>`, {okText:'关闭', cancel:false});
}
// Home carousel: one page per announcement, latest 5 only. A page is one click target; the whole page
// opens the drawer, and Enter/Space does the same through the delegated keydown handler.
function anPage(a){
  return `<div class="an-page" data-action="anView" data-name="${escAttr(a.id)}" role="button" tabindex="0"
      aria-label="查看公告： ${escAttr(a.title)}" title="查看全文">
    <div class="an-page-head">
      <span class="an-title">${esc(a.title)}</span>
      <span class="an-time">${fmtDateTime(a.at)}</span>
      <span class="msym an-cue" aria-hidden="true">chevron_right</span>
    </div>
    <div class="an-body">${esc(a.body||'（无内容）')}</div>
  </div>`;
}
async function renderAnnounce(){
  const list=$('#an-list'); if(!list) return;
  try{
    const d=await adapter.getAnnouncements(Store.abort('announce'));
    anItems=d.items||[];
    list.innerHTML=anItems.length?anItems.map(anCard).join(''):'<div class="empty">暂无公告 — 请使用右上角「发布公告」添加</div>';
  }catch(e){
    if(e.name!=='AbortError') list.innerHTML='<div class="empty">读取失败： '+esc(e.message)+'</div>';
  }
}
function anLocalDT(ms){  // ms -> datetime-local string (local timezone)
  const d=new Date(ms), p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function openAnnounceDialog(a){
  openDialog(a?'编辑公告':'发布公告', `<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
    <md-outlined-text-field data-f="atitle" label="标题" value="${escAttr(a?a.title:'')}"></md-outlined-text-field>
    <md-outlined-text-field data-f="abody" label="内容（可换行）" type="textarea" rows="5" value="${escAttr(a?a.body||'':'')}"></md-outlined-text-field>
    <md-outlined-text-field data-f="atime" label="发布时间（留空表示当前时间）" type="datetime-local" value="${a&&a.at?anLocalDT(a.at):''}"></md-outlined-text-field>
  </div>`, {okText:a?'保存':'发布', onOk:async ()=>{
    const v=dlgValue();
    const title=String(v.atitle||'').trim();
    if(!title){ snack('标题不可为空',true); return false; }
    let at;
    if(String(v.atime||'').trim()){
      at=new Date(String(v.atime).trim()).getTime();
      if(!Number.isFinite(at)){ snack('发布时间格式无法识别',true); return false; }
    }
    try{
      await adapter.saveAnnouncement({id:a?a.id:undefined,title,body:String(v.abody||''),at});
      snack(a?'公告已保存':'公告已发布');
      renderAnnounce();
      return true;
    }catch(e){ snack(e.message,true); return false; }
  }});
}

// ============ Render: providers ============
// Channel entry: two-line card — name (+tags) on the top row, a summary block in the middle (every line
// truncates with an ellipsis and keeps the full text in title=), action buttons on their own bottom row.
function channelCard(ch){
  const models=(ch.models||[]).filter(Boolean);
  const mm=Object.entries(ch.modelMap||{}).filter(([k,v])=>v&&v!==k);
  const tags=`<span class="tag ${esc(ch.type)}">${esc(ch.type)}</span>`
    +(ch.default?'<span class="tag default">默认</span>':'')
    +(ch.useResponses?'<span class="tag default" title="上游使用 Responses API">⚡Responses</span>':'');
  const extra=[];
  if(ch.proxy && ch.proxy!=='-') extra.push('代理 '+esc(ch.proxy));
  if(ch.delayMs) extra.push('延迟 '+esc(String(ch.delayMs))+'ms');
  if(mm.length) extra.push('映射 '+mm.length+' 条');
  if(ch.balanceUrl) extra.push('自定义余额');
  if(ch.paramOverride) extra.push('参数覆写 '+esc(String(Object.keys(ch.paramOverride).length))+' 项');
  const lines=[
    `<span class="mono">${esc(ch.baseUrl||'-')}</span>`,
    `模型 ${models.length} · ${models.length?esc(models.join('、')):'未配置'}`,
  ];
  if(extra.length) lines.push(extra.join(' · '));
  return cardItem({
    dot: ch.default?'ok':'',
    name: ch.name,
    tags,
    side:`<span class="pv-bal loading" data-ch="${escAttr(ch.name)}" data-warn="${escAttr(ch.warnBelow||'')}" title="正在查询余额">···</span>`,
    lines,
    acts:`<button type="button" class="icon-act ${ch.default?'on':''}" data-action="setDefaultProvider" data-name="${escAttr(ch.name)}" ${ch.default?'disabled':''} title="${ch.default?'当前默认渠道':'设为默认渠道'}"><span class="msym">${ch.default?'star':'star_outline'}</span></button>
      <button type="button" class="icon-act" data-action="chBalance" data-name="${escAttr(ch.name)}" title="查询余额"><span class="msym">account_balance_wallet</span></button>
      <button type="button" class="icon-act" data-action="editProvider" data-name="${escAttr(ch.name)}" title="编辑"><span class="msym">edit</span></button>
      <button type="button" class="icon-act err" data-action="deleteProvider" data-name="${escAttr(ch.name)}" title="删除"><span class="msym">delete</span></button>`,
  });
}
async function renderProviders(){
  const signal=Store.abort('providers');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal); Store.configs.set(cur,cfg);
    const chs=cfg.channels||[];
    $('#pv-list').innerHTML=chs.length?chs.map(channelCard).join(''):'<div class="empty">该实例暂无渠道，请使用右上角「添加渠道」</div>';
    fillProviderBalances(cur, signal);  // async: the cards paint first, balances land per channel
    const px=Object.entries(cfg.proxies||{});
    $('#px-list').innerHTML=px.length?px.map(([n,p])=>cardItem({
      name:n,
      tags:`<span class="tag">${esc(p.type||'socks5')}</span>`,
      lines:[`<span class="mono">${esc(p.host+':'+p.port)}</span>${p.username?' · 用户名认证':''}`],
      acts:`<button type="button" class="icon-act" data-action="editProxy" data-name="${escAttr(n)}" title="编辑"><span class="msym">edit</span></button>
        <button type="button" class="icon-act err" data-action="delProxy" data-name="${escAttr(n)}" title="删除"><span class="msym">delete</span></button>`,
    })).join(''):'<div class="empty">暂无代理；渠道可留空，直接连接</div>';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}

//// clicking a channel name/star -> set as default (other channels lose the marker; the instance auto-restarts after saving)
async function setDefaultChannel(n){
  try{
    const cfg=await adapter.getConfig(Store.inst);
    const chs=(cfg.channels||[]).map(c=>{ const{hasKey,...rest}=c; rest.default=c.name===n; return rest; });
    if(!chs.some(c=>c.name===n)) return;
    await adapter.saveConfig(Store.inst,{channels:chs});
    snack('已将 '+n+' 设为默认渠道');
    await renderProviders();
  }catch(e){ snack(e.message,true); }
}

// ============ Render: routing ============
let rtExtra=[];   // custom privacy-filter regexes; written on 保存设置, never on keystroke
function rtRenderChips(){
  const box=$('#rt-extra-chips'); if(!box) return;
  box.innerHTML=rtExtra.length?rtExtra.map((r,i)=>
    `<span class="mm-chip" data-i="${i}"><span class="nm mono" title="${escAttr(r)}">${esc(r)}</span><button class="mm-x" data-i="${i}" aria-label="删除">✕</button></span>`).join('')
    :'<span class="muted small">暂无自定义规则 — 请填写上方正则后点击 + 添加</span>';
}
function rtAddChip(){
  const f=$('#rt-extra-find'); if(!f) return;
  const re=String(f.value||'').trim();
  if(!re){ snack('请先填写一条正则',true); return; }
  try{ new RegExp(re); }catch(e){ snack('正则表达式无效： '+e.message,true); return; }
  if(rtExtra.includes(re)){ snack('该规则已存在',true); return; }
  if(rtExtra.length>=50){ snack('最多 50 条规则',true); return; }
  rtExtra.push(re); f.value=''; rtRenderChips();
}
async function renderRouting(){
  const signal=Store.abort('routing');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal); Store.configs.set(cur,cfg);
    const r=cfg.routing||{};
    $('#rt-maxRetry').value=String(r.maxRetry??3); $('#rt-timeout').value=String(r.timeoutSec??60); $('#rt-cooldown').value=String(r.cooldownSec??30);
    $('#rt-redact').selected=!((cfg.redact||{}).enable===false);
    $('#rt-redactRes').selected=!!((cfg.redact||{}).response);
    rtExtra=((cfg.redact||{}).extra||[]).map(x=>String(x)).filter(Boolean); rtRenderChips();
    $('#rt-modelSync').selected=!((cfg.modelSync||{}).enable===false);
    $('#rt-syncInterval').value=String((cfg.modelSync||{}).intervalHours??24);
    $('#rt-paramOverride').value=cfg.paramOverride?JSON.stringify(cfg.paramOverride,null,2):'';
    const chs=cfg.channels||[];
    // Table instead of a stack of list items: every cell truncates with an ellipsis and keeps the full value
    // in title=, so a channel with 20 models no longer makes one row five lines tall.
    $('#rt-channels').innerHTML = chs.length ? `<div class="tbl-wrap"><table class="tbl" id="rt-ch-table" aria-label="渠道与映射">
      <thead><tr><th style="width:34%">名称</th><th style="width:24%">渠道</th><th style="width:9%">类型</th><th style="width:21%">映射</th><th style="width:12%">地址</th></tr></thead>
      <tbody>${chs.map(ch=>{
        const tags=(ch.default?' <span class="tag default">default</span>':'')+(ch.useResponses?' <span class="tag default" title="该 OpenAI 渠道的上游使用 Responses API">⚡Responses</span>':'');
        const ms=[]; for(const m of (ch.models||[])) if(!ms.includes(m)) ms.push(m);
        for(const k of Object.keys(ch.modelMap||{})) if(!ms.includes(k)) ms.push(k);
        if(!ms.length) return `<tr>
          <td class="truncate"><span class="muted">未配置模型</span></td>
          <td class="mono truncate" title="${escAttr(ch.name)}">${esc(ch.name)}${tags}</td>
          <td title="${escAttr(ch.type)}"><span class="tag ${esc(ch.type)}">${esc(ch.type)}</span></td>
          <td class="truncate"><span class="muted">-</span></td>
          <td class="mono truncate" title="${escAttr(ch.baseUrl)}">${esc(fmtHost(ch.baseUrl))}</td>
        </tr>`;
        return ms.map(m=>{
          const mv=(ch.modelMap||{})[m], mapped=mv!==undefined&&mv!==m&&mv!=='';
          const orig=mapped?mv:m; // 名称列取原始(上游真实)名; 无映射时请求名原样发上游, 原名即模型名
          const mapTxt=mapped?m+' → '+mv:'';
          return `<tr>
          <td class="mono truncate" title="${escAttr(orig)}">${esc(orig)}</td>
          <td class="mono truncate" title="${escAttr(ch.name)}">${esc(ch.name)}${tags}</td>
          <td title="${escAttr(ch.type)}"><span class="tag ${esc(ch.type)}">${esc(ch.type)}</span></td>
          <td class="mono truncate"${mapped?` title="${escAttr(mapTxt)}"`:''}>${mapped?esc(mapTxt):'<span class="muted">-</span>'}</td>
          <td class="mono truncate" title="${escAttr(ch.baseUrl)}">${esc(fmtHost(ch.baseUrl))}</td>
        </tr>`;
        }).join('');
      }).join('')}</tbody></table></div>` : '<div class="empty">无渠道</div>';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}

// ============ Render: keys ============
async function renderKeys(){
  const signal=Store.abort('keys');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const cfg=await adapter.getConfig(cur,signal);


    $('#ky-webToken').value = cfg.webToken && cfg.webToken!=='(已设)' ? cfg.webToken : '';
    $('#ky-webToken').placeholder = cfg.webToken==='(已设)' ? '（已设，留空表示不修改）' : '留空表示不启用 API 令牌';
    $('#ky-channels').innerHTML=(cfg.channels||[]).map(ch=>
      `<md-outlined-text-field data-keyfor="${escAttr(ch.name)}" label="${esc(ch.name)} (${esc(ch.type)})" type="password" value="${esc(ch.apiKey||'')}" placeholder="${ch.hasKey?'（已设）':'API Key'}"></md-outlined-text-field>`
    ).join('');
    $('#rg-keyLength').value=cfg.keyLength||24;
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
  loadAdminAuth(cur);
}

// ---- Admin second factor ----
async function loadAdminAuth(inst){
  try{
    const d=await adapter.getAdminAuth(inst);
    $('#ka-status').innerHTML = '管理密码： '+(d.hasAdminKey?'<b style="color:var(--md-sys-color-primary)">已设</b>':'<b style="color:var(--md-sys-color-error)">未设置（危险）</b>')
      +' · 第二密码： '+(d.secondKeySet?'<b style="color:var(--md-sys-color-primary)">已启用</b>':'未启用')
      +' · TOTP: '+(d.totpEnabled?'<b style="color:var(--md-sys-color-primary)">已启用</b>':'未启用');
    $('#ka-totp-info').style.display = d.totpEnabled ? '' : 'none';
    // the secret itself is only returned once, right after enable (POST /admin-api/admin-auth)
    const pf=d.profile||{};
    $('#ka-profile-name').textContent = pf.name || '（未设置名称）';
    $('#ka-profile-text').textContent = pf.profile || '';
    $('#ka-profile-other').textContent = pf.other || '';
    const av=$('#ka-profile-avatar');
    if(pf.avatar){ av.src=pf.avatar; av.style.display=''; } else { av.removeAttribute('src'); av.style.display='none'; }
    $('#ka-profile-expire').textContent = d.expireAt ? ('面板会话将于 '+new Date(d.expireAt).toLocaleString()+' 到期') : '';
  }catch(e){ $('#ka-status').textContent='加载失败： '+e.message; }
}

// ---- Card settings save ----
async function saveCardSettings(){
  try{
    await adapter.saveConfig(Store.inst,{ keyLength:Number($('#rg-keyLength').value)||24 });
    snack('卡密设置已保存');
  }catch(e){ snack(e.message,true); }
}

// ============ Render: ports ============
async function renderPorts(){
  const signal=Store.abort('ports');
  try{
    const data=await adapter.getInstances(signal);
    const instances=data.instances; if(data.current) Store.currentName=data.current;
    Store.multi=!!data.multi; Store.mainPort=data.mainPort||0;
    $('#pt-list').innerHTML=instances.map(i=>{
      const isSelf=i.name===Store.currentName;
      let power;
      if(!i.running) power=`<md-filled-button data-cmd="start" data-name="${escAttr(i.name)}">启动</md-filled-button>`;
      else if(Store.multi&&i.name==='default') power=`<md-text-button disabled title="单进程模式：default 承载主端口，无法停止">停止 <span class="msym">lock</span></md-text-button>`;
      else power=`<md-text-button data-cmd="stop" data-name="${escAttr(i.name)}" style="color:var(--md-sys-color-error)">停止</md-text-button>`;
      const prefix=Store.multi?(i.name==='default'?'无前缀':('/'+i.name)):null;
      const tags=(isSelf?'<span class="tag default"><span class="msym">home</span>面板</span>':'')+(i.tlsOn?'<span class="tag default">TLS</span>':'');
      return cardItem({
        dot:i.running?'ok':'err',
        name:i.name,
        tags,
        state:i.running?'运行中':'已停止',
        stateCls:i.running?'ok':'err',
        lines:[
          `端口 <b>${esc(i.port)}</b> · ${esc(i.chCount)} 渠道`,
          prefix?`主端口路径 <span class="mono">${esc(prefix)}/v1</span>`:'',
        ],
        acts:`<md-outlined-button data-action="openPortDialog" data-name="${escAttr(i.name)}">编辑</md-outlined-button><md-text-button data-cmd="restart" data-name="${escAttr(i.name)}" title="热重载配置">重载</md-text-button>${power}`,
      });
    }).join('');
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
  loadTunnel();
}

// ---- cloudflared tunnel ----
let tnTimer=null;
async function loadTunnel(){
  try{
    const d=await adapter.getTunnel();
    renderTunnel(d);
    if(d.running && !d.url){ clearTimeout(tnTimer); tnTimer=setTimeout(loadTunnel,2000); }
  }catch(e){ $('#tn-status').textContent='查询失败： '+e.message; }
}
function renderTunnel(d){
  $('#tn-toggle').textContent = d.running ? '停止隧道' : '启动隧道';
  if(d.running && d.url){
    $('#tn-status').innerHTML='<b style="color:var(--md-sys-color-primary)">运行中</b>';
    $('#tn-url-row').style.display='flex';
    $('#tn-url').textContent=d.url;
  } else if(d.running){
    $('#tn-status').textContent='启动中，正在等待域名分配…';
    $('#tn-url-row').style.display='none';
  } else {
    $('#tn-status').textContent='未启动';
    $('#tn-url-row').style.display='none';
  }
}

// ============ Render: key card management ============
// A card is one user: quota + expiry + role + rate limits (RPM/TPM) + instance/provider/model
// whitelists. Editing always writes the complete permission set, so clearing a checkbox really
// removes that permission instead of leaving a stale value behind.
let cardCache = [];
function fmtTok(n){ return shortNum(n); }
function splitList(s){ return [...new Set(String(s||'').split(/[,，\n]+/).map(x=>x.trim()).filter(Boolean))]; }
function cardPermBox(field, options, selected){
  const sel=Array.isArray(selected)?selected:[];
  const all=Array.isArray(options)?options.slice():[];
  for(const x of sel) if(x && !all.includes(x)) all.push(x);
  const rows=all.length?all.map(o=>`<label class="perm-item" title="${escAttr(o)}"><input type="checkbox" value="${escAttr(o)}" ${sel.includes(o)?'checked':''}><span>${esc(o)}</span></label>`).join('')
    :'<span class="perm-empty">暂无可选项</span>';
  return `<div class="perm-box" data-perm="${field}">${rows}</div>`;
}
function permChecked(field){
  return $$(`#dlgBody [data-perm="${field}"] input:checked`).map(i=>i.value);
}
function cardDialogHtml(k){
  const cfg=Store.configs.get(Store.inst)||{};
  const insts=(Store.instances||[]).map(i=>i.name);
  const chs=(cfg.channels||[]).map(c=>c.name);
  const chExtra=(k&&k.channels||[]).filter(x=>!chs.includes(x));
  const quota=Number(k&&k.quotaTokens||0);
  const role=k&&k.role==='admin'?'admin':'user';
  return `
    <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="名称（使用对象）" value="${escAttr(k&&k.name||'')}" required></md-outlined-text-field>
      <md-outlined-select data-f="role" label="角色" helper="用户卡用于调用 API；管理卡仅可访问管理 API">
        <md-select-option value="user" ${role!=='admin'?'selected':''}>用户卡（调用 API）</md-select-option>
        <md-select-option value="admin" ${role==='admin'?'selected':''}>管理卡（管理 API）</md-select-option>
      </md-outlined-select>
      <md-outlined-text-field data-f="quotaWan" label="额度（万 tokens）" type="number" value="${quota?String(quota/10000):'0'}" helper="0 或留空表示不限量；100 表示 100 万 tokens"></md-outlined-text-field>
      <div class="grid-form">
        <md-outlined-text-field data-f="rpm" label="RPM（次/分钟）" type="number" value="${Number(k&&k.rpm)||0}" helper="0 表示不限；60 秒滑动窗口"></md-outlined-text-field>
        <md-outlined-text-field data-f="tpm" label="TPM（tokens/分钟）" type="number" value="${Number(k&&k.tpm)||0}" helper="0 表示不限；按输入与输出合计"></md-outlined-text-field>
      </div>
      <md-outlined-text-field data-f="expiresAt" label="有效期（留空表示永久）" value="${escAttr(k&&k.expiresAt||'')}" placeholder="2026-12-31" helper="到期后自动拒绝；支持 YYYY-MM-DD"></md-outlined-text-field>
      <div class="perm-title">实例权限 <span class="perm-hint">不勾选表示仅限发卡实例；跨实例使用需勾选目标实例</span></div>
      ${cardPermBox('branches', insts, k&&k.branches)}
      <div class="perm-title">提供商权限 <span class="perm-hint">不勾选表示当前实例的全部提供商</span></div>
      ${cardPermBox('channels', chs, k&&k.channels)}
      <md-outlined-text-field data-f="channelsExtra" label="额外提供商（逗号分隔，可留空）" value="${escAttr(chExtra.join(', '))}" helper="其他实例的提供商名或 * 通配符；与上方勾选结果合并"></md-outlined-text-field>
      <md-outlined-text-field data-f="models" label="模型权限（逗号分隔）" value="${escAttr((k&&k.models||[]).join(', '))}" helper="留空表示全部；支持 * 通配符，例如 gpt-4*"></md-outlined-text-field>
      <md-outlined-text-field data-f="note" label="备注（可选）" value="${escAttr(k&&k.note||'')}"></md-outlined-text-field>
    </div>`;
}
function cardBodyFromDialog(key){
  const v=dlgValue();
  const quotaWan=Number(v.quotaWan)||0;
  const limit=v=>Math.max(0,Math.floor(Number(v)||0));
  return {
    key,
    name:String(v.name||'').trim(),
    role:v.role==='admin'?'admin':'user',
    quotaTokens:Math.round(quotaWan*10000),
    rpm:limit(v.rpm), tpm:limit(v.tpm),
    models:splitList(v.models),
    channels:[...new Set([...permChecked('channels'), ...splitList(v.channelsExtra)])],
    branches:permChecked('branches'),
    expiresAt:String(v.expiresAt||'').trim(),
    note:String(v.note||'').trim(),
  };
}
async function renderCards(){
  const signal=Store.abort('cards');
  const cur=await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  try{
    const [data,cfg]=await Promise.all([adapter.getKeys(cur,signal), adapter.getConfig(cur,signal)]);
    Store.configs.set(cur,cfg);
    const keys=data.keys||[];
    cardCache=keys;
    if(!keys.length){ $('#cd-list').innerHTML='<div class="empty" style="padding:24px;text-align:center;color:var(--md-sys-color-on-surface-variant)">暂无用户卡 · 请使用右上角「发卡」新建</div>'; return; }
    $('#cd-list').innerHTML=keys.map(k=>{
      const quota=k.quotaTokens||0, used=k.usedTokens||0;
      const pct=quota>0?Math.min(100,Math.round(used/quota*100)):0;
      const ERROR_COLOR='var(--md-sys-color-error)';
      let state,stateColor;
      if(!k.enable){ state='已禁用'; stateColor=ERROR_COLOR; }
      else if(k.expiresAt && new Date(k.expiresAt).getTime()<Date.now()){ state='已过期'; stateColor=ERROR_COLOR; }
      else if(quota>0&&used>=quota){ state='已用尽'; stateColor=ERROR_COLOR; }
      else { state='启用中'; stateColor='var(--md-sys-color-primary)'; }
      const lim=[];
      if(k.rpm) lim.push('RPM '+k.rpm+'/分');
      if(k.tpm) lim.push('TPM '+fmtTok(k.tpm)+'/分');
      const limTxt=lim.length?lim.join(' · '):'不限流';
      const now=[];
      if(k.rpm) now.push('RPM '+(k.rpmUsed||0)+'/'+k.rpm);
      if(k.tpm) now.push('TPM '+fmtTok(k.tpmUsed||0)+'/'+fmtTok(k.tpm));
      const nowTxt=now.length?('本分钟 '+now.join(' · ')):'';
      const perm=[
        '实例 '+((k.branches&&k.branches.length)?k.branches.join('/'):('仅 '+Store.inst)),
        '提供商 '+((k.channels&&k.channels.length)?k.channels.join('/'):'全部'),
        '模型 '+((k.models&&k.models.length)?k.models.join('/'):'全部'),
      ];
      const permTxt=perm.slice(0,2).join(' · '), modelTxt=perm[2];
      const expireTxt=k.expiresAt?`${String(k.expiresAt).slice(0,10)}到期`:null;
      return cardItem({
        dot:stateColor===ERROR_COLOR?'err':'ok',
        name:k.name||'（无名卡）',
        tags:`<span class="tag" style="color:${k.role==='admin'?'var(--md-sys-color-tertiary)':stateColor}">${k.role==='admin'?'管理':state}</span>`,
        lines:[
          `<span class="mono">${esc(k.key.slice(0,10))}…</span> · 用量 ${fmtTok(used)}${quota>0?' / '+fmtTok(quota)+' ('+pct+'%)':'（不限额）'} · ${esc(limTxt)}`,
          nowTxt?esc(nowTxt):'',
          esc(permTxt),
          esc(modelTxt),
          expireTxt?esc(expireTxt):'',
          k.note?('备注 '+esc(k.note)):'',
        ],
        acts:`<md-text-button data-action="copyKey" data-key="${escAttr(k.key)}">复制</md-text-button>
          <md-text-button data-action="editKey" data-key="${escAttr(k.key)}">编辑</md-text-button>
          <md-text-button data-action="toggleKey" data-key="${escAttr(k.key)}" data-on="${k.enable?1:0}">${k.enable?'禁用':'启用'}</md-text-button>
          <md-text-button data-action="rechargeKey" data-key="${escAttr(k.key)}" data-name="${escAttr(k.name||'')}">充值</md-text-button>
          <md-text-button data-action="delKey" data-key="${escAttr(k.key)}" data-name="${escAttr(k.name||'')}" style="color:var(--md-sys-color-error)">删除</md-text-button>`,
      });
    }).join('');
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}
// ---- Key-issuing dialog ----
async function openCardDialog(){
  if(!Store.configs.get(Store.inst)){
    try{ Store.configs.set(Store.inst, await adapter.getConfig(Store.inst)); }catch(e){}
  }
  openDialog('发新卡（实例 '+Store.inst+'）', cardDialogHtml(null), {onOk:async ()=>{
    const body=cardBodyFromDialog(undefined);
    if(!body.name){ snack('名称必填',true); return false; }
    try{
      const r=await adapter.createKey(Store.inst,body);
      const k=r.key||{};
      openDialog('发卡成功', `<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
        <div style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">完整 Key（可在配置中查看，也可随时返回复制）：</div>
        <div class="mono" style="word-break:break-all;background:var(--md-sys-color-surface-container);padding:8px;border-radius:10px;user-select:all">${esc(k.key||'')}</div>
        <div style="font-size:10px">客户端用法：base_url 填写 <span class="mono">http://&lt;网关地址&gt;:${Store.mainPort||'主端口'}/${esc(Store.inst==='default'?'':Store.inst+'/')}v1</span>（末尾 /v1 可省略），API Key 填写上方 Key</div>
        <md-filled-button id="cd-copy-new">复制 Key</md-filled-button>
      </div>`, {okText:'关闭', cancel:false});
      setTimeout(()=>{ const b=$('#cd-copy-new'); if(b) b.onclick=()=>{ navigator.clipboard&&navigator.clipboard.writeText(k.key||''); snack('已复制'); }; },50);
      renderCards();
      return false;
    }catch(e){ snack(e.message,true); return false; }
    return true;
  }});
}
// ---- Edit an existing card: same form, complete permission set ----
function openCardEdit(key){
  const k=cardCache.find(x=>x.key===key);
  if(!k){ snack('卡密列表已刷新，请重试',true); return; }
  openDialog('编辑用户卡 · '+(k.name||key.slice(0,10)), cardDialogHtml(k), {onOk:async ()=>{
    const body=cardBodyFromDialog(key);
    if(!body.name){ snack('名称必填',true); return false; }
    try{ await adapter.updateKey(Store.inst,body); snack('已保存'); renderCards(); }
    catch(e){ snack(e.message,true); return false; }
    return true;
  }});
}
// ---- Key card operations ----
async function cardAction(action,key,name,on){
  try{
    if(action==='copyKey'){ await navigator.clipboard.writeText(key); snack('已复制完整 Key'); return; }
    if(action==='editKey'){ openCardEdit(key); return; }
    if(action==='toggleKey'){ await adapter.updateKey(Store.inst,{key,enable:!on}); snack(on?'已禁用':'已启用'); renderCards(); return; }
    if(action==='delKey'){
      if(!confirm('删除卡密「'+(name||key.slice(0,10))+'」？该 Key 立即失效。')) return;
      await adapter.deleteKey(Store.inst,key); snack('已删除'); renderCards(); return;
    }
    if(action==='rechargeKey'){
      openDialog('充值/重置 「'+esc(name||'')+'」', `
        <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
          <md-outlined-text-field data-f="addWan" label="追加额度（万 tokens）" type="number" value="0" helper="在现有额度上追加；0 表示不变"></md-outlined-text-field>
          <label style="display:flex;align-items:center;gap:4px;font-size:11px"><md-checkbox data-f="reset"></md-checkbox>重置已用量为 0</label>
          <label style="display:flex;align-items:center;gap:4px;font-size:11px"><md-checkbox data-f="resetRate"></md-checkbox>清除本分钟 RPM/TPM 窗口</label>
        </div>`, {onOk:async ()=>{
          const v=dlgValue();
          const body={key};
          const addWan=Number(v.addWan)||0;
          if(addWan>0) body.addQuota=Math.round(addWan*10000);
          const resetEl=$('#dlgBody md-checkbox[data-f="reset"]');
          if(resetEl && resetEl.selected) body.resetUsage=true;
          const resetRateEl=$('#dlgBody md-checkbox[data-f="resetRate"]');
          if(resetRateEl && resetRateEl.selected) body.resetRate=true;
          try{ await adapter.updateKey(Store.inst,body); snack('已更新'); renderCards(); }catch(e){ snack(e.message,true); return false; }
          return true;
        }});
      return;
    }
  }catch(e){ snack(e.message,true); }
}

// ---- Channel balances ----
// Provider cards carry the upstream balance, so it is readable without opening anything. One batched
// request fills every card (the gateway caches successful lookups for balanceCacheSec); a channel that
// has no balance endpoint simply loses its badge instead of showing an error for something unconfigured.
function balLabel(bal, unit){
  const u=String(unit||'').trim();
  const sym={CNY:'¥',RMB:'¥',USD:'$',EUR:'€',HKD:'HK$',TWD:'NT$',GBP:'£'}[u.toUpperCase()]||'';
  const v=String(bal==null?'':bal).trim();
  return sym?sym+v:(u?v+' '+u:v);
}
function pvBalEls(){
  const out=new Map();
  $$('#pv-list .pv-bal').forEach(el=>{ if(el.dataset.ch) out.set(el.dataset.ch, el); });
  return out;
}
function pvPaintBal(el, item){
  if(!el) return;
  if(!item || item.noTarget){ el.remove(); return; }
  el.classList.remove('loading','err','low');
  if(!item.ok){
    el.textContent='—'; el.classList.add('err');
    el.title='余额查询失败： '+(item.error||'未知错误');
    return;
  }
  el.textContent=balLabel(item.balance, item.unit);
  const warn=Number(el.dataset.warn)||0, n=Number(item.balance);
  const low=warn>0 && isFinite(n) && n<=warn;
  if(low) el.classList.add('low');
  el.title='余额 '+balLabel(item.balance,item.unit)+(item.unit?' ('+item.unit+')':'')
    +(low?' · 低于预警阈值 '+warn:'')+(item.url?' · '+item.url:'');
}
// seq guards against a slow response landing on a re-rendered list (channel edits re-render the page)
let pvBalSeq=0;
async function fillProviderBalances(inst, signal){
  const seq=++pvBalSeq;
  let r;
  try{ r=await adapter.getBalances(inst, signal); }
  catch(e){
    if(e.name==='AbortError') return;
    pvBalEls().forEach(el=>pvPaintBal(el,{ok:false,error:e.message}));
    return;
  }
  if(seq!==pvBalSeq) return;
  const byCh=new Map(((r&&r.items)||[]).map(it=>[it.channel, it]));
  pvBalEls().forEach((el,ch)=>pvPaintBal(el, byCh.get(ch)||{ok:false,error:'该渠道未返回余额'}));
}
async function chBalanceAction(chName){
  snack('查询 '+chName+' 余额…');
  try{
    const r=await adapter.getBalance(Store.inst,chName);
    pvPaintBal(pvBalEls().get(chName), {ok:true, balance:r.balance, unit:r.unit, url:r.url});
    openDialog('渠道余额 · '+esc(chName), `<div style="padding:4px 0;text-align:center">
      <div style="font-size:26px;font-weight:600;color:var(--md-sys-color-primary)">${esc(String(r.balance))} <span style="font-size:11px">${esc(r.unit||'')}</span></div>
      <div class="muted small" style="margin-top:8px">${esc(r.url||'')}</div></div>`, {hideCancel:true});
  }catch(e){ snack(e.message,true); }
}

// ============ Render: statistics ============
const DIST_LABEL={system:'系统提示',history:'对话历史',tools:'工具定义',user:'用户输入',reasoning:'思考内容',text:'正文',tool:'ToolCall'};
const DIST_KEYS=['system','history','tools','user','reasoning','text','tool'];
function chartMode(kind){ return (Store.chartMode&&Store.chartMode[kind])||'bar'; }
function syncChartTabs(){
  $$('[data-chart]').forEach(b=>b.classList.toggle('on', b.dataset.mode===chartMode(b.dataset.chart)));
}
// Every view of a chart is a pane of one scroll-snap track, so switching a view is a sideways scroll:
// the two drawings stay tiled while they move, and a swipe on the chart switches it just like the tabs.
const CHART_VIEWS={daily:['bar','line'],model:['bar','pie'],dist:['hbar','pie']};
const chartScrollT={}, chartActiveUntil={};
function chartCanvasId(kind,mode){ return 'st-chart-'+kind+'-'+mode; }
function chartTrack(kind){ return $('#ct-track-'+kind); }
function chartPaneIdx(kind){
  const i=(CHART_VIEWS[kind]||[]).indexOf(chartMode(kind));
  return i<0?0:i;
}
// Scrolls a track onto the pane of its current mode. The track width is 0 while the stats page is
// hidden, so nothing happens until it is rendered; force ignores the "someone is scrolling" guard.
function alignChartTrack(kind, smooth, force){
  const tr=chartTrack(kind); if(!tr) return;
  const w=tr.clientWidth; if(!w) return;
  const left=chartPaneIdx(kind)*w;
  if(Math.abs(tr.scrollLeft-left)<2) return;
  if(!smooth && !force && chartActiveUntil[kind]>Date.now()) return;
  if(smooth && !reducedMotion()){
    chartActiveUntil[kind]=Date.now()+500;
    try{ tr.scrollTo({left, behavior:'smooth'}); return; }catch(_){}
  }
  tr.scrollLeft=left;
}
function alignChartTracks(smooth, force){ for(const k in CHART_VIEWS) alignChartTrack(k, smooth, force); }
function drawChart(kind, mode){
  const c=Store.charts; if(!c) return;
  const id=chartCanvasId(kind,mode);
  if(kind==='daily') drawDailyChart(c.daily||[], mode, id);
  else if(kind==='model') drawModelChart(c.models||[], mode, id);
  else drawDistChart(c.dist||[], mode, id);
}
function drawAllCharts(){
  for(const k in CHART_VIEWS) for(const m of CHART_VIEWS[k]) drawChart(k,m);
}
function saveChartMode(kind,mode){
  Store.chartMode=Object.assign({daily:'bar',model:'bar',dist:'hbar'},Store.chartMode,{[kind]:mode});
  try{ localStorage.setItem('agw-chart',JSON.stringify(Store.chartMode)); }catch(_){}
  syncChartTabs();
}
function setChartMode(kind,mode){
  if(chartMode(kind)!==mode) saveChartMode(kind,mode);
  alignChartTrack(kind, true);
}
// A swipe settles on a pane: mirror the pane that landed back into the tabs and the saved mode.
function onChartScroll(ev){
  const tr=ev.currentTarget, kind=tr.dataset.track; if(!kind) return;
  chartActiveUntil[kind]=Date.now()+500;
  clearTimeout(chartScrollT[kind]);
  chartScrollT[kind]=setTimeout(()=>{
    const w=tr.clientWidth; if(!w) return;
    const mode=(CHART_VIEWS[kind]||[])[Math.round(tr.scrollLeft/w)];
    if(mode && chartMode(kind)!==mode) saveChartMode(kind,mode);
  },140);
}
function bindChartTracks(){
  $$('.chart-track').forEach(tr=>tr.addEventListener('scroll', onChartScroll, {passive:true}));
}
// ---- Usage granularity: 1D (day) / 1H (hour) / 1M (minute) ----
// Day buckets are the long-running totals the gateway has always kept; hourly (7 days) and minutely
// (4 hours) buckets are recorded alongside them so the same card can zoom in without a refetch.
// Bucket keys are UTC (gateway convention), so every label here is UTC clock time.
const GRAN_NOTE={'1D':'最近 14 天 · 单位 Token','1H':'最近 24 小时 · UTC · 单位 Token','1M':'最近 60 分钟 · UTC · 单位 Token'};
function syncGranTabs(){ $$('[data-gran]').forEach(b=>b.classList.toggle('on', b.dataset.gran===Store.gran)); }
function granSeries(s){
  s=s||{};
  const g=Store.gran||'1D';
  if(g==='1H'||g==='1M'){
    const n=g==='1H'?24:60, step=g==='1H'?3600e3:60e3;
    const src=(g==='1H'?s.hourly:s.minutely)||{};
    const base=Math.floor(Date.now()/step)*step, out=[];
    for(let i=n-1;i>=0;i--){
      const iso=new Date(base-i*step).toISOString();
      const key=iso.slice(0,10)+' '+iso.slice(11, g==='1H'?13:16);
      const v=src[key]||{};
      out.push({label:g==='1H'?iso.slice(11,13)+':00':iso.slice(11,16), in:v.inputTokens||0, out:v.outputTokens||0});
    }
    return out;
  }
  return Object.entries(s.daily||{}).sort((x,y)=>x[0].localeCompare(y[0])).slice(-14)
    .map(([d,v])=>({label:String(d).slice(5), in:v.inputTokens||0, out:v.outputTokens||0}));
}
function setGran(g){
  if(!GRAN_NOTE[g] || g===Store.gran) return;
  Store.gran=g;
  try{ localStorage.setItem('agw-gran',g); }catch(_){}
  syncGranTabs();
  const note=$('#st-gran-note'); if(note) note.textContent=GRAN_NOTE[g];
  if(!Store.statsRaw || !Store.charts || Store.page!=='stats') return;
  Store.charts.daily=granSeries(Store.statsRaw);
  // redraw both panes of the daily track: the other one is one swipe away and must not show old buckets
  for(const m of (CHART_VIEWS.daily||[])) drawChart('daily', m);
}
async function renderStats(){
  if(Store._stBusy) return;
  Store._stBusy=true;
  let stDisarm=()=>{};
  let stTimedOut=false;
  try{
    const signal=Store.abort('stats');
    stDisarm=Store.armTimeout('stats',20000,()=>{ stTimedOut=true; });
    const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
    const s=await adapter.getStats(cur,signal);
    const chs=Object.values(s.byChannel||{});
    const sumIn=chs.reduce((t,d)=>t+(d.inputTokens||0),0);
    const sumOut=chs.reduce((t,d)=>t+(d.outputTokens||0),0);
    const bm=Object.entries(s.byModel||{});
    const sumCached=bm.reduce((t,[,d])=>t+(d.cached||0),0);
    $('#st-requests').textContent=fmtNum(s.requests);
    $('#st-errors').textContent=fmtNum(s.errors);
    $('#st-intok').textContent=fmtTok(sumIn);
    $('#st-outtok').textContent=fmtTok(sumOut);
    $('#st-cached').textContent=fmtTok(sumCached);
    $('#st-hitrate').textContent=sumIn?((sumCached/sumIn)*100).toFixed(1)+'%':'-';
    $('#st-uptime').textContent=fmtDur(s.uptime);
    $('#st-rps').textContent=((s.requests||0)/(s.uptime||1)).toFixed(2);
// Token distribution, aggregated across every day
    const D={}; for(const k of DIST_KEYS) D[k]=0;
    for(const v of Object.values(s.daily||{})){ for(const k of DIST_KEYS) D[k]+=(v.dist&&v.dist[k])||0; }
    const dTot=DIST_KEYS.reduce((t,k)=>t+D[k],0);
    $('#st-dist-note').textContent=dTot?' · 合计 '+fmtTok(dTot)+' tokens':'';
    const dist=DIST_KEYS.map(k=>({name:DIST_LABEL[k],value:D[k]})).filter(r=>r.value>0).sort((a,b)=>b.value-a.value);
    const models=bm.map(([m,d])=>({name:m,value:(d.inputTokens||0)+(d.outputTokens||0),requests:d.requests||0})).sort((a,b)=>b.value-a.value);
    Store.statsRaw=s;
    Store.charts={daily:granSeries(s), models, dist};
    const note=$('#st-gran-note'); if(note) note.textContent=GRAN_NOTE[Store.gran]||GRAN_NOTE['1D'];
    syncChartTabs(); syncGranTabs(); drawAllCharts(); alignChartTracks(false);
  }catch(e){
    if(e.name==='AbortError'){ if(stTimedOut) $('#st-requests').textContent='超时'; }
    else snack(e.message,true);
  }
  finally{ stDisarm(); Store._stBusy=false; }
}

// ============ Render: logs (merged with the request record) ============
// Last record settings read from (or written to) the instance; used to skip saving when nothing changed
let rqSaved={enable:false,server:''};
let rqSaving=false, rqPending=false;
function renderReqRows(reqs){
  const rows=(reqs||[]).map(r=>{
    const tp=String(r.time||'').split(' ');
    return `<tr>
      <td class="mono"><span class="rq-date">${esc(tp[0]||'')} </span>${esc(tp[1]||tp[0]||'')}</td>
      <td class="mono truncate" title="${escAttr(r.model)}">${esc(r.model)}</td>
      <td class="mono truncate" title="${escAttr(r.channel)}">${esc(r.channel)}</td>
      <td title="HTTP ${r.status}">${r.status===200?'<span style="color:#4CA2A0">✓</span>':'<span style="color:var(--md-sys-color-error)">✗</span>'}<span class="mono" style="font-size:9px">${r.status}</span></td>
      <td class="mono" style="font-size:9px">${r.duration}ms</td>
      <td>${r.id?`<button type="button" class="icon-act" data-action="viewBody" data-id="${escAttr(r.id)}" title="查看正文"><span class="msym">article</span></button>`:''}</td></tr>`;
  }).join('');
  const html = rows || `<tr><td colspan="6" class="empty">${rqSaved.enable?'暂无记录':'记录已关闭，开启后这里会显示请求'}</td></tr>`;
  const tb = $('#rq-table tbody');
  if(tb.dataset.sig !== html){ tb.dataset.sig = html; tb.innerHTML = html; }
}
let lgInst=null;  // instance whose log is currently on screen
async function renderLogs(){
  const signal=Store.abort('logs');
  const cur = await fillInstSelect($('#topInst'), Store.inst, signal); Store.inst=cur;
  const box=$('#lg-box');
  // Same instance: keep the text on screen while refetching. Blanking it to "加载中…" makes the pane
  // collapse and the whole page jump; only a real instance switch clears it.
  if(lgInst!==cur){ lgInst=cur; box.textContent='加载中…'; }
  try{
    const lines=+($('#lg-lines').value||100);
    const [txt,cfg,reqs,lgc]=await Promise.all([
      adapter.getLogs(cur,lines,signal).catch(e=>{ if(e.name==='AbortError') throw e; return '读取失败： '+e.message; }),
      adapter.getConfig(cur,signal).catch(e=>{ if(e.name==='AbortError') throw e; return null; }),
      adapter.getRequests(cur,signal).catch(e=>{ if(e.name==='AbortError') throw e; return []; }),
      adapter.getLogCfg(cur,signal).catch(e=>{ if(e.name==='AbortError') throw e; return null; }),
    ]);
    const next=txt||'（空）';
    // Replace in place only when the text really changed: identical content leaves scroll and layout untouched
    if(box.textContent!==next){
      const stick=(box.scrollHeight-box.scrollTop-box.clientHeight)<24;
      const top=box.scrollTop;
      box.textContent=next;
      box.scrollTop = stick ? box.scrollHeight : Math.min(top, Math.max(0, box.scrollHeight-box.clientHeight));
    }
    if(cfg){
      const rec=cfg.record||{};
      rqSaved={enable:!!rec.enable,server:rec.server||''};
      $('#lg-rec-enable').selected=rqSaved.enable;
      $('#lg-rec-server').value=rqSaved.server;
    }
    renderReqRows(reqs);
    if(lgc) lgApply(lgc);
  }catch(e){ if(e.name!=='AbortError'){ box.textContent='读取失败： '+e.message; } }
}
// Record settings save themselves on change (no save button); an unchanged value returns early so a mere focus/blur does not restart the instance.
// Switch and address can land in the same tick (typing then tapping the switch): the second call is queued, not dropped, and re-reads both fields.
async function saveRecCfg(){
  if(rqSaving){ rqPending=true; return; }
  const next={enable:!!$('#lg-rec-enable').selected, server:($('#lg-rec-server').value||'').trim()};
  if(next.enable===rqSaved.enable && next.server===rqSaved.server) return;
  rqSaving=true;
  try{
    await adapter.saveConfig(Store.inst,{record:next});
    rqSaved=next;
    snack('记录设置已保存');
    await renderLogs();
  }catch(e){ snack(e.message,true); }
  finally{ rqSaving=false; if(rqPending){ rqPending=false; saveRecCfg(); } }
}
/* ============ Log file settings (two sliders) ============
 * 记录上限 = how large gateway.log may grow before the oldest half is dropped; 缓冲区大小 = how many
 * bytes are batched before one write reaches the disk (fewer writes = less flash wear, the panel then
 * lags by up to ~1 s). The server clamps both and the buffer never exceeds the cap, so the UI re-reads
 * the saved values after every change instead of trusting what was submitted. */
const LOG_CAP_STEPS=[32,64,128,256,512,1024,2048,4096,8192,16384,32768];   // KB
const LOG_BUF_STEPS=[8,16,32,64,128,256,512,1024,2048,4096,8192];          // KB
const LOG_DEF={maxBytes:8*1024*1024, bufferBytes:64*1024};
let lgCfg=Object.assign({},LOG_DEF);
let lgBusy=false, lgDragging=false;
function lgSize(kb){ return kb>=1024 ? (kb/1024)+' MB' : kb+' KB'; }
function lgStepIdx(list, bytes){
  const kb=Math.max(1, Math.round((Number(bytes)||0)/1024));
  let best=0, dist=Infinity;
  list.forEach((v,i)=>{ const d=Math.abs(v-kb); if(d<dist){ dist=d; best=i; } });
  return best;
}
function lgPaint(){
  const cap=$('#lg-cap'), buf=$('#lg-buf'); if(!cap||!buf) return;
  const ci=lgStepIdx(LOG_CAP_STEPS, lgCfg.maxBytes), bi=lgStepIdx(LOG_BUF_STEPS, lgCfg.bufferBytes);
  cap.value=String(ci); buf.value=String(bi);
  const cv=$('#lg-cap-val'), bv=$('#lg-buf-val');
  if(cv) cv.textContent=lgSize(LOG_CAP_STEPS[ci]);
  if(bv) bv.textContent=lgSize(LOG_BUF_STEPS[bi]);
}
function lgState(st){
  const el=$('#lg-cfg-state'); if(!el) return;
  if(!st){ el.textContent='写入缓冲与日志文件上限 · 拖动后即时生效'; return; }
  if(st.enabled){
    const kb=Math.round((Number(st.size)||0)/1024);
    el.textContent='已托管 '+(String(st.file||'').split('/').pop()||'gateway.log')
      +' · 当前 '+(kb>=1024?(kb/1024).toFixed(2)+' MB':kb+' KB');
  } else {
    el.textContent='当前进程未托管日志文件（需由 agw.sh 启动） · 设置已保存';
  }
}
function lgApply(st){
  if(!st) return;
  // With the writer installed the live sizes win over the saved ones: the file is process-wide, so a
  // second instance's config may say something else entirely.
  const saved=st.saved||{}, live=st.enabled?st:{};
  lgCfg={
    maxBytes:Number(live.maxBytes)||Number(saved.maxBytes)||lgCfg.maxBytes,
    bufferBytes:Number(live.bufferBytes)||Number(saved.bufferBytes)||lgCfg.bufferBytes,
  };
  if(!lgDragging && !lgBusy) lgPaint();
  lgState(st);
}
async function lgSave(){
  const cap=$('#lg-cap'), buf=$('#lg-buf'); if(!cap||!buf||lgBusy) { lgPaint(); return; }
  const capKB=LOG_CAP_STEPS[+cap.value]||8192;
  const bufKB=Math.min(LOG_BUF_STEPS[+buf.value]||64, capKB);
  const next={maxBytes:capKB*1024, bufferBytes:bufKB*1024};
  if(next.maxBytes===lgCfg.maxBytes && next.bufferBytes===lgCfg.bufferBytes){ lgPaint(); return; }
  lgBusy=true;
  try{
    const r=await adapter.saveLogCfg(Store.inst, next);
    const saved=(r&&r.saved)||{};
    lgCfg={
      maxBytes:Number(r&&r.enabled?r.maxBytes:saved.maxBytes)||next.maxBytes,
      bufferBytes:Number(r&&r.enabled?r.bufferBytes:saved.bufferBytes)||next.bufferBytes,
    };
    lgPaint(); lgState(r); snack('日志设置已保存');
  }catch(e){ snack(e.message,true); lgPaint(); }
  finally{ lgBusy=false; }
}
function lgBind(){
  const cap=$('#lg-cap'), buf=$('#lg-buf'); if(!cap||!buf) return;
  const paint=()=>{
    $('#lg-cap-val').textContent=lgSize(LOG_CAP_STEPS[+cap.value]||8192);
    $('#lg-buf-val').textContent=lgSize(LOG_BUF_STEPS[+buf.value]||64);
  };
  [cap,buf].forEach(el=>{
    el.addEventListener('input',()=>{ lgDragging=true; paint(); });
    el.addEventListener('change',()=>{ lgDragging=false; lgSave(); });
  });
  const rs=$('#lg-cfg-reset');
  if(rs) rs.addEventListener('click',()=>{
    cap.value=String(lgStepIdx(LOG_CAP_STEPS, LOG_DEF.maxBytes));
    buf.value=String(lgStepIdx(LOG_BUF_STEPS, LOG_DEF.bufferBytes));
    paint(); lgSave();
  });
  lgPaint();
}

// Fetch a request/response body by id from the record file and show it in a dialog
async function viewRecordBody(id){
  openDialog('请求正文', '<div style="padding:4px">加载中…</div>', {okText:'关闭', cancel:false});
  try{
    const d=await adapter.getRecordBody(Store.inst,id);
    const r=d.record||{};
    const fmt=v=>typeof v==='string'?v:JSON.stringify(v,null,2);
    $('#dlgBody').innerHTML='<div class="rec-meta mono">'+esc(r.time||'')+' · '+esc(r.model||'')+' · 渠道 '+esc(r.channel||'-')+' · 状态 '+(r.status??'')+' · '+(r.duration||0)+'ms · tokens '+(r.inputTokens||0)+'/'+(r.outputTokens||0)+'</div>'
      +'<div style="font-size:10px;font-weight:600">请求</div><pre class="rec-pre mono">'+esc(fmt(r.request??'（无）'))+'</pre>'
      +'<div style="font-size:10px;font-weight:600">响应</div><pre class="rec-pre mono">'+esc(fmt(r.response??'（无）'))+'</pre>';
  }catch(e){ $('#dlgBody').innerHTML='<div style="padding:4px;color:var(--md-sys-color-error)">'+esc(e.message)+'</div>'; }
}

// ============ Dialogs ============
// md-dialog's OK/Cancel buttons live in the actions slot; a <form method=dialog> cannot bind across slots,
// hence explicit click binding: on validation/save failure the dialog stays open (no more show() reopening).
// Add an eye toggle to password fields
function upgradePwFields(root){
  if(!root || !root.querySelectorAll) return;
  root.querySelectorAll('md-outlined-text-field[type="password"]').forEach(f=>{
    if(f.querySelector('.pw-eye')) return;
    const b=document.createElement('md-outlined-icon-button');
    b.className='pw-eye'; b.setAttribute('slot','trailing-icon'); b.title='显示/隐藏';
    b.innerHTML='<md-icon>visibility</md-icon>';
    f.appendChild(b);
  });
}
document.body.addEventListener('click', e=>{
  const eye=e.target.closest('.pw-eye'); if(!eye) return;
  const f=eye.closest('md-outlined-text-field'); if(!f) return;
  const show = f.type==='password';
  f.type = show?'text':'password';
  const ic=eye.querySelector('md-icon'); if(ic) ic.textContent = show?'visibility_off':'visibility';
});

let dlgOnOk = null;
let mmList=[]; // the channel dialog's model rename map [[public name, real name],...]
let portDlgOrigKey; // the original admin password before dialog backfill (undefined = backfill not done)
// Drawer-style dialog: opening is pure CSS (dlgRise); closing adds .closing so the sheet slides down
// (dlgSink) before the overlay is hidden. DLG_CLOSE_MS mirrors the .dlg-overlay.closing duration in app.css.
const DLG_CLOSE_MS = 200;
let dlgCloseT = 0;
function openDlg(){
  const ov=$('#dlgOverlay'); if(!ov) return;
  clearTimeout(dlgCloseT); ov.classList.remove('closing'); ov.hidden=false;
}
function closeDlg(){
  const ov=$('#dlgOverlay'); if(!ov || ov.hidden) return;
  ov.classList.add('closing');
  clearTimeout(dlgCloseT);
  dlgCloseT=setTimeout(()=>{ ov.classList.remove('closing'); ov.hidden=true; }, reducedMotion()?0:DLG_CLOSE_MS);
}
function openDialog(title, bodyHtml, {okText='确定', cancel=true, onOk=null}={}){
  dlgOnOk = onOk;
  $('#dlgTitle').textContent=title;
  $('#dlgBody').innerHTML=bodyHtml;
  upgradePwFields($('#dlgBody'));
  $('#dlgOk').textContent=okText;
  $('#dlgCancel').hidden=!cancel;
  $('#dlgFetch').hidden=true;
  openDlg();
// Auto-focus the first input; a failed focus must not break the dialog
  setTimeout(()=>{ try{ $('#dlgBody').querySelector('md-outlined-text-field,md-outlined-select')?.focus?.(); }catch(_){} },120);
}
const dlgValue = () => { const o={}; $$('#dlgBody [data-f]').forEach(el=>o[el.dataset.f]=el.value); return o; };
// ---- Theme switching (light/dark + Material You primary color) ----
const SWATCHES=['#6750A4','#005AC1','#006C7C','#006E1C','#9A1E78','#9C4146','#8E4D00','#3B5BA5'];
let themeState={mode:'dark',seed:'#6750A4'};
function hexToHSL(hex){hex=hex.replace('#','');const r=parseInt(hex.substr(0,2),16)/255,g=parseInt(hex.substr(2,2),16)/255,b=parseInt(hex.substr(4,2),16)/255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h,s,l=(mx+mn)/2;if(mx===mn){h=s=0;}else{const d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);switch(mx){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}h/=6;}return{h:Math.round(h*360),s:Math.round(s*100),l:Math.round(l*100)};}
function hslToHex(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l);const f=n=>{const k=(n+h/30)%12;const c=l-a*Math.max(-1,Math.min(k-3,9-k,1));return Math.round(255*c).toString(16).padStart(2,'0');};return'#'+f(0)+f(8)+f(4);}
//// derive the full primary/secondary/tertiary roles from the seed color, otherwise the bottom-bar indicator (secondary-container) and some buttons (filled-tonal = secondary-container) never follow the change
function applyTheme(t){
  themeState={mode:t.mode||'dark',seed:t.seed||'#6750A4'};
  const el=document.documentElement; el.dataset.theme=themeState.mode; el.style.colorScheme=themeState.mode;
  const hsl=hexToHSL(themeState.seed), isDark=themeState.mode!=='light';
  const set=(k,v)=>el.style.setProperty(k,v);
// A role palette: primary / on-primary / primary-container / on-primary-container
  const role=(h,s,cL,onCL)=>{
    const pL=isDark?80:40;
    set('--md-sys-color-'+cL,hslToHex(h,s,pL));
    set('--md-sys-color-on-'+cL,pL>55?'#1A1A1A':'#FFFFFF');
    set('--md-sys-color-'+cL+'-container',hslToHex(h,s,isDark?onCL[0]:onCL[1]));
    set('--md-sys-color-on-'+cL+'-container',hslToHex(h,s,isDark?onCL[2]:onCL[3]));
  };
  role(hsl.h, Math.min(100,hsl.s+10), 'primary', [25,90,90,25]);
  role(hsl.h, Math.max(8,Math.round(hsl.s*0.35)), 'secondary', [30,90,90,20]);
  role((hsl.h+60)%360, Math.max(10,Math.round(hsl.s*0.55)), 'tertiary', [30,90,90,20]);
  set('--md-sys-color-surface-tint', hslToHex(hsl.h, Math.min(100,hsl.s+10), isDark?80:40));
}
function loadTheme(){try{const t=JSON.parse(localStorage.getItem('agw-theme')||'{}');if(t.mode)applyTheme(t);else applyTheme({mode:'dark',seed:'#6750A4'});}catch(_){applyTheme({mode:'dark',seed:'#6750A4'});}}
function saveTheme(){localStorage.setItem('agw-theme',JSON.stringify(themeState));}
function openThemeDialog(){
  openDialog('主题',`<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
    <label style="display:flex;align-items:center;gap:4px"><md-switch id="th-dark" ${themeState.mode==='dark'?'selected':''}></md-switch><span style="font-size:11px">深色主题</span></label>
    <div><div style="font-size:10px;color:var(--md-sys-color-on-surface-variant);margin-bottom:8px">主色（Material You）</div>
    <div id="th-swatches" style="display:flex;gap:4px;flex-wrap:wrap"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px"><button type="button" class="btn sm outline" id="th-mdu">从手机取色</button><span style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">Material You 壁纸色</span><input type="color" id="th-custom" value="${themeState.seed}" style="width:32px;height:29px;border:none;border-radius:8px;cursor:pointer;background:none"><span style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">自定义颜色</span></div></div>
  </div>`,{okText:'完成',cancel:false});
  const sw=$('#th-swatches');if(sw)sw.innerHTML=SWATCHES.map(c=>`<button type="button" class="th-swatch" data-c="${c}" style="width:29px;height:29px;border-radius:50%;border:2px solid ${c===themeState.seed?'var(--md-sys-color-on-surface)':'transparent'};background:${c};cursor:pointer;padding:0"></button>`).join('');
  const dk=$('#th-dark');if(dk)dk.addEventListener('click',()=>setTimeout(()=>{applyTheme({mode:dk.selected?'dark':'light',seed:themeState.seed});saveTheme();},0));
  if(sw)sw.addEventListener('click',e=>{const b=e.target.closest('.th-swatch');if(b){applyTheme({mode:themeState.mode,seed:b.dataset.c});saveTheme();sw.querySelectorAll('.th-swatch').forEach(s=>s.style.borderColor=s.dataset.c===themeState.seed?'var(--md-sys-color-on-surface)':'transparent');}});
  const cu=$('#th-custom');if(cu)cu.addEventListener('input',e=>{applyTheme({mode:themeState.mode,seed:e.target.value});saveTheme();});
  const mduBtn=$('#th-mdu');
  if(mduBtn) mduBtn.addEventListener('click',async()=>{
    const old=mduBtn.textContent;
    mduBtn.disabled=true; mduBtn.textContent='取色中…';
    try{
      const r=await adapter.getMdu();
      const hex=String((r&&r.tokens&&r.tokens.primary)||'').replace('#','');
      if(!r || !r.ok || !/^[0-9a-f]{6}$/i.test(hex)) throw new Error((r&&r.error)||'桥未返回颜色');
      applySeed('#'+hex);
      mduBtn.textContent='已应用 #'+hex;
    }catch(e){
      snack('取色桥不可用（'+e.message+'），请改为选择一张壁纸取色', true);
      mduBtn.textContent=old;
      pickWallpaperColor(mduBtn);
    }
    mduBtn.disabled=false;
  });
}
// Apply the theme seed color (kept in sync across the custom swatch / palette / custom input)
function applySeed(hex){
  applyTheme({mode:themeState.mode, seed:hex}); saveTheme();
  const cu=$('#th-custom'); if(cu) cu.value=hex;
  const sw=$('#th-swatches'); if(sw) sw.querySelectorAll('.th-swatch').forEach(s=>s.style.borderColor='transparent');
}
// Pick a wallpaper from the gallery -> extract the primary color with in-browser canvas; no system API / backend endpoint
function pickWallpaperColor(btn){
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='image/*';
  inp.addEventListener('change', async ()=>{
    const f=inp.files && inp.files[0]; if(!f) return;
    const old=btn.textContent; btn.disabled=true; btn.textContent='取色中…';
    try{
      const hex=await dominantColor(f);
      applySeed(hex);
      btn.textContent='已应用 '+hex;
    }catch(e){ snack('取色失败： '+(e.message||e),true); btn.textContent=old; }
    btn.disabled=false;
  });
  inp.click();
}
// Primary extraction: downscale to 32x32 -> bucket by 30-degree hue -> average the bucket scoring best on pixels x saturation x centered lightness
async function dominantColor(file){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error('图片无法解码')); i.src=url; });
    const S=32, cv=document.createElement('canvas'); cv.width=cv.height=S;
    const cx=cv.getContext('2d',{willReadFrequently:true}); cx.drawImage(img,0,0,S,S);
    const d=cx.getImageData(0,0,S,S).data, buckets=new Map();
    for(let i=0;i<d.length;i+=4){
      if(d[i+3]<128) continue;
      const c=rgbToHsl(d[i],d[i+1],d[i+2]);
if(c.s<12 || c.l<12 || c.l>92) continue;   // skip near-gray / too dark / too bright
      const k=Math.round(c.h/12);
      const b=buckets.get(k)||{n:0,h:0,s:0,l:0};
      b.n++; b.h+=c.h; b.s+=c.s; b.l+=c.l; buckets.set(k,b);
    }
    let best=null;
    for(const b of buckets.values()){
      const w=b.n*(b.s/b.n)*(1-Math.abs(b.l/b.n-55)/55);
      if(!best||w>best.w) best={w,b};
    }
    if(!best) return '#6750A4';                  // 全灰/全黑图: 退回默认紫
    const b=best.b, h=Math.round(b.h/b.n);
    const s=Math.min(100,Math.round(b.s/b.n*1.15));
    const l=Math.round(b.l/b.n);
    // Seed colors are clamped to mid lightness: too pale/dark and the whole role palette loses contrast
    return hslToHex(h, Math.max(28,s), l>70?58:(l<35?45:l));
  } finally { URL.revokeObjectURL(url); }
}
function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2; let h=0, s=0;
  if(mx!==mn){
    const dd=mx-mn;
    s=l>0.5?dd/(2-mx-mn):dd/(mx+mn);
    switch(mx){ case r: h=(g-b)/dd+(g<b?6:0); break; case g: h=(b-r)/dd+2; break; default: h=(r-g)/dd+4; }
    h*=60;
  }
  return {h,s:s*100,l:l*100};
}

// ---- Optional admin API token input: top-bar key button, auto-opens on API 401 ----
function keyDlgVisible(){ return !$('#dlgOverlay').hidden && $('#dlgTitle').textContent==='管理令牌'; }
function openKeyDialog(){
  if(keyDlgVisible()) return;
  openDialog('管理令牌', `
    <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
      <md-outlined-text-field data-f="key" label="管理 API 令牌（可选）" type="password" value="${escAttr(localStorage.getItem('agw-admin-key')||'')}"
        helper="面板登录请使用 agw web login 生成的一次性链接；此处仅用于脚本/API 的 webToken"></md-outlined-text-field>
    </div>`, {okText:'保存', onOk:saveKey});
}
async function saveKey(){
  const k=String(dlgValue().key||'').trim();
  if(k) localStorage.setItem('agw-admin-key',k); else localStorage.removeItem('agw-admin-key');
  snack(k?'令牌已记住，正在刷新…':'已清除已记住的令牌，正在刷新…');
  setTimeout(()=>location.reload(),600);
  return true;
}
// ---- Model rename tag editor (inside the channel dialog) ----
function renderMmChips(){
  const box=$('#mmChips'); if(!box) return;
  box.innerHTML=mmList.length?mmList.map(([k,v],i)=>
    '<span class="mm-chip" data-i="'+i+'"><span class="nm">'+esc(k)+'</span>'
    +(k===v?'':'<span class="arrow">→</span><span class="nm">'+esc(v)+'</span>')
    +'<button class="mm-x" data-i="'+i+'" aria-label="删除">✕</button></span>').join('')
    :'<span style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">暂无映射 — 请填写上方两栏后点击 + 添加（左滑标签或点击 ✕ 删除）</span>';
}
function mmAdd(){
  const a=($('#mm-alias').value||'').trim(), r=($('#mm-real').value||'').trim();
  if(!a){ snack('请先填写左栏（对外名）',true); return; }
  if(!/^[A-Za-z0-9_.\/:@+~-]+$/.test(a)){ snack('对外名建议仅使用字母、数字及 . _ / : @ + ~ -',true); return; }
  if(mmList.some(([k])=>k===a)){ snack('覆盖名 '+a+' 已存在',true); return; }
  mmList.push([a,r||a]);
  $('#mm-alias').value=''; $('#mm-real').value='';
  renderMmChips();
}
function mmDel(i){ mmList.splice(i,1); renderMmChips(); }
function mmBindSwipe(){
  const box=$('#mmChips'); let sx=0,sy=0,chip=null,idx=-1,dx=0;
  box.addEventListener('touchstart',e=>{
    const t=e.target.closest('.mm-chip'); if(!t) return;
    chip=t; idx=+t.dataset.i; sx=e.touches[0].clientX; sy=e.touches[0].clientY; dx=0;
    t.style.transition='none';
  },{passive:true});
  box.addEventListener('touchmove',e=>{
    if(!chip) return;
    dx=e.touches[0].clientX-sx;
    const dy=e.touches[0].clientY-sy;
    if(Math.abs(dx)>6&&Math.abs(dx)>Math.abs(dy)) chip.style.transform='translateX('+Math.max(-140,Math.min(140,dx))+'px)';
  },{passive:true});
  box.addEventListener('touchend',()=>{
    if(!chip) return;
if(Math.abs(dx)>64){ // swipe past the threshold -> delete
      chip.style.transition='transform .18s,opacity .18s';
      chip.style.transform='translateX('+(dx>0?160:-160)+'px)'; chip.style.opacity='0';
      const i=idx; setTimeout(()=>mmDel(i),180);
    } else { chip.style.transition='transform .18s'; chip.style.transform=''; }
    chip=null; idx=-1; dx=0;
  });
}
// Checkbox panel for a fetched model list (inserted at the top of the dialog; checking fills the Models field)
function mmShowModelPicker(list){
  const oldBox=$('#mmSelBox'); if(oldBox) oldBox.remove();
  const box=document.createElement('div');
  box.id='mmSelBox';
  box.style.cssText='border:1px solid var(--md-sys-color-outline-variant);border-radius:10px;padding:8px;max-height:184px;overflow-y:auto';
  const head=document.createElement('div');
  head.style.cssText='display:flex;align-items:center;gap:4px;margin-bottom:8px';
  head.innerHTML='<span style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">已获取 '+list.length+' 个，勾选后填入</span>'
    +'<button type="button" class="pbtn pbtn-text" id="mmSelAll" style="height:21px;padding:0 12px;margin-left:auto">全选</button>'
    +'<button type="button" class="pbtn pbtn-text" id="mmSelNone" style="height:21px;padding:0 12px">清空</button>'
    +'<button type="button" class="pbtn pbtn-filled" id="mmSelOk" style="height:21px;padding:0 12px">填入</button>'
    +'<button type="button" class="pbtn pbtn-text" id="mmSelX" style="height:21px;padding:0 8px" aria-label="关闭">✕</button>';
  box.appendChild(head);
  list.forEach(m=>{
    const lab=document.createElement('label');
    lab.style.cssText='display:flex;align-items:center;gap:4px;font-size:10px;padding:2px 0;cursor:pointer';
    const cb=document.createElement('input'); cb.type='checkbox'; cb.className='mm-sel'; cb.value=m; cb.checked=true;
    const sp=document.createElement('span'); sp.className='mono'; sp.textContent=m; sp.style.cssText='word-break:break-all';
    lab.appendChild(cb); lab.appendChild(sp); box.appendChild(lab);
  });
  box.addEventListener('click',e=>{
    const t=e.target.id;
    if(t==='mmSelAll') box.querySelectorAll('.mm-sel').forEach(c=>c.checked=true);
    else if(t==='mmSelNone') box.querySelectorAll('.mm-sel').forEach(c=>c.checked=false);
    else if(t==='mmSelOk'){
      const sel=[...box.querySelectorAll('.mm-sel')].filter(c=>c.checked).map(c=>c.value);
      if(!sel.length){ snack('至少勾选一个模型',true); return; }
      const f=$('#dlgBody [data-f=models]'); if(f) f.value=sel.join(', ');
      box.remove(); snack('已填入 '+sel.length+' 个模型');
    }
    else if(t==='mmSelX') box.remove();
  });
  // insert right above the Models field (not the dialog top) and scroll it into view
  const mf=$('#dlgBody [data-f=models]');
  if(mf && mf.parentNode) mf.parentNode.insertBefore(box, mf);
  else $('#dlgBody').prepend(box);
  try{ box.scrollIntoView({behavior:'smooth', block:'center'}); }
  catch(_){ try{ $('#dlgBody').scrollTop = box.offsetTop - 8; }catch(_2){} }
}
let providerDlgOrigName='';        // 打开渠道弹窗时的原渠道名(用于改名)
let providerDlgOrigUseResponses;   // the original useResponses (undefined = unset/auto passthrough; submitted only when the user flips it)
let providerDlgOrigParamOverride;         // 打开弹窗时该渠道已有的参数覆写(undefined=没有), 用来区分「清空」与「不提交」
function openProviderDialog(ch){
  const c=ch||{name:'',type:'openai',baseUrl:'',proxy:'-',models:[],apiKey:'',default:false};
  providerDlgOrigName=ch?ch.name:'';
  providerDlgOrigUseResponses=ch?ch.useResponses:undefined;
  providerDlgOrigParamOverride=ch?ch.paramOverride:undefined;
  mmList=(c.modelMap?Object.entries(c.modelMap):[]);
  const pxs=Object.keys((Store.configs.get(Store.inst)||{}).proxies||{});
  const pOpts=['-'].concat(pxs); if(c.proxy&&!pOpts.includes(c.proxy)) pOpts.push(c.proxy);
  const curP=c.proxy||'-';
  openDialog(ch?'编辑渠道':'添加渠道', `
    <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="名称" value="${escAttr(c.name)}" required></md-outlined-text-field>
      <md-outlined-select data-f="type" label="类型" style="width:100%">
        ${['openai','claude','gemini'].map(t=>`<md-select-option value="${t}" ${t===c.type?'selected':''}>${t}</md-select-option>`).join('')}
      </md-outlined-select>
      <md-outlined-text-field data-f="baseUrl" label="Base URL" value="${escAttr(c.baseUrl)}" placeholder="https://…/v1"></md-outlined-text-field>
      <md-outlined-text-field data-f="path" label="固定路径（可选）" value="${escAttr(c.path||'')}" placeholder="/v1/chat/completions" helper="填写后所有请求均发往 baseUrl+path，忽略客户端路径与查询参数；留空表示自动"></md-outlined-text-field>
      <md-outlined-select data-f="proxy" label="代理（- 表示直连）" style="width:100%">
        ${pOpts.map(o=>`<md-select-option value="${escAttr(o)}" ${o===curP?'selected':''}>${o==='-'?'- 直连':esc(o)}</md-select-option>`).join('')}
      </md-outlined-select>
      <md-outlined-text-field data-f="models" label="模型（逗号分隔）" value="${escAttr((c.models||[]).join(', '))}"></md-outlined-text-field>
      <md-outlined-text-field data-f="delayMs" label="请求延迟（毫秒，0 表示关闭）" type="number" value="${escAttr(String(c.delayMs||0))}" helper="每个请求发出前等待该时长；同渠道并发请求按此间隔排队发出，可缓解 429 限流"></md-outlined-text-field>
      <md-outlined-text-field data-f="paramOverride" label="参数覆写（JSON，留空表示不覆写）" type="textarea" rows="3" value="${escAttr(c.paramOverride?JSON.stringify(c.paramOverride,null,2):'')}" helper="覆写最终发往上游的请求体，覆盖 SDK 同名参数；对象深度合并，数组整体替换，null 表示删除该参数；键名按渠道方言（openai/claude/gemini）书写"></md-outlined-text-field>
      <div>
        <div style="font-size:10px;color:var(--md-sys-color-on-surface-variant);margin-bottom:8px">模型改名（对外名 → 真实名；右栏留空表示按原名提供；可在手机上左滑标签删除；对外名将出现在 /v1/models；重启实例后生效）</div>
        <div class="mm-row">
          <md-outlined-text-field id="mm-alias" label="覆盖名（对外）"></md-outlined-text-field>
          <md-outlined-text-field id="mm-real" label="原始名（可留空）"></md-outlined-text-field>
          <button type="button" class="mm-add-btn" id="mm-add" aria-label="添加"><span class="msym">add</span></button>
        </div>
        <div class="mm-chips" id="mmChips"></div>
      </div>
      <md-outlined-text-field data-f="apiKey" label="API Key" type="password" value="${escAttr(c.apiKey||'')}" placeholder="${c.hasKey?'（已设，留空表示不修改）':'API Key'}"></md-outlined-text-field>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px"><md-checkbox data-f="useResponses" ${c.useResponses?'selected':''}></md-checkbox>上游使用 Responses API <span class="muted small">（仅限 openai 类型；不勾选表示自动：Responses 客户端直通 /v1/responses，Chat 客户端直通 chat）</span></label>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px"><md-checkbox data-f="probe" ${c.probe?'selected':''}></md-checkbox>参与成功率探测 <span class="muted small">（需实例开启 probe；用户端可见成功率）</span></label>
      <div class="muted small" style="margin-top:8px">上游余额（列表内点击 💰 按钮查询；三项留空表示使用内置预设）</div>
      <md-outlined-text-field data-f="balanceUrl" label="余额接口 URL（可相对 Base URL）" value="${escAttr(c.balanceUrl||'')}" placeholder="/v1/user/info"></md-outlined-text-field>
      <md-outlined-text-field data-f="balancePath" label="取值路径（点号路径）" value="${escAttr(c.balancePath||'')}" placeholder="data.balance"></md-outlined-text-field>
      <md-outlined-text-field data-f="balanceUnit" label="单位（可选）" value="${escAttr(c.balanceUnit||'')}" placeholder="CNY"></md-outlined-text-field>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px"><md-checkbox data-f="default" ${c.default?'selected':''}></md-checkbox>设为默认渠道</label>
    </div>`, {onOk:saveProvider});
  const s=$('#dlgBody [data-f=type]');
  s.updateComplete.then(()=>Promise.all([...s.querySelectorAll('md-select-option')].map(o=>o.updateComplete||0))).then(()=>s.value=c.type);
  const sp=$('#dlgBody [data-f=proxy]');
  if(sp) sp.updateComplete.then(()=>Promise.all([...sp.querySelectorAll('md-select-option')].map(o=>o.updateComplete||0))).then(()=>sp.value=curP).catch(()=>{});
  const cb=$('#dlgBody [data-f=default]'); if(c.default) cb.selected=true;
  const ur=$('#dlgBody [data-f=useResponses]'); if(c.useResponses) ur.selected=true;
  const pr=$('#dlgBody [data-f=probe]'); if(c.probe) pr.selected=true;
  // JSON 覆写按原文换行展示(属性里的换行会被压成空格, 这里补回可读格式)
  const ovEl=$('#dlgBody [data-f=paramOverride]');
  if(ovEl) ovEl.value=c.paramOverride?JSON.stringify(c.paramOverride,null,2):'';
  const ma=$('#mm-alias');
  if(ma){
    $('#mm-add').addEventListener('click',mmAdd);
    [ma,$('#mm-real')].forEach(el=>el.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); mmAdd(); } }));
    $('#mmChips').addEventListener('click',e=>{ const x=e.target.closest('.mm-x'); if(x) mmDel(+x.dataset.i); });
    mmBindSwipe();
    renderMmChips();
  }
  const fb=$('#dlgFetch');
  if(fb){
    fb.hidden=false;
    fb.onclick=async ()=>{
      if(fb.disabled) return;
      const v=dlgValue();
      fb.disabled=true; fb.textContent='获取中…';
      try{
        const r=await adapter.fetchModels(Store.inst,{ name:String(v.name||'').trim(), type:v.type||'openai',
          baseUrl:String(v.baseUrl||'').trim(), apiKey:String(v.apiKey||'').trim(), proxy:v.proxy||'-' });
        const list=r.models||[];
        if(!list.length) snack('上游未返回任何模型',true);
        else mmShowModelPicker(list);
      }catch(e){ snack(e.message,true); }
      fb.disabled=false; fb.textContent='获取模型列表';
    };
  }
}
function openPortDialog(name){
  const i=Store.instances.find(x=>x.name===name)||{};
  openDialog(name?'编辑实例 '+name:'新建实例', `
    <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="实例名" value="${escAttr(i.name||'')}" ${(name==='default')?'disabled':''} required helper="${name?(name==='default'?'主实例不支持改名':'改名会同步修改配置文件名，热生效'):'仅可包含字母、数字、中划线、下划线'}"></md-outlined-text-field>
      <md-outlined-text-field data-f="port" label="端口" type="number" value="${i.port||16390}" helper="${(i.tlsOn||(name&&name!=='default'))?'启用 HTTPS 的实例仅经主端口访问，此端口仅作标识':'监听端口（启用 HTTPS 后仅提供 https）'}"></md-outlined-text-field>
      <md-outlined-text-field data-f="webToken" label="访问令牌" type="password" value="" helper="留空保存表示清除访问令牌"></md-outlined-text-field>
      <label style="display:flex;align-items:center;gap:4px;font-size:11px"><md-switch data-f="tls" ${i.tlsOn?'selected':''}></md-switch>启用 HTTPS</label>
      ${(name&&name!=='default'&&name!==Store.currentName)?`<md-text-button data-action="delInstance" data-name="${escAttr(name)}" style="color:var(--md-sys-color-error);align-self:flex-start;margin-top:2px">删除实例</md-text-button>`:''}
    </div>`, {onOk:()=>savePortSettings(name)});
if(name){ // edit mode: fetch the real config to backfill port/TLS/admin password (revealed in plaintext, WYSIWYG)
    portDlgOrigKey=undefined;
    adapter.getConfig(name).then(c=>{
      const q=f=>$('#dlgBody [data-f='+f+']');
      if(q('port')) q('port').value=(c.port!=null?c.port:16384);
      const sw=q('tls'); if(sw) sw.selected=!!(c.tls&&c.tls.enable);
      portDlgOrigKey=c.webToken||'';
      if(q('webToken')) q('webToken').value=portDlgOrigKey;
    }).catch(()=>{});
  }
}

// ============ Save actions ============
//// create/edit an instance (the ports page dialog's OK). editName present = edit, otherwise create.
async function savePortSettings(editName){
  const v=dlgValue();
  const name=String(editName||v.name||'').trim();
  const port=Number(v.port);
  const adminKey=String(v.webToken||'').trim();
  const tlsOn=!!($('#dlgBody [data-f=tls]')&&$('#dlgBody [data-f=tls]').selected);
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(name)){ snack('实例名仅可包含字母、数字、中划线、下划线（最长 32 字符）',true); return false; }
  if(!port||port<1024||port>65535){ snack('HTTP 端口范围 1024-65535',true); return false; }
  try{
if(editName){ // ---- edit an existing instance ----
      let effName=editName;
if(name!==editName){ // ---- rename: call the rename API first (hot), later saves use the new name ----
        await adapter.renameInstance(editName,name);
        effName=name;
        snack('实例已改名： '+editName+' → '+name);
      }
      const cur=await adapter.getConfig(effName);
      const patch={ port, host:(cur&&cur.host)||'0.0.0.0',
        tls:Object.assign({},(cur&&cur.tls)||{},{ enable:tlsOn }) };
      delete patch.tls.port;
      // admin password: submit only when different from the backfilled value (empty = remove it); untouched when backfill failed (unknown)
      if(portDlgOrigKey!==undefined && adminKey!==portDlgOrigKey) patch.webToken=adminKey;
      await adapter.saveConfig(effName,patch);
      snack('已保存实例 '+effName);
      if(editName===Store.currentName&&cur&&cur.port&&Number(cur.port)!==port)
        snack('面板实例端口已改为 '+port+'，稍后请使用新地址访问面板',true);
      let running=false;
      try{ const d=await adapter.getInstances(); running=!!(d.instances||[]).find(x=>x.name===effName&&x.running); }catch(_){}
      if(running) doInstanceAction(effName,'restart'); else renderPorts();
}else{ // ---- create a new instance ----
      const tls={ enable:tlsOn };
if(tlsOn){ // reuse an existing instance's certificate (certs can be shared across instances); none available -> fall back to pure HTTP
        try{
          const d=await adapter.getInstances();
          const names=(d.instances||[]).map(x=>x.name);
          for(const n of names){
            try{
              const c=await adapter.getConfig(n);
              if(c&&c.tls&&c.tls.cert&&c.tls.key){ tls.cert=c.tls.cert; tls.key=c.tls.key; break; }
            }catch(_){}
          }
          if(!tls.cert){ tls.enable=false; snack('未找到可用证书，已按纯 HTTP 创建',true); }
        }catch(_){ tls.enable=false; }
      }
      await adapter.createInstance(name,{ port, host:'0.0.0.0', tls, webToken:adminKey });
      snack('实例 '+name+' 已创建，正在启动…');
      try{ await adapter.action(name,'start'); }catch(_){}
      renderPorts();
    }
  }catch(e){ snack(e.message,true); return false; }
  return true;
}
// ---- Proxy server management (add/edit/remove; whole-array replace via saveConfig's proxies) ----
function openProxyDialog(name){
  const cur=Store.configs.get(Store.inst);
  const p=(cur&&cur.proxies&&cur.proxies[name])||{};
  openDialog(name?'编辑代理 '+name:'添加代理', `
    <div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
      <md-outlined-text-field data-f="name" label="名称" value="${escAttr(name||'')}" ${name?'disabled':''} required helper="在渠道中以此名称引用"></md-outlined-text-field>
      <md-outlined-select data-f="type" label="类型" style="width:100%">
        ${['socks5','http'].map(t=>`<md-select-option value="${t}" ${t===(p.type||'socks5')?'selected':''}>${t}</md-select-option>`).join('')}
      </md-outlined-select>
      <md-outlined-text-field data-f="host" label="服务器地址" value="${escAttr(p.host||'127.0.0.1')}" required></md-outlined-text-field>
      <md-outlined-text-field data-f="port" label="端口" type="number" value="${p.port||7890}"></md-outlined-text-field>
      <md-outlined-text-field data-f="username" label="用户名（可选）" value="${escAttr(p.username||'')}"></md-outlined-text-field>
      <md-outlined-text-field data-f="password" label="密码（可选）" type="password" value="${escAttr(p.password||'')}"></md-outlined-text-field>
    </div>`, {onOk:()=>saveProxy(name)});
  const s=$('#dlgBody [data-f=type]');
  if(s) s.updateComplete.then(()=>Promise.all([...s.querySelectorAll('md-select-option')].map(o=>o.updateComplete||0))).then(()=>s.value=p.type||'socks5').catch(()=>{});
}
async function saveProxy(origName){
  const v=dlgValue();
  const name=String(origName||v.name||'').trim();
  const host=String(v.host||'').trim();
  const port=Number(v.port);
  if(!name){ snack('名称必填',true); return false; }
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(name)){ snack('代理名仅可包含字母、数字、中划线、下划线',true); return false; }
  if(!host){ snack('服务器地址必填',true); return false; }
  if(!port||port<1||port>65535){ snack('端口范围 1-65535',true); return false; }
  try{
    const cur=await adapter.getConfig(Store.inst);
    const proxies=Object.assign({},(cur&&cur.proxies)||{});
    if(!origName&&proxies[name]){ snack('代理 '+name+' 已存在',true); return false; }
    const entry={ type:v.type||'socks5', host, port };
    const un=String(v.username||'').trim(), pw=String(v.password||'');
    if(un) entry.username=un;
else if(origName&&(cur.proxies[origName]||{}).username) entry.username=cur.proxies[origName].username; // empty = keep the old value
    if(pw) entry.password=pw;
    else if(origName&&(cur.proxies[origName]||{}).password) entry.password=cur.proxies[origName].password;
    proxies[name]=entry;
    await adapter.saveConfig(Store.inst,{proxies});
    snack(origName?('代理 '+name+' 已保存'):'代理 '+name+' 已添加');
    await renderProviders();
  }catch(e){ snack(e.message,true); return false; }
  return true;
}
async function delProxy(name){
  if(!name) return;
  try{
    const cur=await adapter.getConfig(Store.inst);
    const used=(cur.channels||[]).filter(c=>c.proxy===name).map(c=>c.name);
    const msg=used.length
      ? `确定删除代理 ${name}？渠道 ${used.join(', ')} 正在引用该代理，删除后相关渠道的代理将失效！`
      : `确定删除代理 ${name}？`;
    if(!confirm(msg)) return;
    const proxies=Object.assign({},(cur&&cur.proxies)||{});
    delete proxies[name];
    await adapter.saveConfig(Store.inst,{proxies});
    snack('代理 '+name+' 已删除');
    await renderProviders();
  }catch(e){ snack(e.message,true); }
}
async function saveProvider(){
  const v=dlgValue();
  if(!v.name||!v.baseUrl){ snack('名称与 Base URL 必填',true); return false; }
  // the model rename map comes from the tag editor (mmList); public -> real name; identical = served under the original name
  const modelMap={};
  for(const [k,r] of mmList) modelMap[k]=r;
  const ch={ name:v.name, type:v.type||'openai', baseUrl:v.baseUrl, path:String(v.path||'').trim(), proxy:v.proxy||'-',
    models:String(v.models||'').split(',').map(s=>s.trim()).filter(Boolean),
    apiKey:v.apiKey||'', default:!!v.default,
// Upstream balance passthrough: always send (empty string = clear); the backend inherits only on omission -- otherwise one channel edit wipes the balance config
// Upstream passthrough-to-Responses is three-state: unset (undefined) = auto passthrough /v1/responses; the field is submitted only when the user explicitly changes the checkbox,
// otherwise omit (avoids an edit baking undefined into false and silently killing Responses passthrough)
    balanceUrl:String(v.balanceUrl||'').trim(), balancePath:String(v.balancePath||'').trim(), balanceUnit:String(v.balanceUnit||'').trim(),
    probe:!!($('#dlgBody [data-f=probe]')&&$('#dlgBody [data-f=probe]').selected) };
// useResponses stays three-state: the field is submitted only when the user explicitly flipped the checkbox; otherwise omitted (undefined = auto passthrough /v1/responses)
  const urEl=$('#dlgBody [data-f=useResponses]');
  const urNow=!!(urEl&&urEl.selected);
  if(!!providerDlgOrigUseResponses!==urNow) ch.useResponses=urNow;
  const delayMs=Math.max(0,Math.min(120000,+v.delayMs||0));
if(delayMs) ch.delayMs=delayMs; // 0 = omit, clearing the old value
// 参数覆写: 有内容=写入(必须是 JSON 对象); 留空且原来有=清空; 原来没有=不提交, 保持「未覆写」
const ovText=String(v.paramOverride||'').trim();
if(ovText){
  let ov;
  try{ ov=JSON.parse(ovText); }catch(e){ snack('参数覆写 JSON 有误： '+e.message,true); return false; }
  if(!ov||typeof ov!=='object'||Array.isArray(ov)||!Object.keys(ov).length){ snack('参数覆写需为非空 JSON 对象',true); return false; }
  ch.paramOverride=ov;
}else if(providerDlgOrigParamOverride!==undefined) ch.paramOverride='';
if(providerDlgOrigName && providerDlgOrigName!==ch.name) ch.oldName=providerDlgOrigName; // rename
if(Object.keys(modelMap).length) ch.modelMap=modelMap; // never send an arrow-less empty map, so an existing one is not wiped
  try{ await adapter.saveChannel(Store.inst,ch);
    snack('已保存渠道 '+ch.name+(Object.keys(modelMap).length?' （改名映射重启实例后生效）':''));
    await renderProviders(); }
  catch(e){ snack(e.message,true); return false; }
  return true;
}
async function saveKeys(){
  try{
    const patch={webToken:$('#ky-webToken').value, channels:{}};
    $$('#ky-channels [data-keyfor]').forEach(el=>{ patch.channels[el.dataset.keyfor]=el.value; });
    await adapter.saveConfig(Store.inst,patch); snack('密钥已保存'); await renderKeys();
  }catch(e){ snack(e.message,true); }
}
async function saveRouting(){
  const ovText=String($('#rt-paramOverride').value||'').trim();
  let paramOverride=null;
  if(ovText){
    try{ paramOverride=JSON.parse(ovText); }catch(e){ snack('参数覆写 JSON 有误： '+e.message,true); return; }
    if(!paramOverride||typeof paramOverride!=='object'||Array.isArray(paramOverride)){ snack('参数覆写需为 JSON 对象',true); return; }
  }
  try{
    await adapter.saveConfig(Store.inst,{routing:{
      maxRetry:+$('#rt-maxRetry').value||0, timeoutSec:+$('#rt-timeout').value||0, cooldownSec:+$('#rt-cooldown').value||0 },
      redact:{enable:!!$('#rt-redact').selected, response:!!$('#rt-redactRes').selected, extra:rtExtra.slice()},
      modelSync:{enable:!!$('#rt-modelSync').selected, intervalHours:+$('#rt-syncInterval').value||24},
      paramOverride});
    snack('已保存（热重载生效）'); await renderRouting();
  }catch(e){ snack(e.message,true); }
}
async function doInstanceAction(name,cmd){
  if(cmd==='stop'&&name===Store.currentName){ snack('无法停止承载面板的实例',true); return; }
  try{
    await adapter.action(name,cmd); snack(`${name} ${cmd} 指令已发送`);
    if(cmd==='restart'){ let n=0; const ping=setInterval(async()=>{ n++;
      try{ await adapter.getInstances(); clearInterval(ping); snack(`${name} 已恢复`); renderPorts(); }
      catch(_){ if(n>20){ clearInterval(ping); snack(`${name} 未在 20 秒内恢复，请检查日志`,true); } } },1000); }
    else setTimeout(renderPorts,800);
  }catch(e){ snack(e.message,true); }
}

// Delete instance (button in the edit dialog): after confirmation, stops + removes config; irreversible
async function delInstance(name){
  if(!name||name==='default'||name===Store.currentName) return;
  if(!confirm('确定删除实例 '+name+' ？将停止该实例并删除其配置文件，不可恢复！')) return;
  try{
    await adapter.deleteInstance(name);
    closeDlg();
    snack('实例 '+name+' 已删除');
    renderPorts();
  }catch(e){ snack(e.message,true); }
}

// ============ Render: panel sessions ============
function fmtDateTime(ms){ try{ return new Date(ms).toLocaleString('zh-CN',{hour12:false}); }catch(_){ return String(ms); } }
function fmtLeft(ms){
  const d=Math.round((ms-Date.now())/1000);
  if(d<=0) return '已过期';
  if(d<3600) return Math.ceil(d/60)+' 分钟后';
  if(d<86400) return Math.ceil(d/3600)+' 小时后';
  return Math.ceil(d/86400)+' 天后';
}
function ssRows(list, kind){
  if(!list.length) return '<tr><td colspan="3" class="empty">'+(kind==='pend'?'登录链接不保存在面板中':'当前无有效会话')+'</td></tr>';
  return list.map(s=>`<tr>
    <td class="mono truncate" title="${escAttr(s.sid)}">${esc(String(s.sid).slice(0,10))}…</td>
    <td class="small">${esc(fmtDateTime(s.exp))}<span class="muted"> · ${esc(fmtLeft(s.exp))}</span></td>
    <td><div class="row-acts"><button type="button" class="icon-act err" data-action="revokeSession" data-sid="${escAttr(s.sid)}" title="注销该会话"><span class="msym">logout</span></button></div></td></tr>`).join('');
}
async function renderSession(){
  const signal=Store.abort('session');
  try{
    const d=await adapter.getWebSessions(signal);
    $('#ss-table tbody').innerHTML=ssRows(d.sessions||[], 'sess');
    $('#ss-pend tbody').innerHTML=ssRows(d.pending||[], 'pend');
    const at=Number(d.adminExpireAt)||0;
    $('#ss-expire-state').textContent=at?('已设定： '+fmtDateTime(at)+'（'+fmtLeft(at)+'）'):'未设定';
    const inp=$('#ss-expire-at');
    if(inp) inp.value=at?new Date(at-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';
  }catch(e){ if(e.name!=='AbortError') snack(e.message,true); }
}
async function revokeSession(sid){
  const msg=sid?'确定注销该会话？对应浏览器需重新使用登录链接进入。':'确定注销全部会话？包括当前浏览器，之后需重新执行 agw web login。';
  if(!confirm(msg)) return;
  try{
    await adapter.revokeWebSession(sid);
    snack('已注销');
    if(sid) renderSession();
    else setTimeout(()=>location.reload(),600);
  }catch(e){ snack(e.message,true); }
}
async function setAdminExpire(){
  const v=$('#ss-expire-at')?.value;
  if(!v){ snack('请先选择时间',true); return; }
  const at=new Date(v).getTime();
  if(!(at>0)){ snack('时间无效',true); return; }
  try{ await adapter.setAdminExpire(at); snack('已设定定时注销： '+fmtDateTime(at)); renderSession(); }
  catch(e){ snack(e.message,true); }
}
async function clearAdminExpire(){
  try{ await adapter.setAdminExpire(0); snack('已取消定时注销'); renderSession(); }
  catch(e){ snack(e.message,true); }
}

// ============ Statistics charts (plain canvas) ============
function cvCtx(id, h){
  const cv=$('#'+id); if(!cv) return null;
  const dpr=window.devicePixelRatio||1;
  const w=Math.max(160, Math.floor(cv.clientWidth||cv.parentElement?.clientWidth||320));
  cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr); cv.style.height=h+'px';
  const cx=cv.getContext('2d'); cx.setTransform(dpr,0,0,dpr,0,0); cx.clearRect(0,0,w,h);
  chartFont(cx,11); cx.textBaseline='middle';
  return {cx,w,h};
}
function chartFont(cx,size,weight){
  cx.font=(weight?weight+' ':'')+size+'px system-ui,-apple-system,"Noto Sans SC",sans-serif';
}
function cssVar(n, fb){ const v=getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v||fb; }
// One unit scale for every counter: K / M / B, one decimal under 100, integers above.
// Thresholds sit at xx9995 so a value never prints as "1000K" instead of rolling over to "1M".
function shortNum(n){ n=Number(n)||0;
  const a=Math.abs(n);
  const fmt=(v,u)=> (v>=100?String(Math.round(v)):String(Math.round(v*10)/10))+u;
  if(a>=999.5e6) return fmt(n/1e9,'B');
  if(a>=999.5e3) return fmt(n/1e6,'M');
  if(a>=1e3)     return fmt(n/1e3,'K');
  return String(Math.round(n));
}
function fitText(cx,s,maxW){
  let t=String(s==null?'':s);
  if(cx.measureText(t).width<=maxW) return t;
  while(t.length>1 && cx.measureText(t+'…').width>maxW) t=t.slice(0,-1);
  return t+'…';
}
// Slice/bar colours are derived from the current primary seed, so they follow the theme instead of being hard-coded
function chartPalette(n){
  const base=hexToHSL(cssVar('--md-sys-color-primary','#D0BCFF'));
  const dark=(document.documentElement.dataset.theme||'dark')!=='light';
  const sat=Math.max(30,Math.min(78,base.s||42));
  const lit=dark?68:46;
  n=Math.max(1,n);
  return Array.from({length:n},(_,i)=>{
    const h=((base.h+(i*360/n)*0.78)%360+360)%360;
    return hslToHex(h, sat, dark?(i%2?lit+9:lit):(i%2?lit-9:lit));
  });
}

// ---- 用量趋势 (per day / hour / minute): bars / line ----
function drawDailyChart(days, mode, id){
  const H=210, g=cvCtx(id||'st-chart-daily-bar',H); if(!g) return;
  const {cx,w,h}=g;
  const onSurf=cssVar('--md-sys-color-on-surface-variant','#9a9a9a');
  const prim=cssVar('--md-sys-color-primary','#D0BCFF'), tert=cssVar('--md-sys-color-tertiary','#EFB8C8');
  const grid=cssVar('--md-sys-color-outline-variant','#444');
  const padL=42, padR=10, padT=20, padB=24, iw=Math.max(24,w-padL-padR), ih=h-padT-padB;
  if(!days||!days.length){ chartFont(cx,11); cx.fillStyle=onSurf; cx.fillText('暂无数据（需有请求经过）', padL, h/2); return; }
  const max=Math.max(1,...days.map(d=>Math.max(d.in||0,d.out||0)));
  cx.strokeStyle=grid; cx.lineWidth=1;
  chartFont(cx,10);
  for(let i=0;i<=3;i++){
    const y=Math.round(padT+ih*i/3)+.5;
    cx.beginPath(); cx.moveTo(padL,y); cx.lineTo(w-padR,y); cx.stroke();
    cx.fillStyle=onSurf; cx.fillText(shortNum(max*(1-i/3)),6,y);
  }
  const slot=iw/days.length;
  const at=(i,v)=>[padL+slot*i+slot/2, padT+ih-ih*(v||0)/max];
  if(mode==='line'){
    [['in',prim],['out',tert]].forEach(([k,c])=>{
      cx.strokeStyle=c; cx.lineWidth=2; cx.lineJoin='round';
      cx.beginPath();
      days.forEach((d,i)=>{ const [x,y]=at(i,d[k]); if(i) cx.lineTo(x,y); else cx.moveTo(x,y); });
      cx.stroke();
      cx.fillStyle=c;
      days.forEach((d,i)=>{ const [x,y]=at(i,d[k]); cx.beginPath(); cx.arc(x,y,2.4,0,Math.PI*2); cx.fill(); });
    });
  } else {
    const bw=Math.max(2,Math.min(9,slot/3.2));
    days.forEach((d,i)=>{
      const x=padL+slot*i+(slot-(bw*2+2))/2;
      [[d.in||0,prim],[d.out||0,tert]].forEach(([v,c],k)=>{
        if(!(v>0)) return;
        const bh=Math.max(2,ih*v/max);
        cx.fillStyle=c; cx.fillRect(x+k*(bw+2), padT+ih-bh, bw, bh);
      });
    });
  }
  chartFont(cx,10);
  days.forEach((d,i)=>{
    if(days.length<=8 || i%Math.ceil(days.length/6)===0){
      cx.fillStyle=onSurf; cx.textAlign='center';
      cx.fillText(d.label, padL+slot*i+slot/2, padT+ih+12);
      cx.textAlign='left';
    }
  });
  chartFont(cx,10);
  cx.fillStyle=prim; cx.fillRect(w-padR-108,2,8,8);
  cx.fillStyle=onSurf; cx.fillText('输入', w-padR-97, 6);
  cx.fillStyle=tert; cx.fillRect(w-padR-62,2,8,8);
  cx.fillStyle=onSurf; cx.fillText('输出', w-padR-51, 6);
}

// ---- 按模型用量: bars / pie ----
function drawModelChart(rows, mode, id){
  if(mode==='pie') return drawPieChart(id, rows, {maxSlices:6});
  return drawVBars(id, rows, '暂无数据（需有请求经过）');
}

// ---- Token 用途分布: horizontal bars / pie ----
function drawDistChart(rows, mode, id){
  if(mode==='pie') return drawPieChart(id, rows, {maxSlices:7});
  return drawHBars(id, rows, '暂无分布数据（需有请求经过）');
}

function drawVBars(id, rows, emptyText){
  const H=210, g=cvCtx(id,H); if(!g) return;
  const {cx,w,h}=g;
  const onSurf=cssVar('--md-sys-color-on-surface-variant','#9a9a9a');
  const items=(rows||[]).filter(r=>(r.value||0)>0).slice(0,8);
  if(!items.length){ chartFont(cx,11); cx.fillStyle=onSurf; cx.fillText(emptyText,12,h/2); return; }
  const padL=10, padR=10, padT=20, padB=58, iw=Math.max(24,w-padL-padR), ih=h-padT-padB;
  const max=Math.max(1,...items.map(r=>r.value));
  const slot=iw/items.length, bw=Math.min(30,Math.max(6,slot*0.56));
  const cols=chartPalette(items.length);
  items.forEach((r,i)=>{
    const x=padL+slot*i+(slot-bw)/2;
    const bh=Math.max(2,ih*r.value/max);
    cx.fillStyle=cols[i];
    cx.fillRect(x, padT+ih-bh, bw, bh);
    chartFont(cx,9);
    cx.fillStyle=onSurf; cx.textAlign='center';
    cx.fillText(shortNum(r.value), x+bw/2, padT+ih-bh-8);
    cx.save();
    cx.translate(x+bw/2, padT+ih+8);
    cx.rotate(-Math.PI/4);
    cx.textAlign='right';
    cx.fillText(fitText(cx, r.name, 96), 0, 0);
    cx.restore();
  });
}

function drawHBars(id, rows, emptyText){
  const H=210, g=cvCtx(id,H); if(!g) return;
  const {cx,w,h}=g;
  const onSurf=cssVar('--md-sys-color-on-surface-variant','#9a9a9a');
  const track=cssVar('--md-sys-color-surface-container-highest','#2a2a2a');
  const items=(rows||[]).filter(r=>(r.value||0)>0).slice(0,8);
  if(!items.length){ chartFont(cx,11); cx.fillStyle=onSurf; cx.fillText(emptyText,12,h/2); return; }
  const max=Math.max(1,...items.map(r=>r.value));
  const padL=Math.min(112,Math.max(62,w*0.32)), padR=64, padT=6, padB=6;
  const ih=h-padT-padB, rowH=ih/items.length, barH=Math.min(15,rowH*0.55);
  const cols=chartPalette(items.length);
  items.forEach((r,i)=>{
    const cy=padT+rowH*i+rowH/2;
    const bw=Math.max(2,(w-padL-padR)*r.value/max);
    cx.fillStyle=track; cx.fillRect(padL, cy-barH/2, w-padL-padR, barH);
    cx.fillStyle=cols[i]; cx.fillRect(padL, cy-barH/2, bw, barH);
    chartFont(cx,10);
    cx.fillStyle=onSurf; cx.textAlign='right';
    cx.fillText(fitText(cx, r.name, padL-10), padL-6, cy);
    cx.fillText(shortNum(r.value), w-6, cy);
    cx.textAlign='left';
  });
}

function drawPieChart(id, rows, {maxSlices=6}={}){
  const H=210, g=cvCtx(id,H); if(!g) return;
  const {cx,w,h}=g;
  const onSurf=cssVar('--md-sys-color-on-surface-variant','#9a9a9a');
  const onSurfMain=cssVar('--md-sys-color-on-surface','#E6E1E5');
  const surf=cssVar('--md-sys-color-surface-container','#211F26');
  const list=(rows||[]).filter(r=>(r.value||0)>0);
  if(!list.length){ chartFont(cx,11); cx.fillStyle=onSurf; cx.fillText('暂无数据（需有请求经过）',12,h/2); return; }
  const items=list.slice(0,maxSlices).map(r=>({name:r.name,value:r.value}));
  const rest=list.slice(maxSlices).reduce((t,r)=>t+r.value,0);
  if(rest>0) items.push({name:'其他',value:rest});
  const total=items.reduce((t,r)=>t+r.value,0);
  const cols=chartPalette(items.length);
  const R=Math.max(34,Math.min(h*0.36,w*0.24));
  const px=R+12, py=h/2;
  let a0=-Math.PI/2;
  items.forEach((it,i)=>{
    const da=it.value/total*Math.PI*2;
    cx.beginPath(); cx.moveTo(px,py); cx.arc(px,py,R,a0,a0+da); cx.closePath();
    cx.fillStyle=cols[i]; cx.fill();
    cx.strokeStyle=surf; cx.lineWidth=1.5; cx.stroke();
    a0+=da;
  });
  cx.beginPath(); cx.arc(px,py,R*0.56,0,Math.PI*2); cx.fillStyle=surf; cx.fill();
  chartFont(cx,12,'600'); cx.fillStyle=onSurfMain; cx.textAlign='center';
  cx.fillText(shortNum(total), px, py-2);
  chartFont(cx,9); cx.fillStyle=onSurf; cx.fillText('合计', px, py+12);
  cx.textAlign='left';
  const lx=px+R+14, lw=Math.max(40,w-lx-6);
  const rowH=Math.min(18,(h-8)/Math.max(1,items.length));
  let ly=h/2-(items.length*rowH)/2+rowH/2;
  items.forEach((it,i)=>{
    cx.fillStyle=cols[i]; cx.fillRect(lx, ly-4, 8, 8);
    const pct=total?(it.value/total*100).toFixed(1)+'%':'0%';
    chartFont(cx,9);
    const pw=cx.measureText(pct).width;
    chartFont(cx,10); cx.fillStyle=onSurf;
    cx.fillText(fitText(cx, it.name, Math.max(20,lw-14-pw-4)), lx+12, ly);
    chartFont(cx,9); cx.fillStyle=onSurfMain;
    cx.fillText(pct, w-6-pw, ly);
    ly+=rowH;
  });
}

// ============ Events (centralized delegation) ============
document.body.addEventListener('click', e=>{
  const head=e.target.closest('.xc-head');
  if(head){ xcToggle(head); return; }
  const gran=e.target.closest('[data-gran]');
  if(gran){ setGran(gran.dataset.gran); return; }
  const tab=e.target.closest('[data-chart]');
  if(tab && tab.dataset.chart){ setChartMode(tab.dataset.chart, tab.dataset.mode); return; }
  const nav=e.target.closest('[data-page]');
  if(nav?.dataset.page){
    if(nav.closest('#dlgBody')) closeDlg();
    if(nav.closest('#railList')) setRail(false);
    go(nav.dataset.page); return;
  }
  const jump=e.target.closest('[data-goto]');
  if(jump?.dataset.goto){ go(jump.dataset.goto); return; }
  const act=e.target.closest('[data-action]');
  if(act){
    const a=act.dataset.action, n=act.dataset.name;
    if(a==='editProvider'){ const cfg=Store.configs.get(Store.inst); openProviderDialog(cfg?.channels?.find(c=>c.name===n)); }
    else if(a==='setDefaultProvider'){ setDefaultChannel(n); }
    else if(a==='deleteProvider'){ if(confirm(`删除渠道 ${n}？`)) adapter.deleteChannel(Store.inst,n).then(renderProviders).catch(x=>snack(x.message,true)); }
    else if(a==='openPortDialog') openPortDialog(n);
    else if(a==='delInstance') delInstance(n);
    else if(a==='copyKey'||a==='toggleKey'||a==='delKey'||a==='rechargeKey') cardAction(a,act.dataset.key,act.dataset.name,act.dataset.on==='1');
    else if(a==='chBalance') chBalanceAction(act.dataset.name);
    else if(a==='editProxy') openProxyDialog(n);
    else if(a==='delProxy') delProxy(n);
    else if(a==='viewBody') viewRecordBody(act.dataset.id);
    else if(a==='cwDel') cwDel(+act.dataset.i);
    else if(a==='anView'){ openAnnounceView(anItems.find(x=>x.id===n)); }
    else if(a==='anEdit'){ openAnnounceDialog(anItems.find(x=>x.id===n)); }
    else if(a==='anDel'){ if(confirm('删除该公告？')) adapter.deleteAnnouncement(n).then(renderAnnounce).catch(x=>snack(x.message,true)); }
    else if(a==='revokeSession') revokeSession(act.dataset.sid||'');
    return;
  }
  const cmdBtn=e.target.closest('[data-cmd]');
  if(cmdBtn?.dataset.cmd) doInstanceAction(cmdBtn.dataset.name, cmdBtn.dataset.cmd);
});
// Keyboard path for div[role=button] targets (a real <button> cannot hold the announcement page layout).
// Only the target itself counts: a card wrapping action buttons must keep its own Enter behaviour.
document.body.addEventListener('keydown', e=>{
  if(e.key!=='Enter' && e.key!==' ') return;
  const el=e.target;
  if(!el || !el.matches || !el.matches('[data-action="anView"]')) return;
  e.preventDefault(); el.click();
});
$('#dlgOk').addEventListener('click', async ()=>{
  const btn=$('#dlgOk'); btn.disabled=true;
  try{
    const ok = dlgOnOk ? await dlgOnOk() : true;
    if(ok!==false) closeDlg();
  } finally { btn.disabled=false; }
});
$('#dlgCancel').addEventListener('click', ()=>closeDlg());
$('#dlgX').addEventListener('click', ()=>closeDlg());
$('#dlgOverlay').addEventListener('click', e=>{ if(e.target===e.currentTarget) closeDlg(); });
$('#an-add').addEventListener('click',()=>openAnnounceDialog());
$('#pv-add').addEventListener('click',()=>openProviderDialog());
$('#px-add').addEventListener('click',()=>openProxyDialog());
['out','inc'].forEach(dir=>{
  const add=$('#rp-'+dir+'-add');
  if(!add) return;
  add.addEventListener('click',()=>rpAdd(dir));
  [$('#rp-'+dir+'-find'),$('#rp-'+dir+'-to')].forEach(el=>el&&el.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); rpAdd(dir); } }));
  rpBindSwipe(dir);
  $('#rp-'+dir+'-chips').addEventListener('click',e=>{ const x=e.target.closest('.mm-x'); if(x) rpDel(dir,+x.dataset.i); });
});
const rpTestOut=$('#rp-test-out-btn'), rpTestInc=$('#rp-test-inc-btn');
if(rpTestOut) rpTestOut.addEventListener('click',()=>{ const rules=rpCompileCli(rpLists.out); const r=rpApplyCli($('#rp-test-in')?$('#rp-test-in').value:'',rules); $('#rp-test-result').textContent = r===''?'（空）':r; });
if(rpTestInc) rpTestInc.addEventListener('click',()=>{ const rules=rpCompileCli(rpLists.inc); const r=rpApplyCli($('#rp-test-in')?$('#rp-test-in').value:'',rules); $('#rp-test-result').textContent = r===''?'（空）':r; });
  $('#pt-new').addEventListener('click',()=>openPortDialog());
  $('#cd-new').addEventListener('click',()=>openCardDialog());
  // second factor
  $('#ka-save-second').addEventListener('click',async()=>{ try{ await adapter.setAdminAuth(Store.inst,{secondKey:$('#ka-secondKey').value}); snack('第二密码已保存'); loadAdminAuth(Store.inst); }catch(e){ snack(e.message,true); } });
  $('#ka-totp-enable').addEventListener('click',async()=>{ try{ const r=await adapter.setAdminAuth(Store.inst,{totpAction:'enable'}); if(r.totpSecret){ $('#ka-totp-info').style.display=''; $('#ka-totp-secret').textContent=r.totpSecret; $('#ka-totp-url').textContent=r.otpauthUrl||''; } snack('TOTP 已启用，请立即扫码并保存密钥！'); loadAdminAuth(Store.inst); }catch(e){ snack(e.message,true); } });
  $('#ka-totp-disable').addEventListener('click',async()=>{ try{ await adapter.setAdminAuth(Store.inst,{totpAction:'disable'}); snack('TOTP 已停用'); loadAdminAuth(Store.inst); }catch(e){ snack(e.message,true); } });
  $('#rg-save').addEventListener('click',saveCardSettings);
// Tunnel
  $('#tn-toggle').addEventListener('click',async()=>{ try{ const d=await adapter.getTunnel(); await adapter.tunnelAction(d.running?'stop':'start'); snack(d.running?'隧道已停止':'隧道启动中…'); setTimeout(loadTunnel,1500); }catch(e){ snack(e.message,true); } });
  $('#tn-copy').addEventListener('click',()=>{ const t=$('#tn-url').textContent; if(t){ navigator.clipboard&&navigator.clipboard.writeText(t); snack('已复制'); } });
['#rt-save','#rt-save2','#rt-save3','#rt-save4'].forEach(sel=>{ const b=$(sel); if(b) b.addEventListener('click',saveRouting); });
$('#rt-reset').addEventListener('click',renderRouting);
if($('#rt-extra-add')) $('#rt-extra-add').addEventListener('click',rtAddChip);
if($('#rt-extra-find')) $('#rt-extra-find').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.isComposing){ e.preventDefault(); rtAddChip(); } });
if($('#rt-extra-chips')) $('#rt-extra-chips').addEventListener('click',e=>{
  const x=e.target.closest('.mm-x'); if(!x) return;
  rtExtra.splice(+x.dataset.i,1); rtRenderChips();
});
$('#rt-syncNow').addEventListener('click', async ()=>{
  const btn=$('#rt-syncNow'); btn.disabled=true; const old='立即同步'; btn.textContent='同步中…';
  try{ const r=await adapter.syncModels(Store.inst);
    snack('已同步： '+r.added+' 个新模型'+(r.fails?', '+r.fails+' 失败':''));
    await renderRouting();
  }catch(e){ snack(e.message,true); }
  btn.disabled=false; btn.textContent=old;
});
$('#ky-save').addEventListener('click',saveKeys);
$('#ss-revoke-all').addEventListener('click',()=>revokeSession(''));
$('#ss-expire-set').addEventListener('click',setAdminExpire);
$('#ss-expire-clear').addEventListener('click',clearAdminExpire);
$('#lg-req-refresh').addEventListener('click',renderLogs);
$('#lg-rec-enable').addEventListener('change',saveRecCfg);
// The text field's own change relies on the native event bubbling out of its shadow root; focusout + Enter make the save certain
$('#lg-rec-server').addEventListener('change',saveRecCfg);
$('#lg-rec-server').addEventListener('focusout',saveRecCfg);
$('#lg-rec-server').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.isComposing) saveRecCfg(); });
$('#lg-refresh').addEventListener('click',renderLogs);
OV_CAR_LISTS.forEach(sel=>$(sel)?.addEventListener('pointerenter',()=>{ Store._ovHover=true; }));
OV_CAR_LISTS.forEach(sel=>$(sel)?.addEventListener('pointerleave',()=>{ Store._ovHover=false; }));
$('#refreshBtn').addEventListener('click',()=>{ go(Store.page); });
$('#refreshBtn').addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ go(Store.page); } });
$('#topInst').addEventListener('change', e=>{ Store.inst=e.target.value; go(Store.page); });
window.addEventListener('online',()=>{ Store.online=true; });
window.addEventListener('offline',()=>{ Store.online=false; snack('网络已断开',true); });

// ============ Boot ============
if(!MW_OK){
  $('#compatBar').textContent='⚠ Material Web 组件库（vendor/mw-v2.js）加载失败，页面将仅显示无样式内容。请确认文件已部署。';
  $('#compatBar').classList.add('show');
}
$('#keyBtn').addEventListener('click',openKeyDialog);
$('#railToggle').addEventListener('click',toggleRail);
$('#railScrim').addEventListener('click',()=>setRail(false));
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&railOpen()) setRail(false); });
$('#thBtn').addEventListener('click',openThemeDialog);
$('#bgBtn').addEventListener('click',openBgDialog);
// ?key=<webToken> one-click token access: store in localStorage and scrub from the address bar
try{
  const u=new URL(location.href);
  const k=u.searchParams.has('key')?u.searchParams.get('key'):'';
  if(k!=null){
    if(k) localStorage.setItem('agw-admin-key',k); else localStorage.removeItem('agw-admin-key');
    u.searchParams.delete('key'); history.replaceState(null,'',u);
  }
}catch(_){}
upgradePwFields(document.body);
// ---- Dynamic background: default gradient / aurora / uploaded image (stored in localStorage, per device) ----
// The image never leaves the device: it is downscaled and re-encoded as JPEG before it reaches
// localStorage, stepping resolution/quality down so a phone photo cannot blow the quota.
const BG_KEY='agw-bg';
let bgDraft=null;      // image picked in the open dialog; written to localStorage only on 应用
let bgCleared=false;   // 移除图片 pressed in the open dialog
function bgLoad(){ try{ return JSON.parse(localStorage.getItem(BG_KEY)||'null')||{}; }catch(_){ return {}; } }
function applyBg(){
  const layer=$('#bgLayer'); if(!layer) return;
  const st=bgLoad(), mode=st.mode||'none';
  if(mode==='aurora'){ layer.className='aurora'; layer.style.backgroundImage=''; }
  else if(mode==='img'&&st.img){ layer.className='img'; layer.style.backgroundImage=`url(${st.img})`; }
  else { layer.className=''; layer.style.backgroundImage=''; }
}
function bgReadFile(file){
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=()=>res(String(r.result||''));
    r.onerror=()=>rej(new Error('图片读取失败'));
    r.readAsDataURL(file);
  });
}
function bgDecode(src){
  return new Promise((res,rej)=>{
    const img=new Image();
    img.onload=()=>res(img);
    img.onerror=()=>rej(new Error('图片无法读取'));
    img.src=src;
  });
}
function bgEncode(img,max,q){
  const sc=Math.min(1,max/Math.max(img.width||1,img.height||1));
  const c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(img.width*sc)); c.height=Math.max(1,Math.round(img.height*sc));
  const g=c.getContext('2d');
  g.fillStyle='#141218'; g.fillRect(0,0,c.width,c.height); // JPEG has no alpha; a transparent PNG would land on black anyway
  g.drawImage(img,0,0,c.width,c.height);
  return c.toDataURL('image/jpeg',q);
}
async function bgPrepareImage(file){
  const img=await bgDecode(await bgReadFile(file));
  let out='';
  for(const [max,q] of [[1600,.82],[1280,.76],[1024,.7],[840,.64],[680,.58],[520,.5]]){
    out=bgEncode(img,max,q);
    if(out.length<=900*1024) break;
  }
  return out;
}
function bgSyncPreview(){
  const box=$('#bgPreview'), hint=$('#bgFileHint'), clr=$('#bgClear');
  const st=bgLoad();
  const img=bgCleared?null:(bgDraft||st.img||null);
  if(box) box.style.backgroundImage=img?`url(${img})`:'';
  if(hint) hint.textContent=bgDraft?`新图片已就绪（${Math.round(bgDraft.length/1024)}KB），点击「应用」生效`:(img?'当前图片已设置':'未上传图片');
  if(clr) clr.style.display=img?'':'none';
}
function openBgDialog(){
  const st=bgLoad();
  let mode=st.mode||'none';
  if(mode==='img'&&!st.img) mode='none';
  bgDraft=null; bgCleared=false;
  openDialog('动态背景', `<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
    <md-outlined-select data-f="bgmode" label="背景模式" style="width:100%">
      ${[['none','默认渐变'],['aurora','七色流光'],['img','自定义图片']].map(([v,t])=>`<md-select-option value="${v}" ${v===mode?'selected':''}>${t}</md-select-option>`).join('')}
    </md-outlined-select>
    <div style="display:flex;gap:8px;align-items:center;min-width:0">
      <div id="bgPreview" title="点击选择图片" style="width:72px;height:48px;flex:none;border-radius:8px;border:1px solid var(--md-sys-color-outline-variant);background:var(--md-sys-color-surface-container-high) center/cover no-repeat"></div>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:0;flex:1">
        <input type="file" id="bgFile" accept="image/*" style="font-size:10px;min-width:0;max-width:100%">
        <div id="bgFileHint" style="font-size:9px;color:var(--md-sys-color-on-surface-variant)"></div>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <md-text-button id="bgClear">移除图片</md-text-button>
      <span style="font-size:9px;color:var(--md-sys-color-on-surface-variant)">图片仅保存在本设备浏览器中，不会上传至网关</span>
    </div>
  </div>`, {okText:'应用', onOk:()=>{
    const m=String(dlgValue().bgmode||'none');
    const cur=bgLoad();
    const img=bgCleared?null:(bgDraft||cur.img||null);
    if(m==='img'&&!img){ snack('请先选择一张图片',true); return false; }
    const next=Object.assign({},cur,{mode:m});
    if(img) next.img=img; else delete next.img;
    try{ localStorage.setItem(BG_KEY,JSON.stringify(next)); }
    catch(e){ snack('保存失败：浏览器存储空间不足，请更换更小的图片',true); return false; }
    applyBg(); snack('背景已更新'); return true;
  }});
  bgSyncPreview();
  const sel=$('#dlgBody md-outlined-select');
  if(sel) sel.updateComplete
    .then(()=>Promise.all([...sel.querySelectorAll('md-select-option')].map(o=>o.updateComplete||0)))
    .then(()=>{ sel.value=mode; patchSelect(sel); })
    .catch(()=>{});
  $('#bgPreview')?.addEventListener('click',()=>$('#bgFile')?.click());
  $('#bgClear')?.addEventListener('click',()=>{
    bgDraft=null; bgCleared=true; bgSyncPreview();
    const s=$('#dlgBody md-outlined-select'); if(s){ s.value='none'; patchSelect(s); }
  });
}
document.body.addEventListener('change', async e=>{
  if(!e.target||e.target.id!=='bgFile') return;
  const f=e.target.files&&e.target.files[0]; if(!f) return;
  const hint=$('#bgFileHint'); if(hint) hint.textContent='正在处理图片…';
  try{
    bgDraft=await bgPrepareImage(f);
    bgCleared=false;
    const sel=$('#dlgBody md-outlined-select');
    if(sel&&sel.value!=='img'){ sel.value='img'; patchSelect(sel); }
    bgSyncPreview();
  }catch(err){ snack(err.message||'图片处理失败',true); bgSyncPreview(); }
});

// ---- Custom brand: page name + gateway logo (edit via the brand area top-left; localStorage, per device) ----
// The logo is shown in the sidebar brand, the topbar (next to the page title), the about card, and as
// the favicon. An SVG stays vector; raster images are downscaled with alpha preserved. It never leaves
// the device: localStorage holds it as a data URL.
let brandState={name:'OpenAGW',ver:'Material Web v2.11',logo:''};
let brandDraft=null;        // logo picked in the open dialog; written to localStorage only on 保存
let brandLogoCleared=false; // 移除 Logo pressed in the open dialog
function applyBrand(b){
  brandState={name:(b&&b.name)||'OpenAGW', ver:b&&b.ver!=null?b.ver:'Material Web v2.11', logo:(b&&b.logo)||''};
  const n=$('.rail-brand .name'), v=$('.rail-brand .ver');
  if(n) n.textContent=brandState.name;
  if(v){ v.textContent=brandState.ver; v.style.display=brandState.ver?'':'none'; }
  const an=$('#ov-about-name'), av=$('#ov-about-ver');
  if(an) an.textContent=brandState.name;
  if(av){ av.textContent=brandState.ver; av.style.display=brandState.ver?'':'none'; }
  ['#railLogo','#topLogo','#ov-about-logo'].forEach(sel=>{
    const img=$(sel); if(!img) return;
    if(brandState.logo){ img.src=brandState.logo; img.hidden=false; }
    else { img.hidden=true; img.removeAttribute('src'); }
  });
  // Favicon follows the logo; removing the logo restores the browser default icon
  let fav=$('#favicon');
  if(brandState.logo){
    if(!fav){ fav=document.createElement('link'); fav.id='favicon'; fav.rel='icon'; document.head.appendChild(fav); }
    fav.href=brandState.logo;
  } else if(fav) fav.remove();
  document.title=brandState.name+(brandState.ver?' · '+brandState.ver:'');
}
function loadBrand(){ try{ applyBrand(JSON.parse(localStorage.getItem('agw-brand')||'null')); }catch(_){ applyBrand(null); } }
function brandLogoSrc(){ return brandLogoCleared?null:(brandDraft||brandState.logo||null); }
function brandEncode(img,max){
  const sc=Math.min(1,max/Math.max(img.width||1,img.height||1));
  const c=document.createElement('canvas');
  c.width=Math.max(1,Math.round(img.width*sc)); c.height=Math.max(1,Math.round(img.height*sc));
  c.getContext('2d').drawImage(img,0,0,c.width,c.height);
  const webp=c.toDataURL('image/webp',.92);
  return /^data:image\/webp/i.test(webp)?webp:c.toDataURL('image/png');
}
async function brandPrepareLogo(file){
  if(/svg/i.test(file.type)||/\.svg$/i.test(file.name||'')){
    if(file.size>200*1024) throw new Error('SVG 过大，上限 200KB');
    const raw=await bgReadFile(file);
    return 'data:image/svg+xml;base64,'+raw.slice(raw.indexOf(',')+1);
  }
  const img=await bgDecode(await bgReadFile(file));
  let out='';
  for(const max of [256,192,144,96]){ out=brandEncode(img,max); if(out.length<=220*1024) break; }
  return out;
}
function brandSyncLogo(){
  const pv=$('#brandLogoPreview'), ph=$('#brandLogoPlaceholder'), hint=$('#brandLogoHint'), clr=$('#brandLogoClear');
  const logo=brandLogoSrc();
  if(pv){ if(logo){ pv.src=logo; pv.hidden=false; } else { pv.hidden=true; pv.removeAttribute('src'); } }
  if(ph) ph.style.display=logo?'none':'';
  if(hint) hint.textContent=brandDraft?`新 Logo 已就绪（${Math.round(brandDraft.length/1024)}KB），点击「保存」生效`
    :(logo?'当前 Logo 已设置':'支持 SVG / PNG / JPG / WebP / GIF · 仅保存在本设备');
  if(clr) clr.style.display=logo?'':'none';
}
function openBrandDialog(){
  brandDraft=null; brandLogoCleared=false;
  openDialog('品牌设置', `<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
    <div style="display:flex;gap:10px;align-items:center;min-width:0">
      <button type="button" class="brand-logo-pick" id="brandLogoPick" aria-label="选择 Logo" title="点击选择 Logo">
        <img id="brandLogoPreview" alt="" hidden>
        <span class="msym" id="brandLogoPlaceholder">add_photo_alternate</span>
      </button>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:0;flex:1">
        <div style="font-size:11px">网关 Logo</div>
        <input type="file" id="brandLogoFile" accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif" style="font-size:10px;min-width:0;max-width:100%">
        <div id="brandLogoHint" style="font-size:9px;color:var(--md-sys-color-on-surface-variant)"></div>
      </div>
    </div>
    <md-text-button id="brandLogoClear" style="align-self:flex-start">移除 Logo</md-text-button>
    <md-outlined-text-field data-f="bname" label="名称" value="${escAttr(brandState.name)}"></md-outlined-text-field>
    <md-outlined-text-field data-f="bver" label="副标题（留空隐藏）" value="${escAttr(brandState.ver)}"></md-outlined-text-field>
  </div>`, {okText:'保存', onOk:()=>{
    const v=dlgValue();
    const name=String(v.bname||'').trim()||'OpenAGW', ver=String(v.bver||'').trim();
    const logo=brandLogoSrc()||'';
    try{ localStorage.setItem('agw-brand',JSON.stringify({name,ver,logo})); }
    catch(e){ snack('保存失败：浏览器存储空间不足，请更换更小的 Logo',true); return false; }
    applyBrand({name,ver,logo});
    snack('品牌已更新');
    return true;
  }});
  brandSyncLogo();
  $('#brandLogoPick')?.addEventListener('click',()=>$('#brandLogoFile')?.click());
  $('#brandLogoClear')?.addEventListener('click',()=>{ brandDraft=null; brandLogoCleared=true; brandSyncLogo(); });
  $('#brandLogoFile')?.addEventListener('change',async e=>{
    const input=e.target, f=input.files&&input.files[0]; if(!f) return;
    const hint=$('#brandLogoHint'); if(hint) hint.textContent='正在处理 Logo…';
    try{
      brandDraft=await brandPrepareLogo(f);
      brandLogoCleared=false;
      brandSyncLogo();
    }catch(err){ snack(err.message||'Logo 处理失败',true); brandSyncLogo(); }
    try{ input.value=''; }catch(_){}
  });
}
loadBrand();
$('#railBrand').addEventListener('click', openBrandDialog);
loadTheme();
applyBg();
try{ const cm=JSON.parse(localStorage.getItem('agw-chart')||'null'); if(cm) Store.chartMode=Object.assign(Store.chartMode,cm); }catch(_){}
try{ const g=localStorage.getItem('agw-gran'); if(g && GRAN_NOTE[g]) Store.gran=g; }catch(_){}
{ const n=$('#st-gran-note'); if(n) n.textContent=GRAN_NOTE[Store.gran]; }
syncGranTabs();
lgBind();
try{ setRail(localStorage.getItem('agw-rail')==='open', false); }catch(_){ setRail(false, false); }
buildNav();
syncNav(true);
syncChartTabs();
bindChartTracks();
// Never let a slow/hung first /admin/api/instances call block the whole boot:
// render the default page after at most 6s; the per-page render has its own 20s abort guard.
await Promise.race([
  fillInstSelect($('#topInst'), Store.inst).catch(()=>{}),
  new Promise(r=>setTimeout(r,6000)),
]);
go(Store.page);
let chartResizeT=0;
window.addEventListener('resize',()=>{
  clearTimeout(chartResizeT);
  chartResizeT=setTimeout(()=>{
    if(Store.page==='stats'){ drawAllCharts(); alignChartTracks(false, true); }
  },150);
});
console.log('[OpenAGW] Material Web 面板已初始化 · 组件库', MW_OK?'就绪':'缺失');
