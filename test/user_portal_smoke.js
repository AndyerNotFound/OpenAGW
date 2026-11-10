// 冒烟测试：/user 页面、/user/ 静态资源、/v1/me 扩展字段（channels/admin）
'use strict';
const http=require('http'), fs=require('fs'), os=require('os'), path=require('path');
const G = require('../gateway.js');
const surface = require('./_surface');

let pass=0, fail=0;
const t=(name,ok,extra)=>{ if(ok){pass++;console.log('  ✓',name);} else {fail++;console.log('  ✗',name,extra||'');} };
function get(port,p,key){return new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port,path:p,headers:key?{Authorization:'Bearer '+key}:{}},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>res({s:x.statusCode,ct:String(x.headers['content-type']||''),b}))});r.on('error',rej);r.end();});}

(async()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'agw-ui-'));
  const cfgFile = path.join(dir,'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen:{host:'127.0.0.1',port:0},
    panel:{openBrowser:false}, modelSync:{enable:false}, probe:{enable:false},
    channels:[{name:'up',type:'openai',baseUrl:'http://127.0.0.1:9',apiKey:'x',models:['m'],default:true}],
    apiKeys:[{key:'sk-ui',name:'演示卡',role:'user',quotaTokens:1000,usedTokens:120,channels:['up'],models:['m']}],
    adminProfile:{name:'管理员A',avatar:'',profile:'负责发卡',other:'contact: a@b.c'}
  }));
  const cfg = G.loadConfig(cfgFile);
  surface.set(cfg);
  const started = await G.startServer(cfg, { host:'127.0.0.1', port:0, multi:false });
  const port = started.port;

  const idx=await get(port,'/user');
  t('GET /user 200 text/html', idx.s===200 && idx.ct.includes('text/html'), idx.s+' '+idx.ct);
  t('index 引用 app.css', idx.b.includes('app.css'));
  t('index 引用 app.js', idx.b.includes('app.js'));
  const css=await get(port,'/user/app.css');
  t('GET /user/app.css 200 text/css', css.s===200 && css.ct.includes('text/css'), css.s+' '+css.ct);
  const js=await get(port,'/user/app.js');
  t('GET /user/app.js 200 js', js.s===200 && js.ct.includes('javascript'), js.s+' '+js.ct);
  const font=await get(port,'/user/material-symbols-outlined.woff2');
  t('GET /user/...woff2 200 font', font.s===200 && font.ct.includes('font'), font.s+' '+font.ct);
  const bad=await get(port,'/user/../server.js');
  t('GET /user/../server.js 拦截', bad.s===404 || bad.s===400, bad.s);
  const bad2=await get(port,'/user/%2e%2e/server.js');
  t('GET /user/%2e%2e/server.js 拦截', bad2.s===404 || bad2.s===400, bad2.s);
  const bad3=await get(port,'/user/server.js');
  t('GET /user/server.js 404(扩展名不在白名单)', bad3.s===404, bad3.s);
  const me401=await get(port,'/v1/me');
  t('/v1/me 无卡 401', me401.s===401, me401.s);
  const me=await get(port,'/v1/me','sk-ui');
  t('/v1/me 200', me.s===200, me.s);
  const j=JSON.parse(me.b);
  t('me.name=演示卡', j.name==='演示卡', j.name);
  t('me.role=user', j.role==='user');
  t('me.channels=[up]', Array.isArray(j.channels) && j.channels.join()==='up', JSON.stringify(j.channels));
  t('me.models=[m]', Array.isArray(j.models) && j.models.join()==='m');
  t('me.admin.name=管理员A', j.admin && j.admin.name==='管理员A', JSON.stringify(j.admin));
  t('me.admin.profile', j.admin && j.admin.profile==='负责发卡');
  t('me.admin.other', j.admin && j.admin.other==='contact: a@b.c');
  t('me.quotaTokens=1000', j.quotaTokens===1000);
  t('me.usedTokens=120', j.usedTokens===120);
  t('me.remainingTokens=880', j.remainingTokens===880);
  t('me.branches 含 default', Array.isArray(j.branches) && j.branches.includes('default'), JSON.stringify(j.branches));
  console.log(`\nuser portal: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(2); });
