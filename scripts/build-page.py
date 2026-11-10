"""Builds public/index.html from the artifact page: same map, but the data comes from /api/graph
and declarations go to /api/connections. Run: python3 scripts/build-page.py <artifact.html>"""
import sys,re
src=open(sys.argv[1],encoding='utf-8').read()
def rep(old,new,count=1):
    global src
    assert src.count(old)==count,('anchor count %d: '%src.count(old))+old[:90]
    src=src.replace(old,new)
# data source: the API instead of the artifact store
start_old=src[src.index('  async function start(){'):src.index('  refreshAll();\n  start();')]
start_new='''  async function start(){
    setStatus('live','Live');dbRef={api:true};
    timer=setTimeout(()=>{if(!booted){setStatus('','Waiting for data');$('empty').hidden=false;$('empty-t').textContent='The store is not answering yet';$('empty-s').textContent='Keep the page open; it fills in when the connection comes back.'}},10000);
    let since='';
    async function poll(){
      try{
        const r=await fetch('/api/graph'+(since?'?since='+encodeURIComponent(since):''),{cache:'no-store'});
        if(!r.ok)throw new Error('HTTP '+r.status);
        const g=await r.json();
        (g.people||[]).forEach(d=>pendingP.push(d));(g.edges||[]).forEach(d=>pendingE.push(d));
        (g.connections||[]).forEach(d=>{if(d.status!=='rejected')pendingC.push(d)});
        since=g.now||since;gotP=true;gotE=true;setStatus('live','Live');queueIngest();
      }catch(e){setStatus('','Disconnected')}
    }
    await poll();setInterval(poll,120000);
  }
'''
src=src.replace(start_old,start_new)
# declarations go to the API
rep("    await dbRef.collection('connections').doc(meId+'__'+other).set({from:meId,to:other,status:'pending',addedAt:new Date().toISOString(),by:viewerId||'',note:''});\n    b.textContent='Declared · awaiting validation';\n  }catch(err){b.disabled=false;b.textContent=err&&err.code==='not_granted'?'Sign in to declare a connection':'Could not send, try again'}",
    "    const r=await fetch('/api/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from:meId,to:other})});\n    const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'HTTP '+r.status);\n    addRaw('connections',{a:meId,b:other,kind:'knows',label:'Declared, awaiting validation',url:'',confidence:.35,addedAt:new Date().toISOString(),at:performance.now(),status:'pending'});\n    b.textContent='Declared · awaiting validation';\n  }catch(err){b.disabled=false;b.textContent=String(err.message||'').indexOf('limit')>=0?'Daily limit reached':'Could not send, try again'}")
rep("know.textContent=r?(r.status==='confirmed'?'Connection confirmed':'Declared · awaiting validation'):(dbRef?'I know this person':'Sign in to declare a connection');",
    "know.textContent=r?(r.status==='confirmed'?'Connection confirmed':'Declared · awaiting validation'):'I know this person';")
# the chat runs on the server's key: the page keeps the tool loop, the server owns prompt, model and limits
rep("    try{if(window.claude&&window.claude.use)sampleFn=await window.claude.use('sample')}catch(e){sampleFn=null}\n    if(!sampleFn)return;\n    try{const l=await sampleFn.limits();canTools=!!(l&&l.tools)}catch(e){canTools=false}",
    """    try{const st=await (await fetch('/api/ask/status',{cache:'no-store'})).json();if(!st.enabled)return}catch(e){return}
    sampleFn=apiSample;canTools=true;""")
rep("  function copyFor(c){return ","  function copyFor(c){if(c==='daily_limit')return 'You have used today\\'s questions. Come back tomorrow.';if(c==='global_limit')return 'The chat has reached its limit for today. Come back tomorrow.';if(c==='unavailable')return 'The chat is not available right now. Try again later.';if(c==='expired')return 'That question took too long. Ask it again.';return ")
rep("  async function ask(q){",
"""  /* history[0] holds the page's rules; the server has its own, so only the conversation goes up */
  async function apiSample(history,opts){
    const signal=opts&&opts.signal;
    const msgs=history.slice(1).map(t=>({role:t.role,content:t.content}));
    let token='';
    for(let step=0;step<5;step++){
      let r;
      try{r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:msgs,token:token||undefined}),signal})}
      catch(e){const er=new Error('stopped');er.code=e&&e.name==='AbortError'?'cancelled':'unavailable';throw er}
      const j=await r.json().catch(()=>({}));
      if(!r.ok){const er=new Error(j.error||'');er.code=j.code||(r.status===400&&token?'expired':'unavailable');throw er}
      token=j.token||token;
      const blocks=Array.isArray(j.content)?j.content:[];
      const uses=blocks.filter(b=>b.type==='tool_use');
      const text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('').trim();
      if(j.stop_reason!=='tool_use'||!uses.length)return {text:text||'No answer came back. Try rephrasing.'};
      if(text&&opts&&opts.onText)opts.onText({text:text});
      msgs.push({role:'assistant',content:blocks});
      msgs.push({role:'user',content:uses.map(u=>{let out;try{out=TOOLS[0].execute(u.input||{})}catch(e){out={error:String(e&&e.message||e)}}return {type:'tool_result',tool_use_id:u.id,content:JSON.stringify(out).slice(0,15000)}})});
    }
    return {text:'That search needed too many steps. Try a narrower question.'};
  }
  async function ask(q){""")
