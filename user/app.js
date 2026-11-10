// OpenAGW 用户端 — 与管理端（m3/）同一套 Material Web 组件与设计令牌
const MW_OK = await import('/user/mw-v2.js').then(()=>true).catch(e=>{
  console.error('[MW] 组件库加载失败：', e); return false;
});
(function detectCompat(){
  const miss=[];
  if(!('attachInternals' in HTMLElement.prototype)) miss.push('Element Internals');
  if(!('showModal' in HTMLDialogElement.prototype)) miss.push('<dialog>');
  if(!customElements.get('md-filled-button')) miss.push('组件库未加载');
  if(miss.length){
    const b=document.getElementById('compatBar');
    b.textContent='当前浏览器缺少 '+miss.join(' / ')+'，页面组件可能失效。请使用 Chrome 90+ / Safari 16.4+ / Firefox 143+ 打开。';
    b.classList.add('show');
  }
})();

// ============ 工具 ============
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const escAttr = s => esc(s).replace(/\s/g,' ');
const fmtNum = n => (n==null||isNaN(Number(n))) ? '-' : Number(n).toLocaleString();
function snack(msg, isErr=false){
  const el=$('#snackbar'); el.textContent=msg;
  el.classList.toggle('err', !!isErr); el.classList.add('show');
  clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.remove('show'), isErr?4000:2000);
}
const reducedMotion = () => { try{ return matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(_){ return false; } };
const SEL_LABEL_CSS='#label{display:block;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
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

// ============ 主题（与管理端共用 agw-theme） ============
const SWATCHES=['#6750A4','#005AC1','#006C7C','#006E1C','#9A1E78','#9C4146','#8E4D00','#3B5BA5'];
let themeState={mode:'dark',seed:'#6750A4'};
function hexToHSL(hex){hex=hex.replace('#','');const r=parseInt(hex.substr(0,2),16)/255,g=parseInt(hex.substr(2,2),16)/255,b=parseInt(hex.substr(4,2),16)/255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);let h,s,l=(mx+mn)/2;if(mx===mn){h=s=0;}else{const d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);switch(mx){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}h/=6;}return{h:Math.round(h*360),s:Math.round(s*100),l:Math.round(l*100)};}
function hslToHex(h,s,l){s/=100;l/=100;const a=s*Math.min(l,1-l);const f=n=>{const k=(n+h/30)%12;const c=l-a*Math.max(-1,Math.min(k-3,9-k,1));return Math.round(255*c).toString(16).padStart(2,'0');};return'#'+f(0)+f(8)+f(4);}
function applyTheme(t){
  themeState={mode:t.mode||'dark',seed:t.seed||'#6750A4'};
  const el=document.documentElement; el.dataset.theme=themeState.mode; el.style.colorScheme=themeState.mode;
  const hsl=hexToHSL(themeState.seed), isDark=themeState.mode!=='light';
  const set=(k,v)=>el.style.setProperty(k,v);
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
function applySeed(hex){
  applyTheme({mode:themeState.mode, seed:hex}); saveTheme();
  const cu=$('#th-custom'); if(cu) cu.value=hex;
  const sw=$('#th-swatches'); if(sw) sw.querySelectorAll('.th-swatch').forEach(s=>s.style.borderColor='transparent');
}
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
      if(c.s<12 || c.l<12 || c.l>92) continue;
      const k=Math.round(c.h/12);
      const b=buckets.get(k)||{n:0,h:0,s:0,l:0};
      b.n++; b.h+=c.h; b.s+=c.s; b.l+=c.l; buckets.set(k,b);
    }
    let best=null;
    for(const b of buckets.values()){
      const w=b.n*(b.s/b.n)*(1-Math.abs(b.l/b.n-55)/55);
      if(!best||w>best.w) best={w,b};
    }
    if(!best) return '#6750A4';
    const b=best.b, h=Math.round(b.h/b.n);
    const s=Math.min(100,Math.round(b.s/b.n*1.15));
    const l=Math.round(b.l/b.n);
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
function openThemeDialog(){
  openDialog('主题',`<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
    <label style="display:flex;align-items:center;gap:4px"><md-switch id="th-dark" ${themeState.mode==='dark'?'selected':''}></md-switch><span style="font-size:11px">深色主题</span></label>
    <div><div style="font-size:10px;color:var(--md-sys-color-on-surface-variant);margin-bottom:8px">主色（Material You）</div>
    <div id="th-swatches" style="display:flex;gap:4px;flex-wrap:wrap"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-top:8px"><button type="button" class="btn sm outline" id="th-mdu">从壁纸取色</button><input type="color" id="th-custom" value="${themeState.seed}" style="width:32px;height:29px;border:none;border-radius:8px;cursor:pointer;background:none"><span style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">自定义颜色</span></div></div>
  </div>`,{okText:'完成',cancel:false});
  const sw=$('#th-swatches');if(sw)sw.innerHTML=SWATCHES.map(c=>`<button type="button" class="th-swatch" data-c="${c}" style="width:29px;height:29px;border-radius:50%;border:2px solid ${c===themeState.seed?'var(--md-sys-color-on-surface)':'transparent'};background:${c};cursor:pointer;padding:0"></button>`).join('');
  const dk=$('#th-dark');if(dk)dk.addEventListener('click',()=>setTimeout(()=>{applyTheme({mode:dk.selected?'dark':'light',seed:themeState.seed});saveTheme();},0));
  if(sw)sw.addEventListener('click',e=>{const b=e.target.closest('.th-swatch');if(b){applyTheme({mode:themeState.mode,seed:b.dataset.c});saveTheme();sw.querySelectorAll('.th-swatch').forEach(s=>s.style.borderColor=s.dataset.c===themeState.seed?'var(--md-sys-color-on-surface)':'transparent');}});
  const cu=$('#th-custom');if(cu)cu.addEventListener('input',e=>{applyTheme({mode:themeState.mode,seed:e.target.value});saveTheme();});
  const mduBtn=$('#th-mdu');
  if(mduBtn) mduBtn.addEventListener('click',()=>pickWallpaperColor(mduBtn));
}

