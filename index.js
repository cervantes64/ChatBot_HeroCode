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

// --- CONTEXTO DE CONVERSA ---
const CONTEXT_FILE = path.resolve(__dirname, "context.json")
let contextData = {}
if (fs.existsSync(CONTEXT_FILE)) {
    try {
        contextData = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"))
    } catch (e) {
        contextData = {}
    }
}
function saveContext() {
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(contextData, null, 2))
}
function cleanOldContexts() {
    const now = Date.now()
    let changed = false
    for (const jid in contextData) {
        if (now - contextData[jid].start > 24 * 60 * 60 * 1000) {
            delete contextData[jid]
            changed = true
        }
    }
    if (changed) saveContext()
}
function addToContext(jid, author, text) {
    const now = Date.now()
    if (!contextData[jid] || (now - contextData[jid].start > 24 * 60 * 60 * 1000)) {
        // Novo chat/contexto
        contextData[jid] = {
            start: now,
            history: []
        }
    }
    contextData[jid].history.push({ author, text, time: now })
    saveContext()
}
function clearContext(jid) {
    if (contextData[jid]) {
        delete contextData[jid]
        saveContext()
    }
}
function getContextPrompt(jid) {
    if (!contextData[jid]) return ""
    return contextData[jid].history.map(msg =>
        (msg.author === "user" ? "Usuário: " : "Bot: ") + msg.text
    ).join("\n")
}
// --- FIM CONTEXTO DE CONVERSA ---

async function askGemini(apiKey, prompt) {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey
    const res = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
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

// --- VARIAÇÕES DE MENSAGEM PARA NOVO USUÁRIO ---
const NEW_USER_GROUP_ID = "120363415263350673@g.us"
const NEW_USER_VARIATIONS = [
    "Você tem uma nova mensagem de [número de telefone]. Verifique, por favor.",
    "Mensagem recebida de [número de telefone] — favor conferir.",
    "Chegou uma nova mensagem: [número de telefone]. Verifique.",
    "[Número de telefone] enviou uma mensagem. Por gentileza, confira.",
    "Há uma nova mensagem do número [número de telefone]. Favor verificar.",
    "Nova notificação: mensagem de [número de telefone]. Verifique.",
    "Mensagem nova detectada de [número de telefone] — confira.",
    "Você recebeu uma nova mensagem de [número de telefone]. Favor verificar.",
    "Alerta: nova mensagem de [número de telefone]. Verifique agora.",
    "[número de telefone] mandou uma nova mensagem. Confira, por favor."
]
function getRandomNewUserMsg(phone) {
    const idx = Math.floor(Math.random() * NEW_USER_VARIATIONS.length)
    return NEW_USER_VARIATIONS[idx].replace(/\[número de telefone\]/gi, phone)
}

function jidToPhone(jid) {
    // Extrai só o número do formato "5511999999999@s.whatsapp.net"
    return jid.split("@")[0]
}

// AVISO NO GRUPO ao iniciar/finalizar o bot
async function notifyGroup(sock, text) {
    try {
        await sock.sendMessage(NEW_USER_GROUP_ID, { text })
    } catch (e) {
        console.error("Erro ao enviar aviso no grupo:", e)
    }
}

// Handler para garantir mensagem no grupo ao finalizar (Ctrl+C)
function setupGracefulShutdown(sock) {
    process.on("SIGINT", async () => {
        await notifyGroup(sock, "Bot finalizado!")
        process.exit(0)
    })
    process.on("SIGTERM", async () => {
        await notifyGroup(sock, "Bot finalizado!")
        process.exit(0)
    })
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
            // Envia aviso no grupo ao iniciar
            notifyGroup(sock, "Bot iniciado!")
            setupGracefulShutdown(sock)
        }
    })

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return
        const msg = messages[0]
        const jid = msg.key.remoteJid

        // IGNORA mensagens recebidas em grupo (NUNCA interage, nem contexto, nem Gemini, nem nada)
        if (!jid.endsWith("@s.whatsapp.net")) return

        cleanOldContexts() // limpa contextos vencidos

        const config = loadConfig()
        let blocklist = loadBlocklist()
        let users = loadUsers()
        const triggerWord = config.trigger_word || "MINGAU"

        // Se o número está bloqueado, não responde mais
        if (blocklist.includes(jid)) return

        // Ignora mensagens enviadas pelo próprio bot
        if (msg.key.fromMe) return

        const textMsg = msg.message?.conversation || ""

        // Checa se a palavra secreta foi dita (case insensitive)
        if (textMsg.toLowerCase().includes(triggerWord.toLowerCase())) {
            await sock.sendPresenceUpdate("composing", jid)
            await sock.sendMessage(jid, { text: "Aguarde um de nossos especialistas..." })
            blocklist.push(jid)
            saveBlocklist(blocklist)
            clearContext(jid)
            await sock.sendPresenceUpdate("unavailable", jid)
            return
        }

        // Se algum humano da equipe responder na conversa (exceto o cliente)
        if (msg.participant && msg.participant !== jid) {
            blocklist.push(jid)
            saveBlocklist(blocklist)
            clearContext(jid)
            console.log(`Bot desativado para o número: ${jid}, por intervenção humana.`)
            await sock.sendPresenceUpdate("unavailable", jid)
            return
        }

        // --- NOVO USUÁRIO: AVISO NO GRUPO, MAS SÓ EM CHAT PRIVADO ---
        const isFirst = !users.includes(jid)
        if (isFirst) {
            const phone = jidToPhone(jid)
            const aviso = getRandomNewUserMsg(phone)
            try {
                await sock.sendMessage(NEW_USER_GROUP_ID, { text: aviso })
            } catch (e) {
                console.error("Erro ao avisar no grupo:", e)
            }
        }

        // Integração com Gemini com CONTEXTO
        let resposta = "Desculpe, não consegui responder agora."
        try {
            // Monta contexto das últimas 24h daquele usuário
            addToContext(jid, "user", textMsg)
            const prompt = (config.gemini_prompt ? config.gemini_prompt + "\n" : "") + getContextPrompt(jid)
            resposta = await askGemini(config.gemini_api_key, prompt)
            addToContext(jid, "bot", resposta)
        } catch (e) {
            resposta = "Erro ao consultar Gemini."
        }

        // --- Remove todos os asteriscos da resposta antes de enviar ao cliente ---
        resposta = resposta.replace(/\*/g, "")

        // --- PRESENÇA HUMANIZADA ---
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
