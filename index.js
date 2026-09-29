require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    DisconnectReason
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode");

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER_NUMBER = "263778810589";
const ROOT = __dirname;
const AUTH_DIR = path.join(ROOT, "auth");
const DATA_DIR = path.join(ROOT, "data");
const MEDIA_DIR = path.join(ROOT, "media");

for (const dir of [AUTH_DIR, DATA_DIR, MEDIA_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const DB_FILE = path.join(DATA_DIR, "deployed.json");
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]", "utf8");

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(ROOT));
app.use("/media", express.static(MEDIA_DIR));

function getDB() {
    try { const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); return Array.isArray(d)?d:[]; } catch { return []; }
}
function saveDB(db) {
    try { const t = DB_FILE+".tmp"; fs.writeFileSync(t, JSON.stringify(db,null,2),"utf8"); fs.renameSync(t, DB_FILE); } catch(e){ console.error(e.message); }
}
function sendSafe(res,file){
    for(const c of [file, path.join("public",file), "main.html","index.html"]){
        const f = path.join(ROOT,c); if(fs.existsSync(f)) return res.sendFile(f);
    }
    return res.status(404).send(`Missing ${file}`);
}
app.get("/",(req,res)=>sendSafe(res,"index.html"));
app.get("/pair",(req,res)=>sendSafe(res,"pair.html"));
app.get("/qr",(req,res)=>sendSafe(res,"qr.html"));
app.get("/deploy",(req,res)=>sendSafe(res,"deploy.html"));
app.get("/owner",(req,res)=>sendSafe(res,"deploy.html"));
app.get("/bot-image",(req,res)=>{
    for(const f of ["bot.jpg","bot.jpeg","bot.png","logo.jpg","bot_image.jpg","bot_image.png"]){
        const fp=path.join(MEDIA_DIR,f); if(fs.existsSync(fp)) return res.sendFile(fp);
    }
    const fb=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=","base64");
    res.set("Content-Type","image/png"); return res.send(fb);
});
app.get("/total-users",(req,res)=>{
    const db=getDB(); const now=Date.now();
    const active=db.filter(i=>{ const e=new Date(i.expiry).getTime(); return Number.isFinite(e)&&e>now&&i.active!==false; }).length;
    const expired=db.filter(i=>{ const e=new Date(i.expiry).getTime(); return Number.isFinite(e)&&e<=now; }).length;
    res.json({total:db.length,realTotal:db.length,online:active,count:db.length,real:db.length,active,expired,updatedAt:new Date().toISOString()});
});
app.get("/deploy-stats",(req,res)=>{
    const db=getDB(); const now=Date.now();
    const active=db.filter(i=>{ const e=new Date(i.expiry).getTime(); return Number.isFinite(e)&&e>now&&i.active!==false; }).length;
    const expired=db.filter(i=>{ const e=new Date(i.expiry).getTime(); return Number.isFinite(e)&&e<=now; }).length;
    const recent=db.filter(i=>{ const d=new Date(i.deployedAt).getTime(); return Number.isFinite(d)&&now-d<86400000; }).length;
    res.json({total:db.length,active,expired,recent,online:active});
});
app.get("/deployed-list",(req,res)=>{
    const db=getDB(); const now=Date.now();
    const list=db.map(item=>{
        const expiryMs=new Date(item.expiry).getTime();
        const daysLeft=Number.isFinite(expiryMs)?Math.max(0,Math.ceil((expiryMs-now)/86400000)):0;
        const expired=!Number.isFinite(expiryMs)||expiryMs<=now;
        return{number:item.number,duration:item.duration,expiry:item.expiry,deployedAt:item.deployedAt,daysLeft,isExpired:expired,active:!expired&&item.active!==false};
    });
    list.sort((a,b)=>new Date(b.deployedAt)-new Date(a.deployedAt));
    res.json(list);
});
app.post("/deploy",(req,res)=>{
    try{
        const {session,userNumber,duration}=req.body;
        if(!session||typeof session!=="string"||!session.startsWith("ETIAS-MINI-BOT~")) return res.json({success:false,message:"Invalid SESSION_ID"});
        const number=String(userNumber).replace(/\D/g,"");
        if(number.length<10) return res.json({success:false,message:"Invalid number"});
        const days=parseInt(duration,10)||30;
        const expiry=new Date(Date.now()+days*86400000);
        const db=getDB(); const filtered=db.filter(i=>i.number!==number);
        filtered.push({number,session:session.substring(0,60)+"...",fullSession:session,duration:days,expiry:expiry.toISOString(),deployedAt:new Date().toISOString(),active:true});
        saveDB(filtered);
        res.json({success:true,expiry:expiry.toISOString(),message:`Deployed ${number}`});
    }catch(e){ res.status(500).json({success:false,message:"Failed"}); }
});