// ============ 动态背景（与管理端共用 agw-bg） ============
const BG_KEY='agw-bg';
let bgDraft=null, bgCleared=false;
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
  g.fillStyle='#141218'; g.fillRect(0,0,c.width,c.height);
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

// ============ 对话框 ============
const DLG_CLOSE_MS=180;
let dlgOnOk=null, dlgCloseT=0;
function openDlg(){
  const ov=$('#dlgOverlay'); if(!ov) return;
  clearTimeout(dlgCloseT);
  ov.classList.remove('closing');
  ov.hidden=false;
}
function closeDlg(){
  const ov=$('#dlgOverlay'); if(!ov||ov.hidden) return;
  if(reducedMotion()){ ov.hidden=true; return; }
  ov.classList.add('closing');
  dlgCloseT=setTimeout(()=>{ ov.classList.remove('closing'); ov.hidden=true; }, DLG_CLOSE_MS);
}
function openDialog(title, bodyHtml, {okText='确定', cancel=true, onOk=null}={}){
  dlgOnOk=onOk;
  $('#dlgTitle').textContent=title;
  $('#dlgBody').innerHTML=bodyHtml;
  $('#dlgOk').textContent=okText;
  $('#dlgCancel').hidden=!cancel;
  openDlg();
  setTimeout(()=>{ try{ $('#dlgBody').querySelector('md-outlined-text-field,md-outlined-select')?.focus?.(); }catch(_){} },120);
}
const dlgValue = () => { const o={}; $$('#dlgBody [data-f]').forEach(el=>o[el.dataset.f]=el.value); return o; };
$('#dlgX').addEventListener('click',closeDlg);
$('#dlgCancel').addEventListener('click',closeDlg);
$('#dlgOverlay').addEventListener('click',e=>{ if(e.target===e.currentTarget) closeDlg(); });
$('#dlgOk').addEventListener('click',async ()=>{
  if(!dlgOnOk){ closeDlg(); return; }
  const r=await dlgOnOk();
  if(r!==false) closeDlg();
});
document.body.addEventListener('change', async e=>{
  if(!e.target||e.target.id!=='bgFile') return;
  const f=e.target.files&&e.target.files[0]; if(!f) return;
  const hint=$('#bgFileHint');
  if(hint) hint.textContent='正在处理图片…';
  try{
    bgDraft=await bgPrepareImage(f);
    bgCleared=false;
    bgSyncPreview();
    const sel=$('#dlgBody md-outlined-select'); if(sel){ sel.value='img'; patchSelect(sel); }
  }catch(err){ snack(err.message||'图片处理失败',true); bgSyncPreview(); }
  try{ e.target.value=''; }catch(_){}
});

