const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, delay, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_NUMBER = '263778810589';

// Ensure folders
['./auth','./data','./media'].forEach(d=>{
  if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true});
});
if(!fs.existsSync('./data/deployed.json')) fs.writeFileSync('./data/deployed.json', '[]');

app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/media', express.static(path.join(__dirname, 'media')));

// Helper - REAL DB
function getDB(){
  try{ return JSON.parse(fs.readFileSync('./data/deployed.json','utf8')); }catch{ return []; }
}
function saveDB(db){ fs.writeFileSync('./data/deployed.json', JSON.stringify(db, null, 2)); }

// Pages - SAFE
function sendSafe(res, file){
  const files = [file, `public/${file}`, 'main.html', 'index.html'];
  for(let f of files){
    let p = path.join(__dirname, f);
    if(fs.existsSync(p)) return res.sendFile(p);
  }
  return res.status(404).send(`Missing ${file} - put it in ~/etias-pair/`);
}
app.get('/', (req,res)=> sendSafe(res, 'index.html'));
app.get('/pair', (req,res)=> sendSafe(res, 'pair.html'));
app.get('/qr', (req,res)=> sendSafe(res, 'qr.html'));
app.get('/deploy', (req,res)=> sendSafe(res, 'deploy.html'));
app.get('/owner', (req,res)=> sendSafe(res, 'deploy.html'));

// Bot image
app.get('/bot-image', (req, res) => {
  const tryFiles = ['bot.jpg','bot.jpeg','bot.png','logo.jpg','bot_image.jpg','bot_image.png'];
  for(let n of tryFiles){
    let p = path.join(__dirname, 'media', n);
    if(fs.existsSync(p)) return res.sendFile(p);
  }
  const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  res.set('Content-Type','image/png'); res.send(buf);
});

// === REAL TOTAL USERS & REAL ONLINE ===
app.get('/total-users', (req,res)=>{
  const db = getDB();
  const now = new Date();
  const active = db.filter(s=> new Date(s.expiry) > now && s.active!==false).length;
  const expired = db.filter(s=> new Date(s.expiry) <= now).length;
  
  // REAL - no fake +1523
  const total = db.length;
  const online = active; // real online = active non-expired
  
  res.json({ 
    total, 
    realTotal: total,
    online, 
    count: total, 
    real: total,
    active, 
    expired,
    updatedAt: new Date().toISOString()
  });
});

app.get('/deploy-stats', (req,res)=>{
  const db = getDB();
  const now = new Date();
  const active = db.filter(s=> new Date(s.expiry) > now && s.active!==false).length;
  const expired = db.filter(s=> new Date(s.expiry) <= now).length;
  const recent = db.filter(s=> Date.now() - new Date(s.deployedAt).getTime() < 24*60*60*1000).length;
  res.json({ total: db.length, active, expired, recent, online: active });
});

// Real deployed list for deploy.html
app.get('/deployed-list', (req,res)=>{
  const db = getDB();
  const now = Date.now();
  const list = db.map(u=>{
    const expiryMs = new Date(u.expiry).getTime();
    const daysLeft = Math.max(0, Math.ceil((expiryMs - now)/(24*60*60*1000)));
    const isExpired = expiryMs <= now;
    return {
      number: u.number,
      duration: u.duration,
      expiry: u.expiry,
      deployedAt: u.deployedAt,
      daysLeft,
      isExpired,
      active: !isExpired && u.active!==false
    };
  }).sort((a,b)=> new Date(b.deployedAt) - new Date(a.deployedAt));
  res.json(list);
});

// Deploy API
app.post('/deploy', (req,res)=>{
  const { session, userNumber, duration } = req.body;
  if(!session || !session.startsWith('ETIAS-MINI-BOT')) return res.json({ success:false, message:'Invalid SESSION_ID - must start with ETIAS-MINI-BOT~' });
  if(!userNumber) return res.json({ success:false, message:'User number required' });

  const days = parseInt(duration) || 30;
  const expiry = new Date(Date.now()+days*24*60*60*1000);
  const db = getDB();

  const filtered = db.filter(u=> u.number !== userNumber);
  filtered.push({
    number: userNumber,
    session: session.substring(0,60)+'...',
    fullSession: session,
    duration: days,
    expiry: expiry.toISOString(),
    deployedAt: new Date().toISOString(),
    active: true
  });
  saveDB(filtered);

  console.log(`[DEPLOY] ${userNumber} for ${days} days`);
  return res.json({ status:true, success:true, expiry: expiry.toISOString(), message:`Deployed ${userNumber} for ${days} days` });
});