const activeSockets=new Map();
const pairingStates=new Map();
const qrSockets=new Map();
function cleanNumber(v){return String(v||"").replace(/\D/g,"");}
function makePairId(n){return "ETIAS_"+n+"_"+Date.now()+"_"+crypto.randomBytes(4).toString("hex");}
function getDisconnectCode(e){ if(!e) return; return e?.output?.statusCode||e?.data?.attrs?.code||e?.statusCode; }

// ===== FIXED: TAR.GZ LIKE DEPLOYMENT SERVER =====
function createSessionBundle(authFolder){
    if(!fs.existsSync(authFolder)) throw new Error("Auth folder not found");
    const credsPath=path.join(authFolder,"creds.json");
    if(!fs.existsSync(credsPath)) throw new Error("creds.json not generated");
    const tempTar=path.join(ROOT,`temp_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.tar`);
    const tempGz=`${tempTar}.gz`;
    try{
        execFileSync("tar",["-cf",tempTar,"-C",authFolder,"."],{stdio:"ignore"});
        execFileSync("gzip",["-f",tempTar],{stdio:"ignore"});
        const data=fs.readFileSync(tempGz);
        return "ETIAS-MINI-BOT~"+data.toString("base64");
    }finally{
        try{fs.rmSync(tempTar,{force:true});}catch{}
        try{fs.rmSync(tempGz,{force:true});}catch{}
    }
}
function savePairedSession(number,session){
    const db=getDB(); const filtered=db.filter(i=>i.number!==number);
    const expiry=new Date(Date.now()+30*86400000);
    filtered.push({number,session:session.substring(0,60)+"...",fullSession:session,duration:30,expiry:expiry.toISOString(),deployedAt:new Date().toISOString(),active:true});
    saveDB(filtered);
}

// ===== FIXED: DM WITH PART FORMAT =====
async function sendSessionToWhatsApp(sock,number,session,id){
    try{
        await new Promise(r=>setTimeout(r,3000));
        let jid=sock.user?.id;
        if(!jid){ jid=`${number}@s.whatsapp.net`; console.log(`[DM] using fallback ${jid}`); }
        console.log(`[DM] Sending to ${jid} len=${session.length}`);

        await sock.sendMessage(jid,{text:`*ETIAS-MINI-BOT ✅ CONNECTED*\n\n*Number:* ${number}\n*Pair ID:* ${id}\n\nReceiving session...`});
        await new Promise(r=>setTimeout(r,1000));

        const chunkSize=40000;
        const total=Math.ceil(session.length/chunkSize);
        for(let i=0;i<total;i++){
            const chunk=session.slice(i*chunkSize,(i+1)*chunkSize);
            // Use PART format so deployment can parse it
            await sock.sendMessage(jid,{text:`ETIAS-MINI-BOT~PART:${i+1}/${total}\n\n${chunk}`});
            console.log(`[DM] Sent ${i+1}/${total}`);
            await new Promise(r=>setTimeout(r,700));
        }
        await sock.sendMessage(jid,{text:`*✅ DONE - ${total} parts*\n\nJoin all parts together and deploy at:\n${process.env.PAIR_URL||''}/deploy\n\nPair ID: ${id}`});
        console.log(`[DM] ✅ Session DM sent to ${number} in ${total} parts`);
        return true;
    }catch(e){
        console.error(`[DM ERROR] ${e.message}`);
        try{
            const fallback=`${number}@s.whatsapp.net`;
            await sock.sendMessage(fallback,{text:`*SESSION*\n\n${session.substring(0,55000)}\n\nID:${id}`});
            return true;
        }catch(e2){ console.error(`[DM FALLBACK] ${e2.message}`); return false; }
    }
}