// ============ 侧边栏 ============
const VIEWS=[
  {id:'home',    label:'首页',     icon:'home'},
  {id:'card',    label:'卡密管理', icon:'confirmation_number'},
  {id:'models',  label:'模型列表', icon:'view_module'},
  {id:'announce',label:'公告',     icon:'campaign'},
  {id:'profile', label:'用户资料', icon:'person'},
];
const TITLES={home:'首页',card:'卡密管理',models:'模型列表',announce:'公告',profile:'用户资料'};
const Store={ page:'home', me:null, inst:'', online:navigator.onLine };
function buildNav(){
  $('#railList').innerHTML = VIEWS.map(v=>
    `<button type="button" class="rail-item" data-page="${v.id}" title="${escAttr(v.label)}" ${v.id===Store.page?'active':''}>
       <span class="msym" aria-hidden="true">${v.icon}</span><span class="lbl">${v.label}</span>
     </button>`).join('') + '<span class="rail-glider" id="railGlider" aria-hidden="true"></span>';
}
function syncNav(instant){
  $$('#railList .rail-item').forEach(el=>el.toggleAttribute('active', el.dataset.page===Store.page));
  const g=$('#railGlider'); if(!g) return;
  const act=$('#railList .rail-item[active]');
  if(!act){ g.style.opacity='0'; return; }
  if(instant) g.style.transition='none';
  g.style.transform=`translateY(${act.offsetTop}px)`;
  g.style.opacity='1';
  if(instant){ void g.offsetWidth; g.style.transition=''; }
}
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
const TITLE_OUT_MS=130, TITLE_IN_MS=190, PAGE_PUSH_MS=280;
let titleT=0, navSeq=0;
const waitMs = ms => new Promise(r=>setTimeout(r,ms));
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
function viewIdx(id){ return VIEWS.findIndex(v=>v.id===id); }
function clearPageFx(el){ if(!el) return; el.classList.remove('push','out','in','rev'); }
function hidePageEl(el){ if(!el) return; clearPageFx(el); el.hidden=true; el.classList.add('hidden'); }
function showPageEl(el){ if(!el) return; clearPageFx(el); el.hidden=false; el.classList.remove('hidden'); }
async function go(page){
  if(!VIEWS.some(v=>v.id===page)) return;
  const seq=++navSeq;
  const prev=Store.page, prevEl=$(`#page-${prev}`), nextEl=$(`#page-${page}`);
  const same=prev===page, main=$('#main');
  Store.page=page;
  syncNav();
  if(!same && prevEl && nextEl && !prevEl.hidden && !reducedMotion()){
    const fwd=viewIdx(page)>viewIdx(prev);
    setPageTitle(TITLES[page]||page, fwd);
    if(main) main.scrollTop=0;
    $$('.page.push').forEach(p=>{ if(p!==prevEl && p!==nextEl) hidePageEl(p); });
    clearPageFx(prevEl); clearPageFx(nextEl);
    prevEl.classList.add('push','out', ...(fwd?[]:['rev']));
    nextEl.hidden=false; nextEl.classList.remove('hidden');
    nextEl.classList.add('push','in', ...(fwd?[]:['rev']));
    await waitMs(PAGE_PUSH_MS);
    if(seq!==navSeq) return;
    hidePageEl(prevEl);
    clearPageFx(nextEl);
  }else{
    $$('.page').forEach(p=>{ if(p!==nextEl) hidePageEl(p); });
    setPageTitle(TITLES[page]||page, viewIdx(page)>=viewIdx(prev));
    if(!same && main) main.scrollTop=0;
    showPageEl(nextEl);
  }
  const R={home:renderHome,card:renderCard,models:renderModels,announce:renderAnnounce,profile:renderProfile};
  await R[page]?.();
}

