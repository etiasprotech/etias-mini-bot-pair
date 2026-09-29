// ============================================================
// ETIAS-MINI-BOT PAIRING SERVER
// MULTI-FILE SESSION SYSTEM - TAR.GZ + BASE64
// ============================================================

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const P = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

// ============================================================
// CONFIG
// ============================================================

const app = express();

const PORT = Number(process.env.PORT || 3000);

const ROOT = __dirname;

const AUTH_DIR = path.join(ROOT, "auth");
const DATA_DIR = path.join(ROOT, "data");
const TEMP_DIR = path.join(ROOT, "temp_auth");

const DEPLOYED_FILE = path.join(DATA_DIR, "deployed.json");

const PREFIX = "ETIAS-MINI-BOT~";

const OWNER_NUMBER = (
    process.env.OWNER_NUMBER || "263778810589"
).replace(/[^0-9]/g, "");

const DEFAULT_DAYS = 30;

const ALLOWED_DAYS = [
    7,
    15,
    30,
    60,
    90,
    365
];

// ============================================================
// DIRECTORIES
// ============================================================

for (const dir of [
    AUTH_DIR,
    DATA_DIR,
    TEMP_DIR
]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true
        });
    }
}

// ============================================================
// EXPRESS
// ============================================================

app.use(express.json({
    limit: "25mb"
}));

app.use(express.urlencoded({
    extended: true,
    limit: "25mb"
}));

// ============================================================
// DATABASE FILE
// ============================================================

function readJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(file, "utf8")
        );
    } catch (e) {
        console.log(
            "[JSON READ ERROR]",
            file,
            e.message
        );

        return fallback;
    }
}

function writeJSON(file, data) {
    const temp = `${file}.tmp`;

    fs.writeFileSync(
        temp,
        JSON.stringify(data, null, 2),
        "utf8"
    );

    fs.renameSync(temp, file);
}

function getDeployed() {
    return readJSON(
        DEPLOYED_FILE,
        {}
    );
}

function saveDeployed(data) {
    writeJSON(
        DEPLOYED_FILE,
        data
    );
}

// ============================================================
// NUMBER HELPERS
// ============================================================

function normalizeNumber(value) {
    if (!value) return "";

    return String(value)
        .split(":")[0]
        .split("@")[0]
        .replace(/[^0-9]/g, "");
}

// ============================================================
// SAFE PATH
// ============================================================

function safeRelativePath(file) {
    const normalized = path.posix.normalize(
        String(file)
            .replace(/\\/g, "/")
    );

    if (
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.startsWith("/") ||
        normalized.includes("\0")
    ) {
        throw new Error(
            "Unsafe archive path"
        );
    }

    return normalized;
}

// ============================================================
// CREATE TAR.GZ SESSION
// ============================================================

function createSessionArchive(authPath) {

    if (!fs.existsSync(authPath)) {
        throw new Error(
            "Auth directory does not exist"
        );
    }

    const files = [];

    function walk(directory) {

        const entries = fs.readdirSync(
            directory,
            {
                withFileTypes: true
            }
        );

        for (const entry of entries) {

            const fullPath = path.join(
                directory,
                entry.name
            );

            if (entry.isDirectory()) {

                walk(fullPath);

            } else if (entry.isFile()) {

                files.push(
                    path.relative(
                        authPath,
                        fullPath
                    )
                );
            }
        }
    }

    walk(authPath);

    if (!files.includes("creds.json")) {
        throw new Error(
            "creds.json not found"
        );
    }

    /*
     * We create a temporary tar archive and then gzip it.
     *
     * tar is available on Termux/Linux/Render.
     */

    const tempName =
        `session-${crypto.randomBytes(8).toString("hex")}`;

    const tempTar = path.join(
        TEMP_DIR,
        `${tempName}.tar`
    );

    const tempGz = path.join(
        TEMP_DIR,
        `${tempName}.tar.gz`
    );

    try {

        execFileSync(
            "tar",
            [
                "-cf",
                tempTar,
                "-C",
                authPath,
                "."
            ],
            {
                stdio: "ignore"
            }
        );

        execFileSync(
            "gzip",
            [
                "-f",
                tempTar
            ],
            {
                stdio: "ignore"
            }
        );

        /*
         * gzip -f changes:
         *
         * file.tar
         *
         * into:
         *
         * file.tar.gz
         */

        const archive = fs.readFileSync(
            tempGz
        );

        return PREFIX + archive.toString(
            "base64"
        );

    } finally {

        try {
            fs.rmSync(
                tempTar,
                {
                    force: true
                }
            );
        } catch {}

        try {
            fs.rmSync(
                tempGz,
                {
                    force: true
                }
            );
        } catch {}
    }
}