async function startPairing(number,id,authFolder){
    const {state,saveCreds}=await useMultiFileAuthState(authFolder);
    console.log(`[AUTH] ${number} reg=${state.creds.registered}`);
    const sock=makeWASocket({
        auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,pino({level:"silent"}))},
        logger:pino({level:"silent"}),
        browser:Browsers.macOS("Chrome"),
        printQRInTerminal:false,
        markOnlineOnConnect:false,
        syncFullHistory:false,
        generateHighQualityLinkPreview:false,
        connectTimeoutMs:60000,
        keepAliveIntervalMs:10000
    });
    activeSockets.set(id,sock);
    let pairingCodeRequested=state.creds.registered;
    let sessionGenerated=false;
    pairingStates.set(id,{id,number,status:state.creds.registered?"authenticated":"connecting",code:null,session:null,connected:false,restartCount:pairingStates.get(id)?.restartCount||0,createdAt:pairingStates.get(id)?.createdAt||new Date().toISOString()});

    sock.ev.on("creds.update",async()=>{ try{await saveCreds();}catch{} });
    sock.ev.on("connection.update",async update=>{
        const {connection,lastDisconnect,qr,isNewLogin}=update;
        const info=pairingStates.get(id);
        if(connection==="connecting"&&info) info.status=state.creds.registered?"authenticated":"connecting";
        if(qr&&info) info.hasQR=true;

        if(!state.creds.registered&&!pairingCodeRequested&&(connection==="connecting"||qr)){
            pairingCodeRequested=true;
            try{
                await new Promise(r=>setTimeout(r,2500));
                const code=await sock.requestPairingCode(number);
                const formatted=code?.match(/.{1,4}/g)?.join("-")||code;
                const cur=pairingStates.get(id);
                if(cur){ cur.code=formatted; cur.status="waiting_for_pairing"; }
                console.log(`\n[PAIR CODE] ${formatted} for ${number}\n`);
            }catch(error){
                pairingCodeRequested=false;
                const msg=error?.message||String(error);
                const rate=msg.toLowerCase().includes("429")||msg.toLowerCase().includes("rate-overlimit");
                const cur=pairingStates.get(id);
                if(cur){ cur.status=rate?"rate_limited":"pairing_code_error"; cur.error=msg; cur.rateLimited=rate; }
                console.error(`[PAIR ERROR] ${msg}`);
                if(rate){ try{sock.end();}catch{} activeSockets.delete(id); }
            }
        }
        if(connection==="open"){
            console.log(`\n[CONNECTED] ${number} newLogin=${isNewLogin} id=${sock.user?.id}`);
            const cur=pairingStates.get(id);
            if(cur){ cur.connected=true; cur.status="connected"; cur.whatsappId=sock.user?.id||null; }
            try{await saveCreds();}catch{}
            await new Promise(r=>setTimeout(r,3000));
            if(!sessionGenerated){
                try{
                    if(!fs.existsSync(path.join(authFolder,"creds.json"))){
                        fs.writeFileSync(path.join(authFolder,"creds.json"),JSON.stringify(state.creds,null,2));
                    }
                    const session=createSessionBundle(authFolder);
                    sessionGenerated=true;
                    const st=pairingStates.get(id);
                    if(st){ st.status="session_ready"; st.session=session; st.connected=true; st.sessionLength=session.length; }
                    savePairedSession(number,session);
                    console.log(`[SESSION] len=${session.length}`);
                    const dmOk=await sendSessionToWhatsApp(sock,number,session,id);
                    const st2=pairingStates.get(id); if(st2) st2.dmSent=dmOk;
                }catch(e){
                    console.error(`[SESSION ERR] ${e.message}`);
                    const st=pairingStates.get(id); if(st){ st.status="session_error"; st.error=e.message; }
                }
            }
            return;
        }
        if(connection==="close"){
            const code=getDisconnectCode(lastDisconnect?.error);
            console.log(`[CLOSED] ${number} CODE=${code}`);
            const cur=pairingStates.get(id); if(cur){ cur.connected=false; cur.disconnectCode=code; }
            if(code===DisconnectReason.restartRequired){
                console.log(`[515 RESTART] ${number}`);
                const cs=pairingStates.get(id); if(cs){ cs.status="restarting"; cs.restartCount=(cs.restartCount||0)+1; }
                activeSockets.delete(id);
                await new Promise(r=>setTimeout(r,1500));
                try{await startPairing(number,id,authFolder);}catch{}
                return;
            }
            if(code===DisconnectReason.loggedOut||code===DisconnectReason.badSession||code===429){
                if(cur) cur.status=code===429?"rate_limited":code===DisconnectReason.loggedOut?"logged_out":"bad_session";
                activeSockets.delete(id); return;
            }
            if(cur) cur.status="disconnected";
            activeSockets.delete(id);
        }
    });
    return sock;
}