// ============ 数据 ============
const KEY_STORE='agw-user-key';
let cardKey='';
async function api(path, signal){
  const r=await fetch(path, { headers:{ Authorization:'Bearer '+cardKey }, signal });
  let j=null;
  try{ j=await r.json(); }catch(_){}
  if(!r.ok) throw new Error((j && j.error && (j.error.message || j.error)) || ('HTTP '+r.status));
  return j;
}
const instBase = () => (Store.inst && Store.inst!=='default' ? '/'+encodeURIComponent(Store.inst) : '');
function chipsHtml(list, emptyText){
  return (list && list.length) ? list.map(x=>`<span class="chip" title="${escAttr(x)}">${esc(x)}</span>`).join('') : `<span class="muted small">${emptyText}</span>`;
}
function quotaPct(me){
  return (!me.unlimited && me.quotaTokens>0) ? Math.min(100, Math.round((me.usedTokens||0)/me.quotaTokens*100)) : 0;
}

// ============ 渲染：首页 ============
async function renderHome(){
  const me=Store.me; if(!me) return;
  $('#ov-cardName').textContent=me.name || '（未命名卡）';
  $('#ov-cardRole').textContent=me.role==='admin' ? '管理员卡' : '用户卡';
  const lines=[
    `总额度 <b>${me.unlimited?'不限':fmtNum(me.quotaTokens)+' tokens'}</b>`,
    `已用 <b>${fmtNum(me.usedTokens)}</b> · 剩余 <b>${me.remainingTokens!=null?fmtNum(me.remainingTokens):'-'}</b>`,
    `有效期至 <b>${esc(me.expiresAt||'长期有效')}</b>`,
  ];
  $('#ov-cardLines').innerHTML=`<div>${lines.join('</div><div>')}</div>`;
  const pct=quotaPct(me);
  $('#ov-quotaBar').style.width=pct+'%';
  $('#ov-quotaText').textContent=me.unlimited?'不限额度':(fmtNum(me.usedTokens)+' / '+fmtNum(me.quotaTokens)+' tokens');
  $('#ov-quotaPct').textContent=me.unlimited?'':(pct+'%');
  renderInstSel(me);
  renderAnnPreview();
}
function renderInstSel(me){
  const sel=$('#instSel'); if(!sel) return;
  const bs=me.branches||[];
  if(bs.length<2){ sel.style.display='none'; $('#md-instNote').textContent='当前实例：'+(bs[0]||'default'); Store.inst=bs[0]||'default'; return; }
  sel.style.display='';
  $('#md-instNote').textContent='可切换有权访问的实例';
  if(!Store.inst || !bs.includes(Store.inst)) Store.inst=bs[0]||'default';
  const sig=bs.join('');
  if(sel.dataset.sig!==sig){
    sel.dataset.sig=sig;
    sel.innerHTML=bs.map(b=>`<md-select-option value="${escAttr(b)}" ${b===Store.inst?'selected':''}>${esc(b)}</md-select-option>`).join('');
    sel.updateComplete.then(()=>{ sel.value=Store.inst; patchSelect(sel); }).catch(()=>{});
  }else sel.value=Store.inst;
}
// 模型列表：/v1/models 返回 {data:[{id, ...}]}，按模型 id 的「渠道/提供商/名称」三段式归类。
// 网关的模型引用约定是 instance:channel:model（同名冲突才带前缀），所以按 owner/owned_by/渠道
// 字段优先，退回按 id 形态分组；每种渠道一张分组卡片，组内按名称排序。
let mdGroups=[];
async function renderModels(){
  const box=$('#md-groups'); if(!box) return;
  box.innerHTML='<div class="empty" style="padding:12px 8px">正在加载…</div>';
  try{
    const j=await api(instBase()+'/v1/models');
    const list=((j&&j.data)||[]);
    const groups=new Map();
    for(const m of list){
      const id=String(m.id||'');
      const ch=String(m.owned_by||m.owner||'').trim();
      const key=ch||'default';
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(id);
    }
    mdGroups=[...groups.entries()].map(([ch,ids])=>({ch,ids:ids.sort((a,b)=>a.localeCompare(b))}))
      .sort((a,b)=>a.ch.localeCompare(b.ch));
    if(!mdGroups.length){ box.innerHTML='<div class="empty">当前实例没有可用模型</div>'; return; }
    box.innerHTML='<div class="md-chips">'+mdGroups.map((g,i)=>
      `<button type="button" class="md-chip" data-action="mdGroup" data-name="${i}" title="${escAttr(g.ch)}（${g.ids.length} 个模型）">`+
      `<span class="md-chip-nm">${esc(g.ch)}</span><span class="md-chip-cnt">${g.ids.length}</span></button>`).join('')+'</div>'
      +'<div id="md-detail" style="margin-top:8px"><div class="empty">选择一个渠道查看其模型</div></div>';
  }catch(e){ box.innerHTML=`<div class="empty">加载失败：${esc(e.message)}</div>`; }
}
function openModelGroup(i){
  const g=mdGroups[i]; if(!g) return;
  const d=$('#md-detail'); if(!d) return;
  $$('#md-groups .md-chip').forEach((el,idx)=>el.classList.toggle('on', idx===i));
  d.innerHTML=`<div class="md-detail-head"><span class="nm">${esc(g.ch)}</span><span class="cnt">${g.ids.length} 个模型</span></div>`
    +`<div class="chips" style="margin-top:6px">${g.ids.map(m=>`<span class="chip" title="${escAttr(m)}">${esc(m)}</span>`).join('')}</div>`;
}