// ============================================================
// VALIDATE SESSION ARCHIVE
// ============================================================

function decodeSessionArchive(session) {

    if (!session) {
        throw new Error(
            "Session is required"
        );
    }

    let clean = String(session)
        .trim()
        .replace(/\s/g, "");

    if (
        clean.startsWith(PREFIX)
    ) {
        clean = clean.slice(
            PREFIX.length
        );
    }

    if (!clean) {
        throw new Error(
            "Empty session"
        );
    }

    let compressed;

    try {

        compressed = Buffer.from(
            clean,
            "base64"
        );

    } catch {
        throw new Error(
            "Invalid base64 session"
        );
    }

    if (!compressed.length) {
        throw new Error(
            "Empty archive"
        );
    }

    let tarBuffer;

    try {

        tarBuffer = zlib.gunzipSync(
            compressed
        );

    } catch (e) {

        throw new Error(
            `Invalid GZIP archive: ${e.message}`
        );
    }

    if (!tarBuffer.length) {
        throw new Error(
            "Empty TAR archive"
        );
    }

    const tempTar = path.join(
        TEMP_DIR,
        `verify-${crypto.randomBytes(8).toString("hex")}.tar`
    );

    try {

        fs.writeFileSync(
            tempTar,
            tarBuffer
        );

        /*
         * List archive contents first.
         */

        const listing = execFileSync(
            "tar",
            [
                "-tf",
                tempTar
            ],
            {
                encoding: "utf8"
            }
        );

        const entries = listing
            .split("\n")
            .map(x => x.trim())
            .filter(Boolean);

        let hasCreds = false;

        for (const entry of entries) {

            const normalized =
                safeRelativePath(entry);

            if (
                normalized === "creds.json" ||
                normalized.endsWith("/creds.json")
            ) {
                hasCreds = true;
            }
        }

        if (!hasCreds) {
            throw new Error(
                "Session archive does not contain creds.json"
            );
        }

        return {
            tarBuffer,
            entries
        };

    } finally {

        try {
            fs.rmSync(
                tempTar,
                {
                    force: true
                }
            );
        } catch {}
    }
}

// ============================================================
// EXTRACT SESSION
// ============================================================

function restoreSessionArchive(
    session,
    destination
) {

    const decoded =
        decodeSessionArchive(session);

    const tempTar = path.join(
        TEMP_DIR,
        `restore-${crypto.randomBytes(8).toString("hex")}.tar`
    );

    try {

        fs.writeFileSync(
            tempTar,
            decoded.tarBuffer
        );

        /*
         * Validate every path again before extraction.
         */

        for (const entry of decoded.entries) {
            safeRelativePath(entry);
        }

        fs.rmSync(
            destination,
            {
                recursive: true,
                force: true
            }
        );

        fs.mkdirSync(
            destination,
            {
                recursive: true
            }
        );

        execFileSync(
            "tar",
            [
                "-xf",
                tempTar,
                "-C",
                destination
            ],
            {
                stdio: "ignore"
            }
        );

        const credsPath = path.join(
            destination,
            "creds.json"
        );

        if (!fs.existsSync(credsPath)) {
            throw new Error(
                "Restored session has no creds.json"
            );
        }

        return true;

    } finally {

        try {
            fs.rmSync(
                tempTar,
                {
                    force: true
                }
            );
        } catch {}
    }
}

// ============================================================
// READ SESSION ACCOUNT
// ============================================================

function getSessionAccount(authPath) {

    const credsPath = path.join(
        authPath,
        "creds.json"
    );

    if (!fs.existsSync(credsPath)) {
        throw new Error(
            "creds.json missing"
        );
    }

    const creds = JSON.parse(
        fs.readFileSync(
            credsPath,
            "utf8"
        )
    );

    const number =
        normalizeNumber(
            creds?.me?.id
        );

    return {
        number,
        registered: !!creds?.registered
    };
}

// ============================================================
// LOGGING
// ============================================================

function log(...args) {
    console.log(
        new Date().toISOString(),
        ...args
    );
}

// ============================================================
// ACTIVE PAIRING
// ============================================================

const pairingSockets = new Map();

const pairingLocks = new Map();

// ============================================================
// SEND LARGE SESSION
// ============================================================

