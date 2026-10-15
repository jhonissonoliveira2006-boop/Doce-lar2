const express=require('express'),http=require('http'),path=require('path'),fs=require('fs');
const {WebSocketServer}=require('ws');
const app=express();app.use(express.json({limit:'10kb'}));
// libera o microfone para o próprio site (voz)
app.use((req,res,next)=>{res.setHeader('Permissions-Policy','microphone=(self)');next()});
app.use(express.static(path.join(__dirname,'public')));

/* ============================ PERSISTÊNCIA ============================ */
const FILE=process.env.DATA_FILE||path.join(__dirname,'rooms.json');
const DRAW_FILE=process.env.DRAW_FILE||FILE.replace(/\.json$/,'')+'.draws.json';
let rooms={};
try{rooms=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){}
// desenhos de cada sala; cada carimbo: [x,y,z,nx,ny,nz,raio,cor]
let hist={};
try{hist=JSON.parse(fs.readFileSync(DRAW_FILE,'utf8'))}catch(e){}

const writeAtomic=(f,data)=>{try{fs.writeFileSync(f+'.tmp',data);fs.renameSync(f+'.tmp',f)}catch(e){console.error(e)}};
const saveNow=()=>writeAtomic(FILE,JSON.stringify(rooms));
const saveDrawsNow=()=>writeAtomic(DRAW_FILE,JSON.stringify(hist));
let sT=null,dT=null;
const save=()=>{if(!sT)sT=setTimeout(()=>{sT=null;saveNow()},1500)};            // construções (rápido)
const saveDraws=()=>{if(!dT)dT=setTimeout(()=>{dT=null;saveDrawsNow()},10000)}; // desenhos (mais espaçado)
const bye=()=>{saveNow();saveDrawsNow();process.exit(0)};
process.on('SIGTERM',bye);process.on('SIGINT',bye);
process.on('uncaughtException',e=>console.error('uncaught',e));

/* ============================ UTILITÁRIOS ============================ */
const ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gen=()=>{let s='';for(let i=0;i<6;i++)s+=ALPHA[Math.floor(Math.random()*ALPHA.length)];return s};
const num=(v,a,b)=>Math.max(a,Math.min(b,+v||0));
const r2=v=>Math.round(v*100)/100;
const HEX=/^#[0-9a-fA-F]{6}$/;
const NAME=/^[A-Za-z0-9_-]{1,24}$/;
const send=(w,o)=>{if(w.readyState===1)w.send(typeof o==='string'?o:JSON.stringify(o))};
// envia para toda a sala (menos "except", se informado)
const bcast=(room,o,except)=>{const s=JSON.stringify(o);for(const w of room.values())if(w!==except&&w.readyState===1)w.send(s)};

/* ============================ API HTTP ============================ */
app.post('/api/create',(req,res)=>{
  let c=String((req.body&&req.body.code)||'').toUpperCase();
  if(c){
    if(!/^[A-Z0-9-]{3,16}$/.test(c))return res.status(400).json({err:'Código inválido (3 a 16 letras/números)'});
    if(rooms[c])return res.status(409).json({err:'Esse endereço já existe'});
  }else{do c=gen();while(rooms[c])}
  rooms[c]={created:Date.now(),builds:{},nb:0};saveNow();
  res.json({code:c});
});
app.get('/api/exists/:code',(req,res)=>res.json({ok:!!rooms[String(req.params.code).toUpperCase()]}));

const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws',maxPayload:64*1024});

/* ============================ ESTADO EM MEMÓRIA ============================ */
const live={};          // code -> Map(id -> ws)
let nextId=1;
const MAX_HIST=40000;
const MAX_B=6000;       // máximo de construções por sala
const balls={};         // code -> a ÚNICA bola da sala
const games={};         // code -> { gameId: {seats:[id|null], st} }
const SEATS={pingpong:2}; // vagas por minigame (padrão 2; o cliente pode pedir de 1 a 4 em "n")