// ============ 公告 ============
let anItems=[];
function fmtAt(t){ try{ const d=new Date(Number(t)||t); return isNaN(d)?'':d.toLocaleString(); }catch(_){ return ''; } }
async function loadAnnouncements(){
  try{ const j=await api('/v1/announcements'); anItems=Array.isArray(j.items)?j.items:[]; }
  catch(e){ anItems=[]; }
  return anItems;
}
function anCard(a){
  return `<div class="an-card" data-action="anView" data-name="${escAttr(a.id)}" role="button" tabindex="0" aria-label="查看公告：${escAttr(a.title||'公告')}">
    <div class="an-card-head"><span class="an-title">${esc(a.title||'（无标题）')}</span><span class="an-time">${fmtAt(a.at)}</span></div>
    <div class="an-body">${esc(a.body||'')}</div>
  </div>`;
}
async function renderAnnPreview(){
  const box=$('#ov-ann-list'); if(!box) return;
  await loadAnnouncements();
  const top=anItems.slice(0,3);
  box.innerHTML=top.length?top.map(anCard).join(''):'<div class="empty">暂无公告</div>';
}
async function renderAnnounce(){
  const box=$('#an-list'); if(!box) return;
  box.innerHTML='<div class="empty" style="padding:12px 8px">正在加载…</div>';
  await loadAnnouncements();
  box.innerHTML=anItems.length?anItems.map(anCard).join(''):'<div class="empty">暂无公告</div>';
}
function openAnnounceView(a){
  if(!a) return;
  openDialog(a.title||'公告', `<div class="an-detail">
    <div class="an-detail-meta">${fmtAt(a.at)}</div>
    <div class="an-detail-body">${esc(a.body||'（无内容）')}</div>
  </div>`, {okText:'关闭', cancel:false});
}