async function sendSessionInChunks(
    sock,
    jid,
    session
) {

    /*
     * WhatsApp message limits mean we split
     * the archive into manageable chunks.
     */

    const chunkSize = 40000;

    const total = Math.ceil(
        session.length / chunkSize
    );

    await sock.sendMessage(
        jid,
        {
            text:
                `*ETIAS-MINI-BOT SESSION*\n\n` +
                `Session generated successfully.\n` +
                `Parts: ${total}\n\n` +
                `Combine the parts in order before deploying.`
        }
    );

    for (
        let i = 0;
        i < total;
        i++
    ) {

        const chunk =
            session.slice(
                i * chunkSize,
                (i + 1) * chunkSize
            );

        await sock.sendMessage(
            jid,
            {
                text:
                    `ETIAS-MINI-BOT~PART:${i + 1}/${total}\n\n` +
                    chunk
            }
        );

        await new Promise(
            resolve =>
                setTimeout(resolve, 700)
        );
    }

    await sock.sendMessage(
        jid,
        {
            text:
                `*SESSION COMPLETE*\n\n` +
                `Copy PART 1 through PART ${total} in order and combine them into one session string.`
        }
    );
}

// ============================================================
// PAIR NUMBER
// ============================================================

async function pairNumber(number) {

    const cleanNumber =
        normalizeNumber(number);

    if (
        cleanNumber.length < 8
    ) {
        throw new Error(
            "Invalid phone number"
        );
    }

    if (
        pairingLocks.has(cleanNumber)
    ) {
        throw new Error(
            "Pairing already in progress"
        );
    }

    pairingLocks.set(
        cleanNumber,
        true
    );

    const authPath =
        path.join(
            AUTH_DIR,
            `ETIAS_${cleanNumber}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`
        );

    fs.mkdirSync(
        authPath,
        {
            recursive: true
        }
    );

    try {

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            authPath
        );

        const sock =
            makeWASocket({
                auth: state,

                logger: Pino({
                    level: "silent"
                }),

                printQRInTerminal: false,

                browser: [
                    "ETIAS-MINI-BOT",
                    "Chrome",
                    "1.0.0"
                ],

                markOnlineOnConnect: false,

                syncFullHistory: false
            });

        pairingSockets.set(
            cleanNumber,
            {
                sock,
                authPath
            }
        );

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        /*
         * Request pairing code.
         */

        const code =
            await sock.requestPairingCode(
                cleanNumber
            );

        log(
            `[PAIRING CODE] ${cleanNumber}: ${code}`
        );

        sock.ev.on(
            "connection.update",
            async update => {

                const {
                    connection,
                    lastDisconnect
                } = update;

                if (
                    connection === "open"
                ) {

                    log(
                        `[PAIRED] ${cleanNumber}`
                    );

                    try {

                        /*
                         * Give creds.update time
                         * to finish writing files.
                         */

                        await new Promise(
                            resolve =>
                                setTimeout(
                                    resolve,
                                    1500
                                )
                        );

                        const account =
                            getSessionAccount(
                                authPath
                            );

                        if (
                            !account.registered
                        ) {

                            log(
                                `[PAIR WARNING] Session not registered`
                            );

                        }

                        const session =
                            createSessionArchive(
                                authPath
                            );

                        const deployed =
                            getDeployed();

                        deployed[
                            cleanNumber
                        ] = {
                            userNumber:
                                cleanNumber,

                            phone:
                                account.number ||
                                cleanNumber,

                            sessionId:
                                session,

                            days:
                                DEFAULT_DAYS,

                            createdAt:
                                Date.now(),

                            expiresAt:
                                Date.now() +
                                DEFAULT_DAYS *
                                24 *
                                60 *
                                60 *
                                1000
                        };

                        saveDeployed(
                            deployed
                        );

                        log(
                            `[SESSION SAVED] ${cleanNumber} length=${session.length}`
                        );

                        await sendSessionInChunks(
                            sock,
                            sock.user?.id ||
                                `${cleanNumber}@s.whatsapp.net`,
                            session
                        );

                    } catch (e) {

                        log(
                            `[SESSION ERROR]`,
                            e.message
                        );
                    }

                    /*
                     * Keep the auth directory.
                     * Do NOT delete it.
                     */

                    pairingSockets.delete(
                        cleanNumber
                    );

                    return;
                }

                if (
                    connection === "close"
                ) {

                    const code =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;

                    log(
                        `[PAIR CLOSED] ${cleanNumber} code=${code}`
                    );

                    pairingSockets.delete(
                        cleanNumber
                    );

                    /*
                     * 515 commonly happens after
                     * successful pairing because WhatsApp
                     * asks the client to restart.
                     *
                     * The credentials are already saved.
                     */

                    if (
                        code === 515
                    ) {

                        log(
                            `[PAIR] 515 received. Credentials should remain saved.`
                        );
                    }
                }
            }
        );

        return {
            code,
            authPath
        };

    } finally {

        pairingLocks.delete(
            cleanNumber
        );
    }
}