/* ============================ CONSTRUÇÕES ============================ */
// Campos: k (tipo), x,y,z (posição), ry (rotação), s (escala), c (cor #rrggbb), p (até 16 números livres)
// add=true exige "k" e preenche padrões; add=false devolve só os campos enviados (atualização parcial)
const bPick=(m,add)=>{
  const o={};
  if(add){const k=String(m.k||'');if(!NAME.test(k))return null;o.k=k}
  const has=f=>add||m[f]!==undefined;
  if(has('x'))o.x=r2(num(m.x,-5000,5000));
  if(has('y'))o.y=r2(num(m.y,-500,500));
  if(has('z'))o.z=r2(num(m.z,-5000,5000));
  if(has('ry'))o.ry=r2(num(m.ry,-1000,1000));
  if(has('s'))o.s=r2(num(m.s===undefined?1:m.s,.05,50));
  if(HEX.test(m.c))o.c=m.c.toLowerCase();else if(add)o.c='#ffffff';
  if(Array.isArray(m.p))o.p=m.p.slice(0,16).map(v=>r2(num(v,-5000,5000)));
  return o;
};
const roomData=code=>{const R=rooms[code];if(!R.builds)R.builds={};if(!R.nb)R.nb=0;return R};

/* ============================ BOLA ÚNICA ============================ */
const pubBall=b=>({k:b.k,x:b.x,y:b.y,z:b.z,vx:b.vx,vy:b.vy,vz:b.vz,h:b.h,own:b.own});
const ballKind=v=>/^[a-z0-9_-]{1,16}$/i.test(v)?String(v).toLowerCase():null;

/* ============================ MINIGAMES ============================ */
const hostOf=G=>G.seats.findIndex(x=>x!=null);
const seatsMsg=(g,G)=>({t:'g',a:'seats',g,seats:G.seats,host:hostOf(G)});
const leaveGame=(code,room,id,gid)=>{
  const gs=games[code];if(!gs||!gs[gid])return;
  const G=gs[gid],i=G.seats.indexOf(id);if(i<0)return;
  G.seats[i]=null;
  if(G.seats.every(x=>x==null))delete gs[gid];
  bcast(room,seatsMsg(gid,G));
};
const okPayload=d=>d!==undefined&&JSON.stringify(d).length<=2000;