// ============ 渲染：卡密管理 ============
async function renderCard(){
  const me=Store.me; if(!me) return;
  $('#cd-quota').textContent=me.unlimited?'不限':fmtNum(me.quotaTokens);
  $('#cd-used').textContent=fmtNum(me.usedTokens);
  $('#cd-remain').textContent=me.unlimited?'不限':(me.remainingTokens!=null?fmtNum(me.remainingTokens):'-');
  const pct=quotaPct(me);
  $('#cd-quotaBar').style.width=pct+'%';
  $('#cd-quotaText').textContent=me.unlimited?'不限额度':(fmtNum(me.usedTokens)+' / '+fmtNum(me.quotaTokens)+' tokens');
  $('#cd-quotaPct').textContent=me.unlimited?'':(pct+'%');
  $('#cd-expire').textContent=me.expiresAt||'长期有效';
  $('#cd-rpm').textContent=me.rpm?fmtNum(me.rpm)+' 次/分钟':'不限';
  $('#cd-tpm').textContent=me.tpm?fmtNum(me.tpm)+' tokens/分钟':'不限';
  $('#cd-branches').innerHTML=chipsHtml(me.branches, '仅当前实例');
  $('#cd-channels').innerHTML=chipsHtml(me.channels, '全部提供商');
  $('#cd-models').innerHTML=chipsHtml(me.models, '全部模型');
  await renderBalance();
}
async function renderBalance(){
  $('#cd-balance').textContent='查询中…'; $('#cd-balanceCh').textContent='';
  try{
    const j=await api(instBase()+'/v1/credits');
    let v=j.total_remain!=null?j.total_remain:(j.balance!=null?j.balance:null);
    let unit=j.unit||'';
// 基准币种合计取不到（没有对应汇率）时退回按币种的合计，卡片不留在空白状态
    if(v==null && j.totals_by_unit){
      const parts=Object.keys(j.totals_by_unit).map(u=>j.totals_by_unit[u]+(u?' '+u:''));
      if(parts.length){ v=parts.join(' · '); unit=''; }
    }
    $('#cd-balance').textContent=v!=null?(v+(unit?' '+unit:'')):'-';
    const okCh=(j.channels||[]).filter(c=>c.ok).map(c=>c.channel);
    const stale=!!(j.stale || (j.stale_channels&&j.stale_channels.length));
    $('#cd-balanceCh').textContent=(j.aggregate?('渠道：'+(okCh.join('、')||'查询失败')):(j.channel?'渠道：'+j.channel:''))+(stale?'（含上次结果）':'');
  }catch(e){ $('#cd-balance').textContent='-'; $('#cd-balanceCh').textContent=e.message; }
}

// ============ 渲染：用户资料 ============
function renderProfile(){
  const me=Store.me; if(!me) return;
  // 我的资料（可编辑）
  const up=me.userProfile||{};
  const mav=$('#pf-myAvatar');
  if(up.avatar){ mav.src=up.avatar; mav.hidden=false; mav.onerror=()=>{ mav.hidden=true; }; }
  else { mav.hidden=true; mav.removeAttribute('src'); }
  $('#pf-myName').textContent=me.name||'（未命名卡）';
  $('#pf-myRole').textContent=me.role==='admin'?'管理员卡':'用户卡';
  $('#pf-myBio').textContent=up.bio||'尚未填写简介。';
  // 卡密信息（只读）
  $('#pf-name').textContent=me.name||'（未命名卡）';
  $('#pf-role').textContent=me.role==='admin'?'管理员卡':'用户卡';
  $('#pf-uid').textContent=me.uid||'-';
  $('#pf-branches').textContent=(me.branches||[]).join('、')||'仅当前实例';
  $('#pf-channels').textContent=(me.channels||[]).join('、')||'全部提供商';
  $('#pf-models').textContent=(me.models||[]).join('、')||'全部模型';
  const ap=me.admin||{};
  const av=$('#pf-avatar');
  if(ap.avatar){ av.src=ap.avatar; av.hidden=false; } else { av.hidden=true; av.removeAttribute('src'); }
  $('#pf-adminName').textContent=ap.name||'未设置';
  $('#pf-adminBio').textContent=ap.profile||'管理员尚未填写简介。';
  $('#pf-adminOther').textContent=ap.other||'';
}

