const express=require('express'),http=require('http'),path=require('path'),fs=require('fs');
const {WebSocketServer}=require('ws');
const app=express();app.use(express.json());
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
const wss=new WebSocketServer({server,path:'/ws'});
const live={};let nextId=1;

wss.on('connection',(ws,req)=>{
  const code=(new URL(req.url,'http://x').searchParams.get('code')||'').toUpperCase();
  if(!rooms[code]){ws.close(4004,'no room');return}
  const room=live[code]||(live[code]=new Map());
  if(room.size>=20){ws.close(4005,'full');return}
  const id=nextId++;ws.id=id;ws.state=null;room.set(id,ws);
  ws.send(JSON.stringify({t:'hi',id,players:[...room.values()].filter(w=>w!==ws&&w.state).map(w=>({id:w.id,...w.state}))}));

  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw)}catch{return}
    if(m.t==='s'){
      const s={x:+m.x||0,y:+m.y||0,z:+m.z||0,yaw:+m.yaw||0,col:/^#[0-9a-fA-F]{6}$/.test(m.col)?m.col:'#3f7cff'};
      ws.state=s;
      const out=JSON.stringify({t:'s',id,...s});
      for(const w of room.values())if(w!==ws&&w.readyState===1)w.send(out);
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