/* ============================ CONEXÕES ============================ */
wss.on('connection',(ws,req)=>{
  const code=(new URL(req.url,'http://x').searchParams.get('code')||'').toUpperCase();
  if(!rooms[code]){ws.close(4004,'no room');return}
  const room=live[code]||(live[code]=new Map());
  if(room.size>=20){ws.close(4005,'full');return}
  const id=nextId++;ws.id=id;ws.state=null;ws.alive=true;ws.tok=300;ws.tt=Date.now();
  ws.on('pong',()=>{ws.alive=true});
  ws.on('error',()=>{});
  room.set(id,ws);
  const R=roomData(code);

  // se a bola ficou sem dono, quem entra assume a simulação
  const bl0=balls[code];
  if(bl0&&(!bl0.own||!room.has(bl0.own)||bl0.own===id)){bl0.own=id}

  const gsum={};
  for(const [g,G] of Object.entries(games[code]||{}))gsum[g]={seats:G.seats,host:hostOf(G)};
  send(ws,{t:'hi',id,
    players:[...room.values()].filter(w=>w!==ws&&w.state).map(w=>({id:w.id,...w.state})),
    ball:balls[code]?pubBall(balls[code]):null,
    games:gsum});

  // desenhos que já existem na sala
  const h=hist[code]||[];
  for(let i=0;i<h.length;){
    const c=h[i][7],s=[];let j=i;
    while(j<h.length&&h[j][7]===c&&s.length<1050){for(let k=0;k<7;k++)s.push(h[j][k]);j++}
    send(ws,{t:'d',id:0,c,s});
    i=j;
  }
  // construções que já existem na sala
  const bl=Object.entries(R.builds).map(([bid,o])=>({bid:+bid,...o}));
  for(let i=0;i<bl.length;i+=400)send(ws,{t:'bs',list:bl.slice(i,i+400)});
  send(ws,{t:'bs',list:[],done:1});

  ws.on('message',raw=>{
    // limite de mensagens (~200/s, rajada 300) contra flood
    const now=Date.now();ws.tok=Math.min(300,ws.tok+(now-ws.tt)*.2);ws.tt=now;
    if(ws.tok<1)return;ws.tok--;

    let m;try{m=JSON.parse(raw)}catch{return}
    if(!m||typeof m!=='object')return;

    if(m.t==='s'){
      const s={
        x:+m.x||0,y:+m.y||0,z:+m.z||0,yaw:+m.yaw||0,
        col:HEX.test(m.col)?m.col:'#3f7cff',
        hs:r2(num(m.hs,0,30)),          // velocidade horizontal
        vy:r2(num(m.vy,-40,40)),        // velocidade vertical
        f:(+m.f||0)&127,                // bits: chão, rolando, parede, sentado, mergulho, item, limpando
        rp:r2(num(m.rp,0,1)),           // progresso do rolar
        fp:r2(num(m.fp,0,1))            // progresso do giro no ar
      };
      ws.state=s;
      bcast(room,{t:'s',id,...s},ws);

    }else if(m.t==='d'){
      // lote de carimbos de desenho: 7 números por carimbo (x,y,z,nx,ny,nz,raio) + uma cor
      if(!Array.isArray(m.s)||m.s.length===0||m.s.length%7||m.s.length>1050)return;
      if(!HEX.test(m.c))return;
      const s=[],c=m.c.toLowerCase(),H=hist[code]||(hist[code]=[]);
      for(let i=0;i<m.s.length;i+=7){
        const e=[num(m.s[i],-5000,5000),num(m.s[i+1],-500,500),num(m.s[i+2],-5000,5000),
                 num(m.s[i+3],-1,1),num(m.s[i+4],-1,1),num(m.s[i+5],-1,1),num(m.s[i+6],.01,.6)].map(r2);
        s.push(...e);H.push([...e,c]);
      }
      if(H.length>MAX_HIST)H.splice(0,H.length-MAX_HIST);
      saveDraws();
      bcast(room,{t:'d',id,c,s},ws);

    }else if(m.t==='w'){
      // limpeza de desenho: remove os carimbos dentro do raio (mesma regra do cliente)
      const x=num(m.x,-5000,5000),y=num(m.y,-500,500),z=num(m.z,-5000,5000),R2=num(m.R,0,3)**2,vert=!!m.v;
      const H=hist[code];
      if(H&&H.length){
        hist[code]=H.filter(e=>{
          if((Math.abs(e[4])<.5)!==vert)return true;
          const dx=e[0]-x,dz=e[2]-z,dy=vert?e[1]-y:0;
          if(dx*dx+dz*dz+dy*dy>R2)return true;
          if(!vert&&Math.abs(e[1]-y)>.6)return true;
          return false;
        });
        saveDraws();
      }
      bcast(room,{t:'w',id,x,y,z,v:vert?1:0,R:Math.sqrt(R2)},ws);

    }else if(m.t==='v'){
      if(typeof m.d==='string'&&m.d.length<=16000){
        bcast(room,{t:'v',id,r:(+m.r>=8000&&+m.r<=48000)?+m.r:16000,d:m.d},ws);
      }

    }else if(m.t==='chat'){
      const msg=String(m.msg||'').trim().slice(0,120);
      if(msg)bcast(room,{t:'chat',id,msg},ws);

    /* ---------- CONSTRUÇÕES ---------- */
    }else if(m.t==='b'){
      // nova construção -> o servidor dá o "bid" e envia para TODOS (inclusive quem construiu)
      const o=bPick(m,true);if(!o)return;
      if(Object.keys(R.builds).length>=MAX_B){send(ws,{t:'berr',err:'limite de construções'});return}
      const bid=++R.nb;R.builds[bid]=o;save();
      const out={t:'b',id,bid,...o};
      if(typeof m.cid==='string'&&m.cid.length<=32)out.cid=m.cid; // ecoa o id local p/ o cliente casar com o preview
      bcast(room,out);
    }else if(m.t==='bu'){
      // mover/girar/recolorir: só os campos enviados mudam
      const bid=String(m.bid|0),b=R.builds[bid];if(!b)return;
      const patch=bPick(m,false);Object.assign(b,patch);save();
      bcast(room,{t:'bu',id,bid:+bid,...patch},ws);
    }else if(m.t==='bx'){
      // remover uma construção (bid) ou várias (bids, até 200)
      const list=(Array.isArray(m.bids)?m.bids.slice(0,200):[m.bid]).map(v=>String(v|0)).filter(k=>R.builds[k]);
      if(!list.length)return;
      for(const k of list)delete R.builds[k];
      save();
      bcast(room,{t:'bx',id,bids:list.map(Number)},ws);

    /* ---------- BOLA ÚNICA (tênis / vôlei / futebol) ---------- */
    }else if(m.t==='bset'){
      // escolhe/troca a bola: SUBSTITUI a que existe (nunca há duas). k vazio = remove a bola
      const k=ballKind(m.k);
      if(!k){delete balls[code];bcast(room,{t:'ballrm',id});return}
      const b=balls[code]={k,x:r2(num(m.x,-5000,5000)),y:r2(num(m.y,-500,500)),z:r2(num(m.z,-5000,5000)),
                           vx:0,vy:0,vz:0,h:0,own:id};
      bcast(room,{t:'ball',id,reset:1,...pubBall(b)}); // todos, inclusive quem criou
    }else if(m.t==='ball'){
      // só o DONO simula e envia; outro jogador só assume mandando touch:1 (ao chutar/pegar)
      const b=balls[code];if(!b)return;
      const ownerAlive=b.own&&room.has(b.own);
      if(!(b.own===id||!ownerAlive||m.touch))return;
      b.own=id;
      b.x=r2(num(m.x,-5000,5000));b.y=r2(num(m.y,-500,500));b.z=r2(num(m.z,-5000,5000));
      b.vx=r2(num(m.vx,-80,80));b.vy=r2(num(m.vy,-80,80));b.vz=r2(num(m.vz,-80,80));
      b.h=m.h?1:0; // 1 = alguém está segurando/carregando a bola
      bcast(room,{t:'ball',id,...pubBall(b)},ws);

    /* ---------- MINIGAMES ---------- */
    }else if(m.t==='g'){
      const gid=String(m.g||'');if(!NAME.test(gid))return;
      const gs=games[code]||(games[code]={});
      let G=gs[gid];
      if(m.a==='join'){
        for(const o of Object.keys(gs))if(o!==gid)leaveGame(code,room,id,o); // 1 minigame por vez
        G=gs[gid];
        if(!G){
          const n=Math.max(1,Math.min(4,((+m.n)|0)||SEATS[gid]||2));
          G=gs[gid]={seats:Array(n).fill(null),st:null};
        }
        let i=G.seats.indexOf(id);
        if(i<0){
          const pref=Number.isInteger(m.i)?m.i:-1;
          i=(pref>=0&&pref<G.seats.length&&G.seats[pref]==null)?pref:G.seats.indexOf(null);
          if(i<0){send(ws,{t:'g',a:'full',g:gid});return}
          G.seats[i]=id;
        }
        bcast(room,seatsMsg(gid,G));                       // vagas para todos
        if(G.st)send(ws,{t:'g',a:'st',g:gid,d:G.st});     // estado atual para quem entrou
      }else if(!G){
        return;
      }else if(m.a==='leave'){
        leaveGame(code,room,id,gid);
      }else if(m.a==='q'){
        send(ws,seatsMsg(gid,G));
      }else{
        const i=G.seats.indexOf(id);if(i<0||!okPayload(m.d))return; // só quem está sentado
        if(m.a==='st'){
          // estado oficial: só o anfitrião (menor vaga ocupada) envia
          if(i!==hostOf(G))return;
          G.st=m.d;
          bcast(room,{t:'g',a:'st',g:gid,d:m.d},ws);
        }else if(m.a==='in'){
          bcast(room,{t:'g',a:'in',g:gid,i,id,d:m.d},ws);  // entrada do jogador (raquete, direção...)
        }else if(m.a==='ev'){
          bcast(room,{t:'g',a:'ev',g:gid,i,id,d:m.d},ws);  // eventos (ponto, rebatida, fim)
        }
      }
    }
  });

  ws.on('close',()=>{
    room.delete(id);
    // sai dos minigames
    const gs=games[code];
    if(gs)for(const gid of Object.keys(gs))leaveGame(code,room,id,gid);
    bcast(room,{t:'l',id});
    // passa a bola para outro jogador continuar a simulação
    const b=balls[code];
    if(b&&b.own===id){
      const nx=[...room.keys()][0];
      b.own=nx||0;
      if(nx)bcast(room,{t:'ball',id:0,...pubBall(b)});
    }
    if(!room.size){delete live[code];delete balls[code];delete games[code]}
  });
});

// mantém as conexões vivas e derruba as mortas
setInterval(()=>wss.clients.forEach(w=>{
  if(!w.alive)return w.terminate();
  w.alive=false;w.ping();
}),30000);
server.listen(process.env.PORT||3000,()=>console.log('rodando'));