// ============================================================
// PAIR PAGE
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETIAS-MINI-BOT Pair</title>

<style>
body{
    margin:0;
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    background:#050816;
    color:#fff;
    font-family:Arial,sans-serif;
}
.card{
    width:min(450px,90%);
    background:#10172a;
    padding:30px;
    border-radius:20px;
    box-shadow:0 0 35px rgba(0,255,255,.2);
}
h1{
    text-align:center;
}
input,button{
    width:100%;
    box-sizing:border-box;
    padding:14px;
    margin-top:12px;
    border-radius:10px;
    border:0;
}
button{
    background:#00e5ff;
    color:#000;
    font-weight:bold;
    cursor:pointer;
}
#result{
    margin-top:20px;
    white-space:pre-wrap;
    word-break:break-word;
}
</style>
</head>

<body>

<div class="card">

<h1>ETIAS-MINI-BOT</h1>

<p>
Enter your WhatsApp number with country code.
</p>

<input
 id="number"
 placeholder="263778810589"
>

<button onclick="pair()">
GET PAIRING CODE
</button>

<div id="result"></div>

</div>

<script>

async function pair(){

    const number =
        document.getElementById("number").value.trim();

    if(!number){
        alert("Enter your WhatsApp number");
        return;
    }

    const result =
        document.getElementById("result");

    result.textContent =
        "Requesting pairing code...";

    try{

        const res =
            await fetch("/api/pair",{
                method:"POST",

                headers:{
                    "Content-Type":
                        "application/json"
                },

                body:JSON.stringify({
                    number
                })
            });

        const data =
            await res.json();

        if(!data.success){

            result.textContent =
                "❌ " + data.error;

            return;
        }

        result.textContent =
            "PAIRING CODE:\\n\\n" +
            data.code +
            "\\n\\nOpen WhatsApp → Linked Devices → Link a Device → Link with phone number and enter this code.";

    }catch(e){

        result.textContent =
            "❌ " + e.message;
    }
}

</script>

</body>
</html>
`);
    }
);

// ============================================================
// API PAIR
// ============================================================

app.post(
    "/api/pair",
    async (req, res) => {

        try {

            const number =
                normalizeNumber(
                    req.body.number
                );

            if (
                !number ||
                number.length < 8
            ) {

                return res.json({
                    success:false,
                    error:
                        "Invalid WhatsApp number"
                });
            }

            const result =
                await pairNumber(
                    number
                );

            res.json({
                success:true,
                code:result.code,
                number,
                message:
                    "Pairing code generated"
            });

        } catch (e) {

            console.log(
                "[PAIR ERROR]",
                e.message
            );

            res.json({
                success:false,
                error:e.message
            });
        }
    }
);

// ============================================================
// SESSION INFO
// ============================================================

app.get(
    "/api/session/:number",
    (req, res) => {

        const number =
            normalizeNumber(
                req.params.number
            );

        const deployed =
            getDeployed();

        const data =
            deployed[number];

        if (!data) {

            return res.json({
                success:false,
                error:
                    "Session not found"
            });
        }

        res.json({
            success:true,
            number:data.userNumber,
            days:data.days,
            createdAt:data.createdAt,
            expiresAt:data.expiresAt,
            sessionLength:
                data.sessionId?.length || 0
        });
    }
);

// ============================================================
// DEPLOYED SESSIONS
// ============================================================

app.get(
    "/api/sessions",
    (req, res) => {

        const deployed =
            getDeployed();

        const result =
            Object.values(deployed)
                .map(item => ({
                    userNumber:
                        item.userNumber,

                    phone:
                        item.phone,

                    days:
                        item.days,

                    createdAt:
                        item.createdAt,

                    expiresAt:
                        item.expiresAt,

                    sessionLength:
                        item.sessionId?.length || 0
                }));

        res.json({
            success:true,
            sessions:result
        });
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.json({
            status:"online",
            service:
                "ETIAS-MINI-BOT Pairing Server",
            sessions:
                Object.keys(
                    getDeployed()
                ).length
        });
    }
);

// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    () => {

        console.log("");
        console.log(
            "=========================================="
        );
        console.log(
            " ETIAS-MINI-BOT PAIRING SERVER"
        );
        console.log(
            "=========================================="
        );
        console.log(
            ` PORT: ${PORT}`
        );
        console.log(
            ` OWNER: ${OWNER_NUMBER}`
        );
        console.log(
            ` AUTH: ${AUTH_DIR}`
        );
        console.log(
            ` DATA: ${DATA_DIR}`
        );
        console.log(
            " SESSION: TAR.GZ + BASE64"
        );
        console.log(
            "=========================================="
        );
        console.log("");
    }
);
