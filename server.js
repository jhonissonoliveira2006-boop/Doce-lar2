const express=require('express'),http=require('http'),path=require('path'),fs=require('fs');
const {WebSocketServer}=require('ws');
const app=express();app.use(express.json());
// libera o microfone para o próprio site (voz)
app.use((req,res,next)=>{res.setHeader('Permissions-Policy','microphone=(self)');next()});
app.use(express.static(path.join(__dirname,'public')));

const FILE=process.env.DATA_FILE||path.join(__dirname,'rooms.json');
let rooms={};
try{rooms=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){}
const save=()=>{try{fs.writeFileSync(FILE,JSON.stringify(rooms))}catch(e){console.error(e)}};
const ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const gen=()=>{let s='';for(let i=0;i<6;i++)s+=ALPHA[Math.floor(Math.random()*ALPHA.length)];return s};

app.post('/api/create',(req,res)=>{
  let c=String((req.body&&req.body.code)||'').toUpperCase();
  if(c){
    if(!/^[A-Z0-9-]{3,16}$/.test(c))return res.status(400).json({err:'Código inválido (3 a 16 letras/números)'});
    if(rooms[c])return res.status(409).json({err:'Esse endereço já existe'});
  }else{do c=gen();while(rooms[c])}
  rooms[c]={created:Date.now()};save();
  res.json({code:c});
});
app.get('/api/exists/:code',(req,res)=>res.json({ok:!!rooms[String(req.params.code).toUpperCase()]}));

const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws',maxPayload:64*1024});
const live={};let nextId=1;
// desenhos de cada sala (ficam na memória enquanto o servidor estiver ligado)
// cada carimbo: [x,y,z,nx,ny,nz,raio,cor]
const hist={};
const MAX_HIST=40000;
const num=(v,a,b)=>Math.max(a,Math.min(b,+v||0));
const r2=v=>Math.round(v*100)/100;

wss.on('connection',(ws,req)=>{
  const code=(new URL(req.url,'http://x').searchParams.get('code')||'').toUpperCase();
  if(!rooms[code]){ws.close(4004,'no room');return}
  const room=live[code]||(live[code]=new Map());
  if(room.size>=20){ws.close(4005,'full');return}
  const id=nextId++;ws.id=id;ws.state=null;room.set(id,ws);
  ws.send(JSON.stringify({t:'hi',id,players:[...room.values()].filter(w=>w!==ws&&w.state).map(w=>({id:w.id,...w.state}))}));

  // envia os desenhos que já existem na sala para quem acabou de entrar
  const h=hist[code]||[];
  for(let i=0;i<h.length;){
    const c=h[i][7],s=[];let j=i;
    while(j<h.length&&h[j][7]===c&&s.length<1050){for(let k=0;k<7;k++)s.push(h[j][k]);j++}
    ws.send(JSON.stringify({t:'d',id:0,c,s}));
    i=j;
  }

  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.t==='s'){
      const s={
        x:+m.x||0,y:+m.y||0,z:+m.z||0,yaw:+m.yaw||0,
        col:/^#[0-9a-fA-F]{6}$/.test(m.col)?m.col:'#3f7cff',
        hs:r2(num(m.hs,0,30)),          // velocidade horizontal
        vy:r2(num(m.vy,-40,40)),        // velocidade vertical
        f:(+m.f||0)&127,                // bits: chão, rolando, parede, sentado, mergulho, item, limpando
        rp:r2(num(m.rp,0,1)),           // progresso do rolar
        fp:r2(num(m.fp,0,1))            // progresso do giro no ar
      };
      ws.state=s;
      const out=JSON.stringify({t:'s',id,...s});
      for(const w of room.values())if(w!==ws&&w.readyState===1)w.send(out);
    }else if(m.t==='d'){
      // lote de carimbos de desenho: 7 números por carimbo (x,y,z,nx,ny,nz,raio) + uma cor
      if(!Array.isArray(m.s)||m.s.length===0||m.s.length%7||m.s.length>1050)return;
      if(!/^#[0-9a-fA-F]{6}$/.test(m.c))return;
      const s=[],c=m.c.toLowerCase(),H=hist[code]||(hist[code]=[]);
      for(let i=0;i<m.s.length;i+=7){
        const e=[num(m.s[i],-5000,5000),num(m.s[i+1],-500,500),num(m.s[i+2],-5000,5000),
                 num(m.s[i+3],-1,1),num(m.s[i+4],-1,1),num(m.s[i+5],-1,1),num(m.s[i+6],.01,.6)].map(r2);
        s.push(...e);H.push([...e,c]);
      }
      if(H.length>MAX_HIST)H.splice(0,H.length-MAX_HIST);
      const out=JSON.stringify({t:'d',id,c,s});
      for(const w of room.values())if(w!==ws&&w.readyState===1)w.send(out);
    }else if(m.t==='w'){
      // limpeza de desenho: remove os carimbos dentro do raio (mesma regra do cliente)
      const x=num(m.x,-5000,5000),y=num(m.y,-500,500),z=num(m.z,-5000,5000),R=num(m.R,0,3),vert=!!m.v;
      const H=hist[code];
      if(H&&H.length){
        const R2=R*R;
        hist[code]=H.filter(e=>{
          if((Math.abs(e[4])<.5)!==vert)return true;
          const dx=e[0]-x,dz=e[2]-z,dy=vert?e[1]-y:0;
          if(dx*dx+dz*dz+dy*dy>R2)return true;
          if(!vert&&Math.abs(e[1]-y)>.6)return true;
          return false;
        });
      }
      const out=JSON.stringify({t:'w',id,x,y,z,v:vert?1:0,R});
      for(const w of room.values())if(w!==ws&&w.readyState===1)w.send(out);
    }else if(m.t==='v'){
      if(typeof m.d==='string'&&m.d.length<=16000){
        const out=JSON.stringify({t:'v',id,r:(+m.r>=8000&&+m.r<=48000)?+m.r:16000,d:m.d});
        for(const w of room.values())if(w!==ws&&w.readyState===1)w.send(out);
      }
    }else if(m.t==='chat'){
      // Tratamento e retransmissão segura da mensagem de chat
      const msg = String(m.msg || '').trim().slice(0, 120);
      if(msg){
        const out = JSON.stringify({t:'chat', id, msg});
        for(const w of room.values()) if(w !== ws && w.readyState === 1) w.send(out);
      }
    }
  });

  ws.on('close',()=>{
    room.delete(id);
    const out=JSON.stringify({t:'l',id});
    for(const w of room.values())if(w.readyState===1)w.send(out);
    if(!room.size)delete live[code];
  });
});

setInterval(()=>wss.clients.forEach(w=>w.readyState===1&&w.ping()),30000);
server.listen(process.env.PORT||3000,()=>console.log('rodando'));
