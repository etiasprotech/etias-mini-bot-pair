"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CODE_LENGTH = 8;
const SESSION_LENGTH = 8;

// FIXED: Was 10 minutes, now 24 hours for owner to deploy
const CODE_TTL = 24 * 60 * 60 * 1000;

const DATA_DIR = path.join(__dirname, "data");
const SESSION_FILE = path.join(DATA_DIR, "sessions.json");

const deploymentCodes = new Map();
const sessionIndex = new Map();

function ensureDataDirectory(){ if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }

function saveSessions(){
    try{
        ensureDataDirectory();
        const records = Array.from(sessionIndex.values());
        const tempFile = `${SESSION_FILE}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(records,null,2),"utf8");
        fs.renameSync(tempFile, SESSION_FILE);
    }catch(e){ console.error("[SESSION DB] Failed to save:", e.message); }
}

function loadSessions(){
    try{
        ensureDataDirectory();
        if(!fs.existsSync(SESSION_FILE)){ console.log("[SESSION DB] No database"); return; }
        const raw=fs.readFileSync(SESSION_FILE,"utf8"); if(!raw.trim()) return;
        const records=JSON.parse(raw); if(!Array.isArray(records)) return;
        let restored=0;
        for(const record of records){
            if(!record||!record.pairingId||!record.sessionId) continue;
            // FIXED: Keep ALL records, even expired undeployed for 24h
            if(!record.used && record.expiresAt && Date.now() > record.expiresAt + (24*60*60*1000)) continue;
            deploymentCodes.set(record.pairingId, record);
            sessionIndex.set(record.sessionId, record);
            restored++;
        }
        console.log(`[SESSION DB] Restored ${restored} session(s).`);
    }catch(e){ console.error("[SESSION DB] Load failed:", e.message); }
}

function generateNumericId(length=8){ const max=10**length; return crypto.randomInt(0,max).toString().padStart(length,"0"); }
function hashCode(code){ return crypto.createHash("sha256").update(String(code)).digest("hex"); }
function normalizeJid(jid){ if(!jid) return null; return String(jid).trim().replace(/:\d+(?=@)/,""); }
function jidToNumber(jid){ const n=normalizeJid(jid); if(!n) return null; return n.split("@")[0].replace(/\D/g,""); }
function normalizePhone(phone){ if(!phone) return null; return String(phone).replace(/\D/g,""); }
function isValidSessionId(sId){ return /^ETIAS-MINI-BOT~\d{8}$/.test(String(sId||"").trim()); }
function generateSessionId(){ let sId; do{ sId=`ETIAS-MINI-BOT~${generateNumericId(SESSION_LENGTH)}`; }while(sessionIndex.has(sId)); return sId; }

function generateDeploymentCode({pairingId,jid,authFolder,phone}){
    if(!pairingId) throw new Error("pairingId required");
    if(!jid) throw new Error("JID required");
    if(!authFolder) throw new Error("authFolder required");
    const code=generateNumericId(CODE_LENGTH);
    const sessionId=generateSessionId();
    const normalizedJid=normalizeJid(jid);
    const number=normalizePhone(phone)||jidToNumber(normalizedJid);
    const createdAt=Date.now(); const expiresAt=createdAt+CODE_TTL;
    const record={
        pairingId, sessionId, codeHash:hashCode(code), jid:normalizedJid, number, phone:number,
        authFolder, createdAt, updatedAt:createdAt, expiresAt,
        used:false, connected:true, sent:false, status:"connected", deployedAt:null, deleted:false
    };
    deploymentCodes.set(pairingId, record);
    sessionIndex.set(sessionId, record);
    saveSessions();
    console.log(`[SESSION DB] Created ${sessionId} for ${number}`);
    return {code, sessionId, pairingId, jid:normalizedJid, number, authFolder, expiresAt};
}

async function generateAndSendSession(sock, authFolder, authenticatedJid, pairingId, normalizedJid){
    if(!sock) throw new Error("Socket unavailable");
    const targetJid=normalizeJid(normalizedJid||authenticatedJid);
    if(!targetJid) throw new Error("JID unavailable");
    if(!pairingId) throw new Error("pairingId required");
    if(!authFolder) throw new Error("authFolder required");

    const result=generateDeploymentCode({pairingId, jid:targetJid, authFolder, phone:jidToNumber(targetJid)});
    const {sessionId, expiresAt, number}=result;

    // NEW MESSAGE - matches your flow
    const message =
`╭━━━〔 ETIAS-MINI-BOT 〕━━━╮
┃ ✅ PAIRED SUCCESSFULLY
┃
┃ 🔑 SESSION ID
┃ ${sessionId}
┃
┃ 📱 Number: ${number}
┃
┃ 👉 Send this Session ID to the
┃ owner for deployment.
┃
┃ ⏳ Valid for 24 hours to deploy
┃ 🔒 Keep it private!
╰━━━━━━━━━━━━━━━━━━━━━━╯`;

    await sock.sendMessage(targetJid, {text: message});

    const record=sessionIndex.get(sessionId);
    if(record){
        record.sent=true; record.status="session_sent"; record.updatedAt=Date.now();
        deploymentCodes.set(record.pairingId, record);
        sessionIndex.set(record.sessionId, record);
        saveSessions();
    }
    console.log(`[SESSION] Sent ${sessionId} to ${targetJid}`);
    return {sessionId, deploymentCode:result.code, pairingId, jid:targetJid, number, authFolder, expiresAt};
}

function getSessionById(sessionId){
    const id=String(sessionId||"").trim(); if(!id||!isValidSessionId(id)) return null;
    const record=sessionIndex.get(id); if(!record) return null;
    // FIXED: Don't delete if expired, just return it - owner can still deploy within 24h grace
    if(!record.used && record.expiresAt && Date.now() > record.expiresAt + (24*60*60*1000)){
        deleteDeploymentCode(record.pairingId); return null;
    }
    return {
        pairingId:record.pairingId, sessionId:record.sessionId, jid:record.jid,
        number:record.number, phone:record.phone||record.number, authFolder:record.authFolder,
        createdAt:record.createdAt, expiresAt:record.expiresAt, used:record.used,
        connected:record.connected, sent:record.sent, status:record.status,
        deployedAt:record.deployedAt, updatedAt:record.updatedAt||record.createdAt
    };
}

function getRawSession(sessionId){ return sessionIndex.get(String(sessionId||"").trim())||null; }

function verifyDeploymentCode(pairingId, submittedCode){
    const record=deploymentCodes.get(String(pairingId||"").trim());
    if(!record) return {success:false, error:"Deployment session not found"};
    if(!record.used && record.expiresAt && Date.now() > record.expiresAt + (24*60*60*1000)){
        deleteDeploymentCode(record.pairingId);
        return {success:false, error:"Session ID expired (24h window)"};
    }
    const submitted=String(submittedCode||"").trim();
    if(submitted===record.sessionId){
        return {success:true, pairingId:record.pairingId, sessionId:record.sessionId, jid:record.jid, number:record.number, phone:record.phone||record.number, authFolder:record.authFolder, expiresAt:record.expiresAt, used:record.used, connected:record.connected, status:record.status};
    }
    const submittedHash=hashCode(submitted);
    if(submittedHash!==record.codeHash) return {success:false, error:"Invalid Session ID"};
    return {success:true, pairingId:record.pairingId, sessionId:record.sessionId, jid:record.jid, number:record.number, phone:record.phone||record.number, authFolder:record.authFolder, expiresAt:record.expiresAt, used:record.used, connected:record.connected, status:record.status};
}

function markSessionDeployed(sessionId){
    const id=String(sessionId||"").trim(); const record=sessionIndex.get(id);
    if(!record) return {success:false, error:"Session ID not found"};
    record.used=true; record.status="deployed"; record.deployedAt=Date.now(); record.updatedAt=Date.now();
    deploymentCodes.set(record.pairingId, record); sessionIndex.set(record.sessionId, record);
    saveSessions();
    console.log(`[SESSION DB] ${record.sessionId} marked deployed`);
    return {success:true, sessionId:record.sessionId, pairingId:record.pairingId, jid:record.jid, number:record.number, authFolder:record.authFolder, status:record.status, deployedAt:record.deployedAt};
}

function updateSession(sessionId, updates={}){
    const id=String(sessionId||"").trim(); const record=sessionIndex.get(id); if(!record) return null;
    const allowed=["jid","number","phone","authFolder","connected","sent","used","status","deployedAt"];
    for(const f of allowed){ if(Object.prototype.hasOwnProperty.call(updates,f)) record[f]=updates[f]; }
    if(updates.jid) record.jid=normalizeJid(updates.jid);
    if(updates.phone||updates.number){ const num=normalizePhone(updates.phone||updates.number); record.number=num; record.phone=num; }
    record.updatedAt=Date.now();
    deploymentCodes.set(record.pairingId, record); sessionIndex.set(record.sessionId, record);
    saveSessions();
    return getSessionById(record.sessionId);
}

function getDeploymentCodeStatus(pairingId){
    const record=deploymentCodes.get(String(pairingId||"").trim()); if(!record) return null;
    if(!record.used && record.expiresAt && Date.now() > record.expiresAt + (24*60*60*1000)){ deleteDeploymentCode(record.pairingId); return null; }
    return {pairingId:record.pairingId, sessionId:record.sessionId, jid:record.jid, number:record.number, phone:record.phone||record.number, authFolder:record.authFolder, expiresAt:record.expiresAt, used:record.used, connected:record.connected, sent:record.sent, status:record.status, createdAt:record.createdAt, deployedAt:record.deployedAt, updatedAt:record.updatedAt};
}

function getAllSessions(){
    const now=Date.now(); const sessions=[];
    for(const record of sessionIndex.values()){
        if(!record.used && record.expiresAt && now > record.expiresAt + (24*60*60*1000)) continue;
        sessions.push({pairingId:record.pairingId, sessionId:record.sessionId, jid:record.jid, number:record.number, phone:record.phone||record.number, authFolder:record.authFolder, expiresAt:record.expiresAt, used:record.used, connected:record.connected, sent:record.sent, status:record.status, createdAt:record.createdAt, deployedAt:record.deployedAt, updatedAt:record.updatedAt});
    }
    return sessions;
}

function deleteDeploymentCode(pairingId){
    const id=String(pairingId||"").trim(); const record=deploymentCodes.get(id);
    if(record) sessionIndex.delete(record.sessionId);
    deploymentCodes.delete(id); saveSessions();
}
function deleteSessionById(sessionId){
    const id=String(sessionId||"").trim(); const record=sessionIndex.get(id); if(!record) return false;
    deploymentCodes.delete(record.pairingId); sessionIndex.delete(record.sessionId);
    saveSessions(); console.log(`[SESSION DB] Deleted ${id}`); return true;
}

function cleanupExpiredSessions(){
    const now=Date.now(); let removed=0;
    for(const [pairingId, record] of deploymentCodes){
        if(record.used) continue;
        if(record.expiresAt && now > record.expiresAt + (24*60*60*1000)){
            deploymentCodes.delete(pairingId); sessionIndex.delete(record.sessionId); removed++;
        }
    }
    if(removed>0){ saveSessions(); console.log(`[SESSION DB] Removed ${removed} expired`); }
}

loadSessions();
setInterval(cleanupExpiredSessions, 60*1000).unref();

module.exports={
    generateAndSendSession, generateDeploymentCode, generateSessionId,
    verifyDeploymentCode, getSessionById, getDeploymentCodeStatus, getAllSessions,
    markSessionDeployed, updateSession, getRawSession, deleteDeploymentCode, deleteSessionById
};
