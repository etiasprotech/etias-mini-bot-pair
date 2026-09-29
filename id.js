"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DEPLOYED_FILE = path.join(DATA_DIR, "deployed.json");

const pairings = new Map();

function generatePairingId() {
    return crypto.randomBytes(8).toString("hex");
}

function generateUserId() {
    return crypto.randomBytes(6).toString("hex");
}

function createPairing(number) {
    const id = generatePairingId();

    const data = {
        id,
        number,
        status: "starting",
        connected: false,
        sent: false,
        pairingCode: null,
        qr: null,
        sessionId: null,
        jid: null,
        authFolder: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    pairings.set(id, data);

    return data;
}

function getPairing(id) {
    return pairings.get(id) || null;
}

function updatePairing(id, updates) {
    const current = pairings.get(id);

    if (!current) {
        return null;
    }

    const updated = {
        ...current,
        ...updates,
        updatedAt: new Date().toISOString()
    };

    pairings.set(id, updated);

    return updated;
}

function deletePairing(id) {
    return pairings.delete(id);
}

function getAllPairings() {
    return Array.from(pairings.values());
}

async function ensureDataDir() {
    await fsp.mkdir(DATA_DIR, {
        recursive: true
    });

    if (!fs.existsSync(DEPLOYED_FILE)) {
        await fsp.writeFile(
            DEPLOYED_FILE,
            "[]",
            "utf8"
        );
    }
}

async function loadDeployed() {
    await ensureDataDir();

    try {
        const raw = await fsp.readFile(
            DEPLOYED_FILE,
            "utf8"
        );

        if (!raw.trim()) {
            return [];
        }

        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
            return parsed;
        }

        if (
            parsed &&
            Array.isArray(parsed.users)
        ) {
            return parsed.users;
        }

        if (
            parsed &&
            Array.isArray(parsed.deployed)
        ) {
            return parsed.deployed;
        }

        /*
         * Supports an older deployed.json containing
         * one deployment object.
         */
        if (
            parsed &&
            typeof parsed === "object" &&
            (
                parsed.sessionId ||
                parsed.pairingId ||
                parsed.number ||
                parsed.jid
            )
        ) {
            return [parsed];
        }

        return [];
    } catch (error) {
        console.error(
            "[DATA] Failed reading deployed.json:",
            error.message
        );

        return [];
    }
}

async function saveDeployed(users) {
    await ensureDataDir();

    if (!Array.isArray(users)) {
        users = [];
    }

    const tempFile =
        `${DEPLOYED_FILE}.tmp`;

    await fsp.writeFile(
        tempFile,
        JSON.stringify(users, null, 2),
        "utf8"
    );

    await fsp.rename(
        tempFile,
        DEPLOYED_FILE
    );
}

async function addDeployedUser(entry) {
    try {
        const users = await loadDeployed();

        const index = users.findIndex(
            item =>
                item &&
                (
                    item.pairingId === entry.pairingId ||
                    item.jid === entry.jid
                )
        );

        if (index >= 0) {
            users[index] = {
                ...users[index],
                ...entry
            };
        } else {
            users.push(entry);
        }

        await saveDeployed(users);

        console.log(
            `[DATA] Deployment saved: ${entry.pairingId}`
        );

        return true;
    } catch (error) {
        /*
         * Database errors must NEVER stop the
         * WhatsApp session delivery.
         */
        console.error(
            "[DATA] Deployment save failed:",
            error.message
        );

        return false;
    }
}

module.exports = {
    generatePairingId,
    generateUserId,
    createPairing,
    getPairing,
    updatePairing,
    deletePairing,
    getAllPairings,
    loadDeployed,
    saveDeployed,
    addDeployedUser
};