app.get("/code",async(req,res)=>{
    const number=cleanNumber(req.query.number);
    if(!number||number.length<10||number.length>15) return res.status(400).json({success:false,error:"Enter valid number ex: 2637XXXXXXX"});
    for(const [eid,info] of pairingStates.entries()){
        if(info.number===number&&["connecting","waiting_for_pairing","restarting","authenticated"].includes(info.status)){
            return res.json({success:true,existing:true,id:eid,sessionId:eid,status:info.status,code:info.code||null,connected:info.connected||false});
        }
        if(info.number===number&&info.status==="rate_limited") return res.status(429).json({success:false,error:"Rate limited",id:eid,status:info.status});
    }
    const id=makePairId(number); const authFolder=path.join(AUTH_DIR,id);
    try{
        fs.mkdirSync(authFolder,{recursive:true});
        console.log(`\n[PAIR START] ${number} | ${id}`);
        await startPairing(number,id,authFolder);
        const start=Date.now();
        while(Date.now()-start<30000){
            const info=pairingStates.get(id);
            if(info?.code) return res.json({success:true,status:"waiting_for_pairing",code:info.code,sessionId:id,id,number});
            if(info?.status==="rate_limited") return res.status(429).json({success:false,status:"rate_limited",error:info.error,id,sessionId:id});
            if(info?.status==="pairing_code_error") return res.status(500).json({success:false,error:info.error||"Pairing failed",id});
            await new Promise(r=>setTimeout(r,250));
        }
        return res.status(504).json({success:false,error:"No code from WhatsApp",id,sessionId:id});
    }catch(e){
        try{fs.rmSync(authFolder,{recursive:true,force:true});}catch{}
        pairingStates.delete(id);
        return res.status(500).json({success:false,error:e?.message||"Failed"});
    }
});
app.get("/status/:id",(req,res)=>{
    const st=pairingStates.get(req.params.id);
    if(!st) return res.json({success:false,status:"not_found",id:req.params.id});
    res.json({success:true,id:st.id,number:st.number,status:st.status,connected:st.connected||false,code:st.code||null,hasSession:!!st.session,sessionLength:st.sessionLength||0,dmSent:st.dmSent||false,error:st.error||null});
});
app.get("/check/:id",(req,res)=>{
    const st=pairingStates.get(req.params.id);
    if(st) return res.json({connected:st.connected||false,status:st.status,code:st.code||null,session:st.session||null,number:st.number,id:req.params.id,dmSent:st.dmSent||false});
    const authFolder=path.join(AUTH_DIR,req.params.id);
    if(!fs.existsSync(authFolder)) return res.json({connected:false,status:"not_found",id:req.params.id});
    try{ const s=createSessionBundle(authFolder); return res.json({connected:true,status:"session_ready",session:s,id:req.params.id}); }
    catch(e){ return res.json({connected:false,status:"waiting",id:req.params.id,error:e.message}); }
});
app.get("/session/:id",(req,res)=>{
    const st=pairingStates.get(req.params.id);
    if(st?.session) return res.json({success:true,connected:true,session:st.session,id:req.params.id});
    const authFolder=path.join(AUTH_DIR,req.params.id);
    try{ const s=createSessionBundle(authFolder); return res.json({success:true,connected:true,session:s,id:req.params.id}); }
    catch{ return res.status(404).json({success:false,error:"Not ready"}); }
});
app.get("/qr-image",async(req,res)=>{
    const id="QR_"+Date.now()+"_"+crypto.randomBytes(3).toString("hex");
    const authFolder=path.join(AUTH_DIR,id);
    try{
        const {state,saveCreds}=await useMultiFileAuthState(authFolder);
        const sock=makeWASocket({auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,pino({level:"silent"}))},logger:pino({level:"silent"}),browser:Browsers.macOS("Chrome"),printQRInTerminal:false});
        qrSockets.set(id,sock);
        sock.ev.on("creds.update",saveCreds);
        const qrData=await new Promise((resolve,reject)=>{
            let done=false; const timer=setTimeout(()=>{ if(!done){done=true; reject(new Error("QR timeout"));}},60000);
            sock.ev.on("connection.update",async u=>{
                if(u.qr&&!done){ try{ const img=await qrcode.toDataURL(u.qr); done=true; clearTimeout(timer); resolve(img);}catch(e){done=true; clearTimeout(timer); reject(e);} }
                if(u.connection==="close"&&!done){ done=true; clearTimeout(timer); reject(new Error("Closed")); }
            });
        });
        return res.json({success:true,id,qr:qrData});
    }catch(e){
        try{fs.rmSync(authFolder,{recursive:true,force:true});}catch{}
        return res.status(500).json({success:false,error:"QR failed"});
    }
});
setInterval(()=>{ for(const [id,sock] of qrSockets.entries()){ try{sock.end();}catch{} qrSockets.delete(id); try{fs.rmSync(path.join(AUTH_DIR,id),{recursive:true,force:true});}catch{}} },120000);
setInterval(()=>{ const now=Date.now(); for(const [id,st] of pairingStates.entries()){ const c=new Date(st.createdAt).getTime(); if(!Number.isFinite(c)) continue; if(st.connected||st.status==="session_ready") continue; if(now-c>600000){ console.log(`[CLEANUP] ${id}`); const s=activeSockets.get(id); try{s?.end();}catch{} activeSockets.delete(id); try{fs.rmSync(path.join(AUTH_DIR,id),{recursive:true,force:true});}catch{} pairingStates.delete(id); } } },60000);

app.get("/ping",(req,res)=>res.send("ETIAS-PAIR alive "+new Date().toISOString()));
app.get("/health",(req,res)=>res.json({status:"alive",total:getDB().length,activeSockets:activeSockets.size,pairingSessions:pairingStates.size,uptime:process.uptime(),timestamp:new Date().toISOString()}));

app.listen(PORT,"0.0.0.0",()=>{
    console.log(`\n=== ETIAS PAIR ONLINE TAR.GZ + DM :${PORT} ===\n`);
});
process.on("unhandledRejection",e=>console.error("[UNHANDLED]",e));
process.on("uncaughtException",e=>console.error("[UNCAUGHT]",e));