// 编辑我的资料：头像 URL（可留空）+ 简介；保存后写回卡对象并刷新本页
function openProfileEdit(){
  const me=Store.me||{}, up=me.userProfile||{};
  openDialog('编辑资料', `<div style="display:flex;flex-direction:column;gap:8px;padding-top:8px">
    <md-outlined-text-field data-f="avatar" label="头像图片地址（https://…，留空为不设置）" value="${escAttr(up.avatar||'')}"></md-outlined-text-field>
    <md-outlined-text-field data-f="bio" label="简介（500 字以内）" type="textarea" rows="3" value="${escAttr(up.bio||'')}"></md-outlined-text-field>
    <div style="font-size:10px;color:var(--md-sys-color-on-surface-variant)">昵称（${esc(me.name||'未命名卡')}）由管理员设定，如需修改请联系管理员。</div>
  </div>`, {okText:'保存', onOk:async()=>{
    const v=dlgValue();
    const avatar=String(v.avatar||'').trim();
    if(avatar && !/^https:\/\//i.test(avatar)){ snack('头像必须是 https:// 开头的图片地址',true); return false; }
    try{
      const r=await fetch('/v1/me/profile',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cardKey},body:JSON.stringify({avatar,bio:String(v.bio||'')})});
      const j=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error((j&&j.error&&(j.error.message||j.error))||('HTTP '+r.status));
      Store.me.userProfile=j.userProfile||{avatar,bio:String(v.bio||'')};
      renderProfile(); snack('资料已保存');
    }catch(e){ snack(e.message,true); return false; }
  }});
}

// ============ 站点品牌（公开，/v1/site）============
// Logo 与简介是站点门面，登录前就该可见，所以走无卡密的公开接口；卡密相关接口仍在登录后才发。
async function loadSite(){
  try{
    const r=await fetch('/v1/site');
    const j=await r.json().catch(()=>({}));
    if(!r.ok) return;
    const name=String(j.name||'').trim(), ver=String(j.ver||'').trim(), logo=String(j.logo||''), intro=String(j.intro||'').trim();
    const bn=$('#brandName'), bv=$('#brandVer');
    if(bn) bn.textContent=name||'OpenAGW';
    if(bv){ bv.textContent=ver||'用户端 · Material Web'; }
    const sn=$('#ov-site-name'), sv=$('#ov-site-ver'), si=$('#ov-site-intro');
    if(sn) sn.textContent=name||'OpenAGW';
    if(sv){ sv.textContent=ver||'用户端 · Material Web'; sv.style.display=ver?'':'none'; }
    if(si) si.innerHTML=(intro?intro.split('\n').map(x=>`<div>${esc(x)}</div>`).join(''):'')||'<div>OpenAI / Claude / Gemini 三方言互转的统一网关；使用管理员分发的卡密调用 <b>/v1</b> 接口，额度与权限按卡计算。</div>';
    ['#railLogo','#topLogo','#ov-site-logo'].forEach(sel=>{
      const img=$(sel); if(!img) return;
      if(logo){ img.src=logo; img.hidden=false; img.onerror=()=>{ img.hidden=true; }; }
      else { img.hidden=true; img.removeAttribute('src'); }
    });
    if(name||ver) document.title=(name||'OpenAGW')+(ver?' · '+ver:' 用户端');
  }catch(_){}
}