// Store active pairing
const activeSockets = new Map();

// FIXED PAIR - Prevents "Couldn't link device"
app.get('/code', async (req,res)=>{
  const num = req.query.number?.replace(/[^0-9]/g,'');
  if(!num || num.length<10) return res.status(400).json({error:'Enter valid number ex: 2637XXXXXX'});
  const id = 'ETIAS_'+num+'_'+Date.now();
  const authFolder = `./auth/${id}`;
  try{
    const {state, saveCreds} = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({ 
      auth: state, 
      logger: pino({level:'silent'}), 
      browser: Browsers.macOS('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);
    activeSockets.set(id, sock);

    await delay(3500); // CRITICAL FIX
    
    if(!sock.authState.creds.registered){
      let code = await sock.requestPairingCode(num);
      code = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`[PAIR] ${num} => ${code}`);

      sock.ev.on('connection.update', async (u)=>{
        if(u.connection === 'open'){
          try{
            const credsPath = path.join(authFolder, 'creds.json');
            if(fs.existsSync(credsPath)){
              const raw = fs.readFileSync(credsPath,'utf8');
              const session = `ETIAS-MINI-BOT~${Buffer.from(raw).toString('base64')}`;
              console.log(`[SESSION] Generated for ${num}`);
              const db = getDB();
              const expiry = new Date(Date.now()+30*24*60*60*1000);
              const filtered = db.filter(x=>x.number!==num);
              filtered.push({ number:num, session:session.substring(0,60)+'...', fullSession:session, duration:30, expiry:expiry.toISOString(), deployedAt:new Date().toISOString(), active:true });
              saveDB(filtered);
            }
          }catch(e){ console.log(e.message); }
        }
      });

      res.json({code, sessionId: id, id});
      setTimeout(()=>{ try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{} try{activeSockets.get(id)?.ws?.close()}catch{} activeSockets.delete(id); }, 240000);
    } else {
      res.status(400).json({error:'Already registered'});
    }
  }catch(e){
    console.error(`[PAIR ERROR] ${num}`, e.message); 
    res.status(500).json({error:'Failed - try QR or check number 263...'});
    try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{}
  }
});

app.get('/check/:id', (req,res)=>{
  const id = req.params.id;
  const authFolder = `./auth/${id}`;
  const credsPath = path.join(authFolder, 'creds.json');
  if(fs.existsSync(credsPath)){
    try{
      const raw = fs.readFileSync(credsPath,'utf8');
      if(fs.statSync(credsPath).size > 300){
        const session = `ETIAS-MINI-BOT~${Buffer.from(raw).toString('base64')}`;
        return res.json({connected:true, session});
      }
    }catch{}
  }
  res.json({connected:false});
});

app.get('/qr-image', async (req,res)=>{
  const id='QR_'+Date.now();
  const authFolder=`./auth/${id}`;
  try{
    const {state, saveCreds} = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({ auth:state, logger:pino({level:'silent'}), browser:Browsers.macOS('Chrome') });
    sock.ev.on('creds.update', saveCreds);
    const qrData = await new Promise((resolve,reject)=>{
      let t=setTimeout(()=>reject('timeout'),30000);
      sock.ev.on('connection.update', async u=>{
        if(u.qr){ clearTimeout(t); resolve(await qrcode.toDataURL(u.qr)); }
        if(u.connection==='close'){ clearTimeout(t); reject('closed'); }
      });
    });
    res.json({qr:qrData});
    setTimeout(()=>{ try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{} }, 90000);
  }catch(e){ res.status(500).json({error:'QR failed refresh'}); try{fs.rmSync(authFolder,{recursive:true,force:true})}catch{} }
});

// Keep alive
app.get('/ping', (req,res)=> res.send('ETIAS-PAIR alive '+new Date().toISOString()));
app.get('/health', (req,res)=> res.json({status:'alive', total:getDB().length}));

setInterval(async ()=>{ try{ await fetch(`http://localhost:${PORT}/ping`).catch(()=>{}) }catch{} }, 14*60*1000);

app.listen(PORT, '0.0.0.0', ()=> console.log(`✅ ETIAS PAIR running on ${PORT} - REAL STATS`));
