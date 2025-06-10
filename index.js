const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const qrcode = require("qrcode-terminal")
const path = require("path")
const fs = require("fs")
const axios = require("axios")

function loadConfig() {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, "config.json")))
}
function loadBlocklist() {
    const file = path.resolve(__dirname, "blocklist.json")
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]")
    return JSON.parse(fs.readFileSync(file))
}
function saveBlocklist(list) {
    fs.writeFileSync(path.resolve(__dirname, "blocklist.json"), JSON.stringify(list, null, 2))
}
function loadUsers() {
    const file = path.resolve(__dirname, "users.json")
    if (!fs.existsSync(file)) fs.writeFileSync(file, "[]")
    return JSON.parse(fs.readFileSync(file))
}
function saveUsers(list) {
    fs.writeFileSync(path.resolve(__dirname, "users.json"), JSON.stringify(list, null, 2))
}

async function askGemini(apiKey, prompt, userMsg) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey
    const res = await axios.post(url, {
        contents: [{ parts: [{ text: prompt + "\n\nUsuário: " + userMsg }] }]
    })
    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "Desculpe, não consegui responder agora."
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function showPresenceSequence(sock, jid, sequence) {
    for (const step of sequence) {
        if (step.type === "available") {
            await sock.sendPresenceUpdate("available", jid)
        } else if (step.type === "composing") {
            await sock.sendPresenceUpdate("composing", jid)
        } else if (step.type === "unavailable") {
            await sock.sendPresenceUpdate("unavailable", jid)
        }
        await delay(step.time)
    }
}

async function replyWithPresence(sock, jid, resposta, presencePlan) {
    try {
        await showPresenceSequence(sock, jid, presencePlan)
        await sock.sendMessage(jid, { text: resposta })
        await sock.sendPresenceUpdate("available", jid)
        await delay(5000)
    } finally {
        await sock.sendPresenceUpdate("unavailable", jid)
    }
}

async function startBot() {
    const authFolder = path.resolve(__dirname, "auth_info")
    const { state, saveCreds } = await useMultiFileAuthState(authFolder)
    const { version } = await fetchLatestBaileysVersion()
    const sock = makeWASocket({ version, auth: state })

    sock.ev.on("creds.update", saveCreds)
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) qrcode.generate(qr, { small: true })
        if (connection === "close") {
            const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
            if (shouldReconnect) startBot()
        } else if (connection === "open") {
            console.log("Conexão estabelecida com sucesso!")
        }
    })

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return
        const msg = messages[0]
        const jid = msg.key.remoteJid

        const config = loadConfig()
        let blocklist = loadBlocklist()
        let users = loadUsers()
        const triggerWord = config.trigger_word || "MINGAU"

        // Se o número está bloqueado, não responde mais
        if (blocklist.includes(jid)) return

        // Ignora mensagens enviadas pelo próprio bot
        if (msg.key.fromMe) return

        // Checa se a palavra secreta foi dita (case insensitive)
        const textMsg = msg.message?.conversation || ""
        if (textMsg.toLowerCase().includes(triggerWord.toLowerCase())) {
            await sock.sendPresenceUpdate("composing", jid)
            await sock.sendMessage(jid, { text: "Aguarde um de nossos especialistas..." })
            blocklist.push(jid)
            saveBlocklist(blocklist)
            await sock.sendPresenceUpdate("unavailable", jid)
            return
        }

        // Se algum humano da equipe responder na conversa (exceto o cliente)
        if (msg.participant && msg.participant !== jid) {
            blocklist.push(jid)
            saveBlocklist(blocklist)
            console.log(`Bot desativado para o número: ${jid}, por intervenção humana.`)
            await sock.sendPresenceUpdate("unavailable", jid)
            return
        }

        // Integração com Gemini
        let resposta = "Desculpe, não consegui responder agora."
        try {
            resposta = await askGemini(config.gemini_api_key, config.gemini_prompt, textMsg)
        } catch (e) {
            resposta = "Erro ao consultar Gemini."
        }

        // --- PRESENÇA HUMANIZADA ---
        const isFirst = !users.includes(jid)
        if (isFirst) {
            await delay(15000) // Espera 15s sem presença
            users.push(jid)
            saveUsers(users)
            // 5s online -> 5s digitando -> 5s online
            await replyWithPresence(sock, jid, resposta, [
                { type: "available", time: 5000 },
                { type: "composing", time: 5000 },
                { type: "available", time: 5000 }
            ])
            return
        }

        // Demais interações
        const shortThreshold = 80
        let typingTime = 2000 // padrão 2s
        if (resposta.length <= shortThreshold) {
            typingTime = 1500 + Math.floor(Math.random() * 500) // 1.5 a 2s
        } else if (resposta.length <= 250) {
            typingTime = 3500 + Math.floor(Math.random() * 1000) // 3.5 a 4.5s
        } else {
            typingTime = 5000 + Math.floor(Math.random() * 2000) // 5 a 7s
        }
        // 5s online -> digitando -> 5s online
        await replyWithPresence(sock, jid, resposta, [
            { type: "available", time: 5000 },
            { type: "composing", time: typingTime },
            { type: "available", time: 5000 }
        ])
    })
}

startBot()