// ============ 登录 / 启动 ============
function showLogin(errMsg){
  $('#rail').style.display='none';
  $('.shell').style.display='none';
  if($('#loginOverlay')){ $('#loginOverlay').remove(); }
  const ov=document.createElement('div');
  ov.id='loginOverlay';
  ov.innerHTML=`<div class="login-card">
    <h2>OpenAGW 用户端</h2>
    <div class="sub">使用卡密登录，查看额度、限流与可用模型</div>
    <div class="login-err ${errMsg?'show':''}" id="loginErr">${esc(errMsg||'')}</div>
    <md-outlined-text-field id="loginKey" label="卡密" type="password" placeholder="sk-…" style="width:100%"></md-outlined-text-field>
    <div style="display:flex;justify-content:flex-end;margin-top:12px"><md-filled-button id="loginBtn">登录</md-filled-button></div>
  </div>`;
  document.body.appendChild(ov);
  const doLogin=()=>{
    const k=($('#loginKey').value||'').trim();
    if(!k) return;
    login(k);
  };
  $('#loginBtn').addEventListener('click',doLogin);
  $('#loginKey').addEventListener('keydown',e=>{ if(e.key==='Enter') doLogin(); });
  setTimeout(()=>{ try{ $('#loginKey').focus(); }catch(_){} },120);
}
async function login(key){
  cardKey=key;
  try{
    const me=await api('/v1/me');
    Store.me=me;
    localStorage.setItem(KEY_STORE, key);
    const ov=$('#loginOverlay'); if(ov) ov.remove();
    $('#rail').style.display='';
    $('.shell').style.display='';
    Store.inst='';
    await go(Store.page==='home'?'home':Store.page);
    snack('已登录');
  }catch(e){
    cardKey='';
    localStorage.removeItem(KEY_STORE);
    const err=$('#loginErr');
    if(err){ err.textContent=e.message; err.classList.add('show'); }
  }
}
function logout(){
  localStorage.removeItem(KEY_STORE);
  location.reload();
}
async function refreshMe(){
  try{
    Store.me=await api('/v1/me');
    const R={home:renderHome,card:renderCard,models:renderModels,announce:renderAnnounce,profile:renderProfile};
    await R[Store.page]?.();
    snack('已刷新');
  }catch(e){
    snack(e.message,true);
    if(/401|invalid key/i.test(e.message)) logout();
  }
}

// ============ 事件绑定与启动 ============
$('#railToggle').addEventListener('click',()=>setRail(!railOpen()));
$('#railScrim').addEventListener('click',()=>setRail(false));
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&railOpen()) setRail(false); });
$('#thBtn').addEventListener('click',openThemeDialog);
$('#bgBtn').addEventListener('click',openBgDialog);
$('#logoutBtn').addEventListener('click',logout);
$('#refreshBtn').addEventListener('click',refreshMe);
$('#instSel').addEventListener('change',e=>{ Store.inst=e.target.value; if(Store.page==='models') renderModels(); });
$('#bal-refresh').addEventListener('click',renderBalance);
$('#pf-edit').addEventListener('click',openProfileEdit);
$('#railList').addEventListener('click',e=>{
  const nav=e.target.closest('[data-page]');
  if(nav){ go(nav.dataset.page); setRail(false); }
});
document.body.addEventListener('click',e=>{
  const jump=e.target.closest('[data-goto]');
  if(jump){ go(jump.dataset.goto); return; }
  const act=e.target.closest('[data-action]');
  if(!act) return;
  const a=act.dataset.action, n=act.dataset.name;
  if(a==='mdGroup'){ openModelGroup(+n); }
  else if(a==='anView'){ openAnnounceView(anItems.find(x=>x.id===n)); }
});
document.body.addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ') return;
  const act=e.target.closest('[data-action]');
  if(!act) return;
  e.preventDefault();
  const a=act.dataset.action, n=act.dataset.name;
  if(a==='mdGroup'){ openModelGroup(+n); }
  else if(a==='anView'){ openAnnounceView(anItems.find(x=>x.id===n)); }
});
window.addEventListener('online',()=>{ Store.online=true; });
window.addEventListener('offline',()=>{ Store.online=false; snack('网络已断开',true); });

loadTheme();
applyBg();
try{ setRail(localStorage.getItem('agw-rail')==='open', false); }catch(_){ setRail(false, false); }
buildNav();
syncNav(true);
if(!MW_OK){ /* 组件缺失时 compatBar 已提示，页面结构仍可查看 */ }
loadSite();
const saved=localStorage.getItem(KEY_STORE)||'';
if(saved) login(saved); else showLogin();
console.log('[OpenAGW] 用户端已初始化 · 组件库', MW_OK?'就绪':'缺失');