# three.js served from this app, not a CDN
rep('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js','/vendor/three.min.js')
# read-only hook so the submission form knows who is selected
rep('let sel=-1,hov=-1,nbr=null,hl=null;','let sel=-1,hov=-1,nbr=null,hl=null;\nwindow.synapseSelected=()=>(sel>=0&&G.nodes[sel]&&!G.nodes[sel].hub)?{id:G.nodes[sel].id,name:G.nodes[sel].name,headline:G.nodes[sel].headline}:null;')
# hooks for the CSV import: who "me" is, the people on the map, and a call when a card renders
rep("let meId='';try{meId=localStorage.getItem('synapse.me')||''}catch(e){}","let meId='';try{meId=localStorage.getItem('synapse.me')||''}catch(e){}\nwindow.synapseMe=()=>meId;\nwindow.synapseSystems=()=>{const o=new Set();for(let i=0;i<G.n;i++){const n=G.nodes[i];if(!n.hub&&n.systems)n.systems.forEach(x=>o.add(x.name))}return [...o].sort()};\nwindow.synapseFocus=id=>{const i=G.idx.get(id);if(i==null)return false;select(i,true);return true};\nwindow.synapseSetMe=id=>{meId=id||'';if(sel>=0)renderDetail()};\nwindow.synapsePeople=()=>{const o=[];for(let i=0;i<G.n;i++){const n=G.nodes[i];if(!n.hub)o.push({id:n.id,name:n.name,org:n.org||''})}return o};")
rep("  $('d-me').setAttribute('aria-pressed',String(n.id===meId));$('d-me').textContent=n.id===meId?'you':'this is me';","  $('d-me').setAttribute('aria-pressed',String(n.id===meId));$('d-me').textContent=n.id===meId?'you':'this is me';\n  if(window.synapseOnDetail)window.synapseOnDetail(n.id);document.dispatchEvent(new CustomEvent('synapse:detail',{detail:n.id}));")
# D3: suggest-a-change entry on the person card, hidden on topic and system cards
rep('        <div class="d-src" id="d-src"></div>\n        <button class="d-more" id="d-more" type="button" aria-expanded="false"></button>',
    '        <div class="d-src" id="d-src"></div>\n        <button class="d-import" id="d-import" type="button" hidden>Add my LinkedIn connections (CSV)</button>\n        <button class="d-edit" id="d-edit" type="button">Suggest a correction, add a link, or ask for removal</button>\n        <button class="d-more" id="d-more" type="button" aria-expanded="false"></button>')
rep("  if(n.hub){renderHubDetail(n);return}","  $('d-edit').hidden=!!n.hub;$('d-import').hidden=true;\n  if(n.hub){renderHubDetail(n);document.dispatchEvent(new CustomEvent('synapse:hub',{detail:{kind:n.hub,name:n.name}}));return}")
import os
extra=open(os.path.join(os.path.dirname(__file__),'page-extra.html'),encoding='utf-8').read()+'\n'+open(os.path.join(os.path.dirname(__file__),'page-import.html'),encoding='utf-8').read()+'\n'+open(os.path.join(os.path.dirname(__file__),'page-claim.html'),encoding='utf-8').read()+'\n'+open(os.path.join(os.path.dirname(__file__),'page-card.html'),encoding='utf-8').read()+'\n'+open(os.path.join(os.path.dirname(__file__),'page-help.html'),encoding='utf-8').read()
# standalone document: the artifact tool used to add the skeleton
head='''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Who appears with whom in treasury, from public sources: a 3D map of treasury and finance professionals, their topics and the systems they use, sell or implement.">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://synapse.k-phi.com/">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#080b17">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Synapse">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 28 28%27%3E%3Cpath d=%27M7 8l7 13M21 7l-7 14M7 8l14-1%27 stroke=%27%236ee7f0%27 stroke-width=%271.4%27 fill=%27none%27/%3E%3Ccircle cx=%277%27 cy=%278%27 r=%272.6%27 fill=%27%236ee7f0%27/%3E%3Ccircle cx=%2721%27 cy=%277%27 r=%272.6%27 fill=%27%23c084fc%27/%3E%3Ccircle cx=%2714%27 cy=%2721%27 r=%272.6%27 fill=%27%23fda4af%27/%3E%3C/svg%3E">
<style>:root{color-scheme:dark;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
'''
sw='<script>if("serviceWorker" in navigator)addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));</script>'
open('public/index.html','w',encoding='utf-8').write(head+src+'\n'+extra+'\n'+sw+'\n</body>\n</html>\n')
js=re.findall(r'<script>(.*?)</script>',src,re.S)[-1]
open('/tmp/synapse-page.js','w').write(js)
print('built public/index.html',len(src)//1024,'KB')
