// 冒烟测试：/user 页面、/user/ 静态资源、/v1/me 扩展字段（channels/admin）
'use strict';
const http=require('http'), fs=require('fs'), os=require('os'), path=require('path');
const G = require('../gateway.js');
const surface = require('./_surface');

let pass=0, fail=0;
const t=(name,ok,extra)=>{ if(ok){pass++;console.log('  ✓',name);} else {fail++;console.log('  ✗',name,extra||'');} };
function post(port,p,key,obj){return new Promise((res,rej)=>{const b=JSON.stringify(obj);const r=http.request({host:'127.0.0.1',port,path:p,method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({s:x.statusCode,b:d}))});r.on('error',rej);r.end(b);});}
function get(port,p,key){return new Promise((res,rej)=>{const r=http.request({host:'127.0.0.1',port,path:p,headers:key?{Authorization:'Bearer '+key}:{}},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>res({s:x.statusCode,ct:String(x.headers['content-type']||''),b}))});r.on('error',rej);r.end();});}

(async()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'agw-ui-'));
  const cfgFile = path.join(dir,'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    listen:{host:'127.0.0.1',port:0},
    panel:{openBrowser:false}, modelSync:{enable:false}, probe:{enable:false},
    channels:[{name:'up',type:'openai',baseUrl:'http://127.0.0.1:9',apiKey:'x',models:['m'],default:true}],
    apiKeys:[{key:'sk-ui',name:'演示卡',role:'user',quotaTokens:1000,usedTokens:120,channels:['up'],models:['m']}],
    adminProfile:{name:'管理员A',avatar:'',profile:'负责发卡',other:'contact: a@b.c'},
    site:{name:'演示网关',ver:'测试版',logo:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',intro:'第一行简介\n第二行简介'}
  }));
  fs.writeFileSync(path.join(dir,'announcements.json'), JSON.stringify({items:[
    {id:'a1',title:'维护通知',body:'本周六凌晨维护',at:1794000000000},
    {id:'a2',title:'新模型上线',body:'新增 kimi-k3-1',at:1794100000000},
  ]}));
  const cfg = G.loadConfig(cfgFile);
  surface.set(cfg);
  const started = await G.startServer(cfg, { host:'127.0.0.1', port:0, multi:false });
  const port = started.port;

  const idx=await get(port,'/user/');
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
  // 公告：持卡可读，无卡 401，倒序
  const an401=await get(port,'/v1/announcements');
  t('/v1/announcements 无卡 401', an401.s===401, an401.s);
  const an=await get(port,'/v1/announcements','sk-ui');
  t('/v1/announcements 200', an.s===200, an.s);
  const aj=JSON.parse(an.b);
  t('公告 2 条', Array.isArray(aj.items) && aj.items.length===2, String(aj.items&&aj.items.length));
  t('公告倒序(新的在前)', aj.items[0].id==='a2', aj.items.map(x=>x.id).join());
  t('公告含标题', aj.items[0].title==='新模型上线');
  // 用户自助资料：GET 默认空、POST 保存、再读生效；非法头像被拒；无卡 401
  t('me.userProfile 默认空', j.userProfile && j.userProfile.avatar==='' && j.userProfile.bio==='', JSON.stringify(j.userProfile));
  const sv=await post(port,'/v1/me/profile','sk-ui',{avatar:'https://example.com/a.png',bio:'你好，我是演示卡'});
  t('POST /v1/me/profile 200', sv.s===200, sv.s+' '+sv.b.slice(0,80));
  const me2=await get(port,'/v1/me','sk-ui');
  const j2=JSON.parse(me2.b);
  t('资料已保存', j2.userProfile && j2.userProfile.avatar==='https://example.com/a.png' && j2.userProfile.bio==='你好，我是演示卡', JSON.stringify(j2.userProfile));
  const badAv=await post(port,'/v1/me/profile','sk-ui',{avatar:'http://insecure/x.png'});
  t('http 头像被拒 400', badAv.s===400, badAv.s);
  const nokey=await post(port,'/v1/me/profile','',{bio:'x'});
  t('无卡写资料 401', nokey.s===401, nokey.s);
  // 落盘确认：config.json 里应出现 userProfile
  const saved=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
  const k=(saved.apiKeys||[]).find(x=>x.key==='sk-ui');
  t('资料写入配置文件', !!(k && k.userProfile && k.userProfile.bio==='你好，我是演示卡'), JSON.stringify(k&&k.userProfile));
  // 站点信息：公开、无需卡密
  const site=await get(port,'/v1/site');
  t('/v1/site 200 公开', site.s===200, site.s);
  const sj=JSON.parse(site.b);
  t('site.name=演示网关', sj.name==='演示网关', sj.name);
  t('site.logo 为 data:image', /^data:image\//.test(sj.logo||''), (sj.logo||'').slice(0,20));
  t('site.intro 两行', (sj.intro||'').includes('第二行'), sj.intro);
  console.log(`\nuser portal: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})().catch(e=>{ console.error(e); process.exit(2); });
