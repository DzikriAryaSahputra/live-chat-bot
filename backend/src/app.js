require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');
const cron = require('node-cron');

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');

// Koneksi Database
const db = require('./config/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    // Naikkan timeout agar koneksi tidak putus saat LLM memproses PDF (bisa 30-60 detik)
    pingTimeout: 120000,   // 120 detik (default hanya 20 detik!)
    pingInterval: 30000,   // Ping setiap 30 detik
    transports: ['websocket', 'polling'], // Prioritaskan WebSocket
    upgradeTimeout: 30000,
});
const port = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false })); // Nonaktifkan CSP agar CDN (Tailwind/FontAwesome) tidak terblokir
app.use(cors());
app.use(express.json());

// ==========================================
// 📂 KONFIGURASI PATH FOLDER (backend/src/app.js)
// ==========================================
const RASA_DIR = path.join(__dirname, '../../rasa-bot');
const PUBLIC_DIR = path.join(__dirname, '../../frontend/public');
const PROTECTED_DIR = path.join(__dirname, '../../frontend/protected');
const KNOWLEDGE_DOCS_DIR = path.join(__dirname, '../knowledge_docs');
const UPLOADS_DIR = path.join(__dirname, '../uploads');
const TOKEN_USAGE_FILE = path.join(__dirname, '../token_usage.json');
const EMBEDDINGS_FILE = path.join(__dirname, '../knowledge_docs/embeddings.json');

// Pastikan folder dinamis otomatis terbuat jika belum ada di server
if (!fs.existsSync(KNOWLEDGE_DOCS_DIR)) fs.mkdirSync(KNOWLEDGE_DOCS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ==========================================
// 🧮 HELPER UNTUK TRUE RAG (MINI VECTOR DB)
// ==========================================
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0; let normA = 0; let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function chunkText(text, maxChars = 1500) {
    // 1. Rapihkan teks (hapus enter/spasi berlebih hasil ekstraksi PDF)
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const words = cleanText.split(' ');

    const chunks = [];
    let currentChunk = [];
    let currentLength = 0;

    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        
        // Jika menambahkan kata ini akan melebihi batas karakter
        if (currentLength + word.length > maxChars && currentChunk.length > 0) {
            // Smart Chunking: Coba cari tanda baca akhir kalimat (. ? !) di 30 kata terakhir
            let cutIndex = -1;
            for (let j = currentChunk.length - 1; j >= Math.max(0, currentChunk.length - 30); j--) {
                if (currentChunk[j].endsWith('.') || currentChunk[j].endsWith('?') || currentChunk[j].endsWith('!')) {
                    cutIndex = j;
                    break;
                }
            }

            if (cutIndex !== -1) {
                // Potong tepat setelah tanda baca akhir kalimat
                const actualChunk = currentChunk.slice(0, cutIndex + 1);
                chunks.push(actualChunk.join(' '));
                
                // Sisa kata dioper ke chunk berikutnya, ditambah overlap kalimat sebelumnya
                const leftover = currentChunk.slice(cutIndex + 1);
                const overlap = actualChunk.slice(-10); // 10 kata overlap untuk menjaga konteks
                currentChunk = [...overlap, ...leftover];
            } else {
                // Jika tidak ada tanda baca (teks berantakan), potong paksa
                chunks.push(currentChunk.join(' '));
                const overlapWords = currentChunk.slice(-15);
                currentChunk = [...overlapWords];
            }
            
            currentLength = currentChunk.join(' ').length;
        }
        
        currentChunk.push(word);
        currentLength += word.length + 1; // +1 untuk spasi
    }

    // Masukkan sisa kata terakhir
    if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(' '));
    }

    return chunks;
}

let embeddingExtractor = null;
async function getEmbeddingExtractor() {
    if (!embeddingExtractor) {
        console.log("⏳ Memuat model embedding lokal (Xenova/all-MiniLM-L6-v2)...");
        const { pipeline, env } = await import('@xenova/transformers');
        env.allowLocalModels = false;
        embeddingExtractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log("✅ Model embedding lokal berhasil dimuat!");
    }
    return embeddingExtractor;
}

async function generateEmbedding(text) {
    try {
        const extractor = await getEmbeddingExtractor();
        // Generate embedding secara offline di CPU (384 dimensi)
        const res = await extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(res.data);
    } catch (e) {
        console.error("Gagal generate embedding lokal:", e.message);
        return null;
    }
}

// Melayani file statis (CSS, JS, Gambar)
app.use(express.static(PUBLIC_DIR));

// ==========================================
// 🛤️ FRONTEND ROUTING (URL CANTIK)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(PROTECTED_DIR, 'admin.html'));
});

app.get('/error', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'error.html'));
});

// ==========================================
// 🔐 KONFIGURASI KEAMANAN & SISTEM
// ==========================================
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'rahasia_negara_bps_sangat_rahasia';

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

function getSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
    const defaultSettings = {
        admin: {
            username: ADMIN_USER,
            passwordHash: bcrypt.hashSync(ADMIN_PASS, 10)
        },
        liveChat: {
            isEmergencyLeave: false,
            startDay: 1,
            endDay: 5,
            startTime: '08:00',
            endTime: '16:00'
        }
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 4));
    return defaultSettings;
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
}

// Daftar Intent yang tidak bisa diubah/dihapus dari dashboard
const PROTECTED_INTENTS = [
    'greet', 'goodbye', 'affirm', 'deny', 'mood_great', 'trigger_alihkan_admin', 'cari_info_website',
    'hubungi_admin', 'teruskan_admin', 'tanya_admin'
];

const DASHBOARD_STATS_FILE = path.join(__dirname, '..', 'dashboard_stats.json');

function recordDashboardStat(responseTime, intentName) {
    try {
        let stats = { avgResponseTime: 0, responseCount: 0, topIntents: {} };
        if (fs.existsSync(DASHBOARD_STATS_FILE)) {
            stats = JSON.parse(fs.readFileSync(DASHBOARD_STATS_FILE, 'utf8'));
        }

        if (responseTime > 0) {
            stats.responseCount += 1;
            stats.avgResponseTime = ((stats.avgResponseTime * (stats.responseCount - 1)) + responseTime) / stats.responseCount;
        }

        if (intentName && intentName !== 'nlu_fallback') {
            stats.topIntents[intentName] = (stats.topIntents[intentName] || 0) + 1;
        }

        fs.writeFileSync(DASHBOARD_STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        console.error("Gagal mencatat statistik dashboard:", e.message);
    }
}

// ==========================================
// 🚫 FILTER KATA KASAR / PROMOSI (Khusus Nama)
// ==========================================
const TOXIC_WORDS = [
    'anjing', 'babi', 'monyet', 'bangsat', 'sialan', 'jancok', 'goblok', 'tolol', 'bego', 'bodoh',
    'judi', 'slot', 'gacor', 'poker', 'casino', 'zeus', 'maxwin', 'togel', 'pragmatic'
];

function sanitizeName(name) {
    if (!name) return null;
    const lowerName = name.toLowerCase();
    
    // Cek apakah nama mengandung kata-kata di daftar hitam
    for (const word of TOXIC_WORDS) {
        if (lowerName.includes(word)) {
            return "Warga Anonim"; // Paksa jadi Warga Anonim jika terdeteksi kotor/spam
        }
    }
    return name; // Jika aman, kembalikan nama asli
}

// ==========================================
// 📡 MANAJEMEN LIVE CHAT & SOCKET.IO
// ==========================================

async function broadcastUserList() {
    try {
        const users = await db.query('SELECT DISTINCT sender_id FROM chat_logs ORDER BY sender_id ASC');
        const userList = users.rows.map(row => row.sender_id);

        // Cek mana saja warga yang saat ini sedang 'Online' berdasarkan Room Socket yang aktif
        const onlineUsers = [];
        const rooms = io.sockets.adapter.rooms;
        userList.forEach(userId => {
            const room = rooms.get(userId);
            if (room && room.size > 0) {
                onlineUsers.push(userId);
            }
        });

        io.emit('user_list', { userList, onlineUsers });
    } catch (err) {
        console.error('Gagal mengambil daftar user:', err.message);
    }
}

// ==========================================
// 🧠 FUNGSI HYBRID RAG (GROQ & GEMINI FALLBACK)
// ==========================================
async function getKnowledgeBaseContext(userMessage) {
    try {
        const nluData = yaml.load(fs.readFileSync(path.join(RASA_DIR, 'data/nlu.yml'), 'utf8'));
        const domainData = yaml.load(fs.readFileSync(path.join(RASA_DIR, 'domain.yml'), 'utf8'));
        if (!nluData || !nluData.nlu) return '';

        let externalDocs = '';
        if (fs.existsSync(EMBEDDINGS_FILE) && userMessage) {
            const existingEmbeddings = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
            if (existingEmbeddings.length > 0) {
                const userVec = await generateEmbedding(userMessage);
                if (userVec) {
                    const scoredChunks = existingEmbeddings.map(e => ({
                        text: e.text,
                        fileName: e.txtFileName,
                        score: cosineSimilarity(userVec, e.vector)
                    }));
                    // Urutkan berdasarkan skor tertinggi
                    scoredChunks.sort((a, b) => b.score - a.score);
                    // Ambil Top 4 chunks (agar AI tahu isi dokumen tapi tidak menyentuh limit API gratis Groq/Gemini)
                    const topChunks = scoredChunks.slice(0, 4);
                    for (const chunk of topChunks) {
                        externalDocs += `\n\n--- DOKUMEN [${chunk.fileName}] (Relevansi: ${(chunk.score * 100).toFixed(1)}%) ---\n${chunk.text}`;
                    }
                }
            }
        }

        // Limit TOTAL pengetahuan agar tidak melampaui batas (diturunkan ke 10000 agar aman dari limit token)
        const combined = externalDocs;
        return combined.length > 10000 ? combined.substring(0, 10000) + "\n...[DIPOTONG KARENA LIMIT]" : combined;
    } catch (e) {
        console.error('Gagal membaca Knowledge Base untuk RAG:', e.message);
        return '';
    }
}

// Fungsi Pelacakan Token Harian
function trackTokenUsage(model, tokens) {
    try {
        const today = new Date().toISOString().split('T')[0];
        let usageData = { date: today, groq: 0, gemini: 0 };

        if (fs.existsSync(TOKEN_USAGE_FILE)) {
            const raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8');
            usageData = JSON.parse(raw);
            if (usageData.date !== today) {
                // Reset harian
                usageData = { date: today, groq: 0, gemini: 0 };
            }
        }

        if (model === 'groq') usageData.groq += tokens;
        if (model === 'gemini') usageData.gemini += tokens;

        fs.writeFileSync(TOKEN_USAGE_FILE, JSON.stringify(usageData, null, 2));
    } catch (err) {
        console.error("Gagal mencatat pemakaian token:", err.message);
    }
}

// Global API Status Tracker
let globalApiStatus = { groq: 'OK', gemini: 'OK' };
function triggerApiLimit(model) {
    globalApiStatus[model] = 'LIMIT';
    io.emit('api_status_update', globalApiStatus);
    setTimeout(() => {
        globalApiStatus[model] = 'OK';
        io.emit('api_status_update', globalApiStatus);
    }, 120000); // 120 detik (2 menit) auto-recovery
}

async function generateLLMResponse(userMessage) {
    const knowledgeStr = await getKnowledgeBaseContext(userMessage);
    const systemPrompt = `Anda adalah Asisten Virtual BPS Kota Jambi bernama BIPS (Bot Informasi Pelayanan Statistik).
TUGAS UTAMA ANDA: Menjawab pertanyaan warga dengan cerdas, ramah, dan solutif HANYA berdasarkan informasi pada "DOKUMEN PENGETAHUAN BPS" (termasuk Dokumen Eksternal) di bawah ini.
DILARANG KERAS berhalusinasi atau memberikan informasi angka/fakta yang tidak tertulis pada dokumen di bawah ini.
Teks dari PDF terkadang "acak-acakan" (misal: "BPS me- naungi "). WAJIB BACALAH DENGAN SEKSAMA dan PERBAIKI TYPO DI KEPALA ANDA saat menjawab.
jawab dengan semaksimal mungkin.
jangan sisipkan nama file pdf.
Jika jawaban memang tidak tersedia sama sekali di dalam dokumen di bawah, katakan: "Maaf, BIPS belum dibekali jawaban terkait hal tersebut. Ketik 'bantuan' atau klik tombol 'Hubungi Admin' jika butuh bicara dengan petugas asli."

=== DOKUMEN PENGETAHUAN BPS ===
${knowledgeStr}
===============================`;

    // 1. Coba Gunakan Groq API (Super Cepat)
    if (process.env.GROQ_API_KEY) {
        try {
            const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
                model: "llama-3.1-8b-instant",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
                temperature: 0.1, max_tokens: 500
            }, { headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 10000 });

            if (groqRes.data && groqRes.data.choices) {
                console.log("🤖 Respons RAG dikembalikan oleh: GROQ");
                if (groqRes.data.usage && groqRes.data.usage.total_tokens) {
                    trackTokenUsage('groq', groqRes.data.usage.total_tokens);
                }
                return groqRes.data.choices[0].message.content;
            }
        } catch (groqErr) {
            console.error("⚠️ Groq API gagal/limit:", groqErr.response ? groqErr.response.data : groqErr.message);
            if (groqErr.response && groqErr.response.status === 429) triggerApiLimit('groq');
        }
    }

    // 2. Fallback ke Gemini API (Kuat)
    if (process.env.GEMINI_API_KEY) {
        try {
            // Menggunakan gemini-2.0-flash (Versi 2.5 belum dirilis secara publik di endpoint v1beta)
            const geminiRes = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                contents: [{ parts: [{ text: systemPrompt + "\n\nPERTANYAAN WARGA: " + userMessage }] }]
            }, { timeout: 15000 });

            if (geminiRes.data && geminiRes.data.candidates) {
                console.log("🤖 Respons RAG dikembalikan oleh: GEMINI (Fallback)");
                if (geminiRes.data.usageMetadata && geminiRes.data.usageMetadata.totalTokenCount) {
                    trackTokenUsage('gemini', geminiRes.data.usageMetadata.totalTokenCount);
                }
                return geminiRes.data.candidates[0].content.parts[0].text;
            }
        } catch (geminiErr) {
            console.error("⚠️ Gemini API gagal:", geminiErr.response ? geminiErr.response.data : geminiErr.message);
            if (geminiErr.response && geminiErr.response.status === 429) triggerApiLimit('gemini');
        }
    }

    return "Maaf, sistem AI sedang mengalami kendala jaringan API. Mohon ketik 'bantuan' untuk menghubungi admin.";
}

let activeSessions = {};

// Middleware Socket.io: Verifikasi Token Admin
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    socket.data.isAdmin = false;
    
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) {
                return next(new Error('Authentication Error'));
            } else if (decoded.role === 'admin') {
                socket.data.isAdmin = true;
                return next();
            } else {
                return next();
            }
        });
    } else {
        // Klien warga biasa (tanpa token)
        next();
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 User terhubung: ${socket.id} (Admin: ${socket.data.isAdmin})`);
    broadcastUserList();

    socket.on('register_session', (data) => {
        if (data.senderId) {
            socket.join(data.senderId);
            console.log(`📡 Klien telah memasuki jaringan room: ${data.senderId}`);
            if (data.name) {
                const safeName = sanitizeName(data.name);
                io.emit('user_name_updated', { senderId: data.senderId, name: safeName });
            }
            // Pancarkan ulang daftar, karena ada user yang baru online!
            broadcastUserList();
        }
    });

    socket.on('set_user_name', (data) => {
        if (data.senderId && data.name) {
            const safeName = sanitizeName(data.name);
            io.emit('user_name_updated', { senderId: data.senderId, name: safeName });
        }
    });

    // 🔴 KETIKA USER TERPUTUS (OFFLINE)
    socket.on('disconnect', () => {
        // Beri delay sedikit agar status room adapter ke-update dengan matang sebelum broadcast
        setTimeout(() => { broadcastUserList(); }, 500);
    });

    // 💬 WARGA MENGIRIM PESAN
    socket.on('user_message', async (data) => {
        const { senderId, message } = data;
        socket.join(senderId);

        try { await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'warga', message]); } catch (err) { }

        io.emit('receive_message', { senderId: senderId, message: message, senderType: 'warga' });
        broadcastUserList();

        if (activeSessions[senderId] === 'admin') return;

        const processStartTime = Date.now();

        try {
            // 1. PARSE INTENT KE RASA UNTUK MELIHAT TINGKAT KEPERCAYAAN (CONFIDENCE)
            const parseRes = await axios.post('http://localhost:5005/model/parse', { text: message }, { timeout: 5000 });
            const intentName = parseRes.data.intent.name;
            const confidence = parseRes.data.intent.confidence;

            let botReply = "";

            // 2. JIKA CONFIDENCE >= 85% DAN BUKAN FALLBACK, BIARKAN RASA YANG MENJAWAB
            if (intentName !== 'nlu_fallback' && confidence >= 0.85) {
                const rasaResponse = await axios.post('http://localhost:5005/webhooks/rest/webhook', { sender: senderId, message: message }, { timeout: 5000 });
                if (rasaResponse.data && rasaResponse.data.length > 0) {
                    botReply = rasaResponse.data[0].text;
                }
            }

            // 3. JIKA RASA RAGU (< 85%), TEMBAKKAN KE HYBRID LLM (RAG)
            if (!botReply) {
                console.log(`🧠 Rasa NLP ragu (Intent: ${intentName}, Conf: ${(confidence * 100).toFixed(1)}%). Melempar ke LLM...`);
                botReply = await generateLLMResponse(message);
            }

            // 4. KIRIM JAWABAN KE WARGA
            if (botReply) {
                // FITUR 1: Cek Jam Operasional Admin Dinamis dari Settings
                if (botReply.toLowerCase().includes('meneruskan pesan')) {
                    const settings = getSettings().liveChat;
                    const now = new Date();
                    const currentHour = now.getHours();
                    const currentMinute = now.getMinutes();
                    const currentDay = now.getDay(); // 0: Minggu, 1: Senin, ..., 6: Sabtu

                    const startHour = parseInt(settings.startTime.split(':')[0]);
                    const startMin = parseInt(settings.startTime.split(':')[1]);
                    const endHour = parseInt(settings.endTime.split(':')[0]);
                    const endMin = parseInt(settings.endTime.split(':')[1]);

                    const isWithinDays = currentDay >= settings.startDay && currentDay <= settings.endDay;
                    const currentMinutesTotal = currentHour * 60 + currentMinute;
                    const startMinutesTotal = startHour * 60 + startMin;
                    const endMinutesTotal = endHour * 60 + endMin;
                    const isWithinHours = currentMinutesTotal >= startMinutesTotal && currentMinutesTotal <= endMinutesTotal;

                    if (!settings.isEmergencyLeave && isWithinDays && isWithinHours) {
                        activeSessions[senderId] = 'admin';
                    } else {
                        const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
                        if (settings.isEmergencyLeave) {
                            botReply = "Maaf, petugas layanan Live Chat BPS saat ini sedang tidak tersedia atau sedang libur.";
                        } else {
                            botReply = `Maaf, layanan Live Chat dengan petugas BPS hanya tersedia pada ${days[settings.startDay]} - ${days[settings.endDay]}, Pukul ${settings.startTime} - ${settings.endTime} WIB. Di luar jam tersebut, BIPS akan mencoba menjawabnya.`;
                        }
                    }
                }

                await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'bot', botReply]);
                io.emit('receive_message', { senderId: senderId, message: botReply, senderType: 'bot' });
                socket.emit('bot_response', { message: botReply });
                
                if (activeSessions[senderId] === 'admin') {
                    setTimeout(() => {
                        socket.emit('admin_status', { status: 'connected' });
                    }, 1500); // Jeda sedikit agar pesan bot selesai muncul
                }
                
                const processEndTime = Date.now();
                recordDashboardStat(processEndTime - processStartTime, intentName);
            }
        } catch (error) {
            socket.emit('bot_response', { message: 'Gagal menghubungi otak AI.' });
        }
    });

    // 👨‍💻 ADMIN MENGIRIM PESAN
    socket.on('admin_message', async (data) => {
        if (!socket.data.isAdmin) return;
        const { targetSenderId, message } = data;

        if (message.trim() === '/selesai') {
            delete activeSessions[targetSenderId];
            io.to(targetSenderId).emit('bot_response', { message: '✅ Sesi dengan petugas telah berakhir. BIPS kembali melayani Anda.' });
            io.to(targetSenderId).emit('admin_status', { status: 'disconnected' });
            return;
        }

        try { await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [targetSenderId, 'admin', message]); } catch (err) { }
        io.to(targetSenderId).emit('admin_response', { message });
    });

    // 🗑️ JALUR KHUSUS: WARGA MENGHAPUS CHAT-NYA SENDIRI
    socket.on('user_clear_chat', async (data) => {
        const { senderId } = data;
        if (!senderId) return;
        try {
            await db.query('DELETE FROM chat_logs WHERE sender_id = $1', [senderId]);
            if (activeSessions[senderId]) {
                delete activeSessions[senderId];
            }
            broadcastUserList();
        } catch (err) { console.error('Gagal hapus chat warga:', err); }
    });

    // 🤖 ADMIN MELATIH BOT (SUNTIK ILMU)
    socket.on('train_bot', async (data) => {
        if (!socket.data.isAdmin) return socket.emit('train_error', '🛡️ Akses Ditolak!');
        const { intentName, examples, botResponse } = data;
        if (!intentName || !examples || !botResponse) return socket.emit('train_error', 'Data tidak boleh kosong!');

        const safeIntentName = intentName.trim().toLowerCase().replace(/\s+/g, '_');

        try {
            if (safeIntentName !== 'skip_write') {
                const nluPath = path.join(RASA_DIR, 'data/nlu.yml');
                let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')) || { version: "3.1", nlu: [] };
                nluData.nlu = nluData.nlu.filter(item => item.intent !== safeIntentName);
                const formattedExamples = examples.split(/,|\n/).map(e => e.replace(/^-\s*/, '').trim()).filter(e => e.length > 0).map(e => `- ${e}`).join('\n') + '\n';
                nluData.nlu.push({ intent: safeIntentName, examples: formattedExamples });
                fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));

                const rulesPath = path.join(RASA_DIR, 'data/rules.yml');
                let rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8')) || { version: "3.1", rules: [] };
                rulesData.rules = rulesData.rules.filter(r => !(r.steps && r.steps.length > 0 && r.steps[0].intent === safeIntentName));
                rulesData.rules.push({ rule: `Rule untuk ${safeIntentName}`, steps: [{ intent: safeIntentName }, { action: `utter_${safeIntentName}` }] });
                fs.writeFileSync(rulesPath, yaml.dump(rulesData, { lineWidth: -1 }));

                const domainPath = path.join(RASA_DIR, 'domain.yml');
                let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8')) || { version: "3.1", intents: [], responses: {} };
                if (!domainData.intents.includes(safeIntentName)) domainData.intents.push(safeIntentName);
                if (!domainData.responses) domainData.responses = {};
                domainData.responses[`utter_${safeIntentName}`] = [{ text: botResponse }];
                fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 }));
            }

            // 👇 EKSEKUSI TRAINING 👇
            const isWin = process.platform === "win32";
            const pythonCmd = isWin ? 'venv\\Scripts\\python.exe' : 'venv/bin/python';

            const trainProcess = spawn(pythonCmd, ['-m', 'rasa', 'train', '--force'], {
                cwd: RASA_DIR,
                shell: true
            });

            // Log HANYA dicetak di Terminal VS Code, tidak lagi dikirim ke UI Dashboard
            trainProcess.stdout.on('data', chunk => {
                console.log(`[RASA LOG]: ${chunk.toString()}`);
            });

            // Mengubah pelabelan ERROR menjadi PROCESS agar log biasa tidak terlihat menakutkan
            trainProcess.stderr.on('data', chunk => {
                console.log(`[RASA PROCESS]: ${chunk.toString()}`);
            });

            trainProcess.on('close', async (code) => {
                if (code !== 0) {
                    return socket.emit('train_error', 'Gagal melatih AI. Cek terminal server.');
                }

                let latestModelPath = "models"; // Default fallback

                // 👇 PEMBERSIH MODEL OTOMATIS (Mencegah Penumpukan Sampah Model) 👇
                try {
                    const modelsDir = path.join(RASA_DIR, 'models');
                    if (fs.existsSync(modelsDir)) {
                        const files = fs.readdirSync(modelsDir)
                            .filter(f => f.endsWith('.tar.gz'))
                            .map(f => ({ name: f, fullPath: path.join(modelsDir, f), time: fs.statSync(path.join(modelsDir, f)).mtime.getTime() }))
                            .sort((a, b) => b.time - a.time); // Urutkan dari terbaru ke terlama

                        // Menangkap file model paling baru untuk digunakan di Hot Reload
                        if (files.length > 0) {
                            latestModelPath = files[0].fullPath;
                        }

                        // Jika ada lebih dari 3 file, hapus sisanya (index 3 dst)
                        if (files.length > 3) {
                            for (let i = 3; i < files.length; i++) {
                                fs.unlinkSync(files[i].fullPath);
                            }
                            console.log(`🧹 [CLEANUP] Menghapus ${files.length - 3} file model lama agar disk tidak penuh.`);
                        }
                    }
                } catch (cleanErr) {
                    console.error("⚠️ [CLEANUP] Gagal menghapus model lama:", cleanErr.message);
                }

                // 👇 PROSES HOT-RELOAD DAN TUNGGU SAMPAI SELESAI BARU EMIT SUKSES 👇
                try {
                    console.log("⚙️ [RASA API] Memulai Hot-Reload model baru...");
                    await axios.put('http://localhost:5005/model', { model_file: latestModelPath }, { timeout: 60000 });
                    console.log("✅ [RASA API] Model AI berhasil dimuat ulang (Hot-Reload) secara otomatis menggunakan file: " + path.basename(latestModelPath));
                    socket.emit('train_success', 'AI berhasil disinkronisasi dan siap digunakan!');
                } catch (e) {
                    console.log("⚠️ [RASA API] Gagal Hot-Reload otomatis. Bot mungkin perlu direstart manual. Error: " + e.message);
                    // Tetap beri sinyal sukses karena file model berhasil dilatih/dibuat, tapi sertakan catatan peringatan
                    socket.emit('train_success', 'AI berhasil dilatih, namun gagal memuat ulang otomatis (Hot-Reload). Silakan tunggu sebentar atau restart server bot.');
                }
            });
        } catch (err) { socket.emit('train_error', 'Gagal memproses file sistem.'); }
    });

    socket.on('disconnect', () => console.log(`🔌 Terputus: ${socket.id}`));
});

// ==========================================
// 🛡️ REST API ROUTES
// ==========================================

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 menit
    max: 10, // maksimal 10 percobaan per IP
    message: { error: 'Terlalu banyak percobaan login, silakan coba lagi dalam 15 menit.' }
});

app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    const settings = getSettings();
    if (username === settings.admin.username && bcrypt.compareSync(password, settings.admin.passwordHash)) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } else { res.status(401).json({ error: 'Username/Password salah!' }); }
});

app.get('/api/bot/settings', authenticateJWT, (req, res) => {
    const settings = getSettings();
    res.json({ admin: { username: settings.admin.username }, liveChat: settings.liveChat });
});

app.put('/api/bot/settings', authenticateJWT, (req, res) => {
    try {
        const { admin, liveChat } = req.body;
        const currentSettings = getSettings();
        
        if (admin) {
            if (admin.password) {
                if (!admin.oldPassword || !bcrypt.compareSync(admin.oldPassword, currentSettings.admin.passwordHash)) {
                    return res.status(401).json({ error: 'Sandi lama tidak cocok!' });
                }
                currentSettings.admin.passwordHash = bcrypt.hashSync(admin.password, 10);
            }
            if (admin.username) currentSettings.admin.username = admin.username;
        }
        if (liveChat) {
            currentSettings.liveChat = { ...currentSettings.liveChat, ...liveChat };
        }
        
        saveSettings(currentSettings);
        res.json({ message: 'Pengaturan berhasil disimpan!' });
    } catch (err) { res.status(500).json({ error: 'Gagal menyimpan pengaturan.' }); }
});

function authenticateJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const token = authHeader.split(' ')[1];
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ error: 'Sesi berakhir.' });
            req.user = user;
            next();
        });
    } else { res.status(401).json({ error: 'Akses ditolak.' }); }
}

app.get('/api/bot/intents', authenticateJWT, (req, res) => {
    try {
        const nluData = yaml.load(fs.readFileSync(path.join(RASA_DIR, 'data/nlu.yml'), 'utf8'));
        const domainData = yaml.load(fs.readFileSync(path.join(RASA_DIR, 'domain.yml'), 'utf8'));
        let knowledgeBase = nluData.nlu.map(item => {
            const utterName = `utter_${item.intent}`;
            return {
                intent: item.intent,
                examples: item.examples.trim(),
                response: (domainData.responses[utterName] ? domainData.responses[utterName][0].text : '-')
            };
        });
        res.json(knowledgeBase);
    } catch (error) { res.status(500).json({ error: 'Gagal ambil data' }); }
});

app.put('/api/bot/intents', authenticateJWT, (req, res) => {
    const { intentName, examples, botResponse } = req.body;
    if (PROTECTED_INTENTS.includes(intentName)) {
        return res.status(403).json({ error: 'Topik ini dilindungi sistem!' });
    }

    try {
        // 1. Update NLU
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml'); let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')) || { version: "3.1", nlu: [] };
        if (!nluData.nlu) nluData.nlu = []; nluData.nlu = nluData.nlu.filter(item => item.intent !== intentName);
        const formattedExamples = examples.split(/,|\n/).map(e => e.replace(/^-\s*/, '').trim()).filter(e => e.length > 0).map(e => `- ${e}`).join('\n') + '\n';
        nluData.nlu.push({ intent: intentName, examples: formattedExamples });
        fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));

        // 2. Update Rules (Ensure Rasa knows to trigger the response for this intent)
        const rulesPath = path.join(RASA_DIR, 'data/rules.yml'); let rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8')) || { version: "3.1", rules: [] };
        if (!rulesData.rules) rulesData.rules = [];
        // Filter out old rules for this intent to avoid duplicates
        rulesData.rules = rulesData.rules.filter(r => !(r.steps && r.steps.length > 0 && r.steps[0].intent === intentName));
        rulesData.rules.push({ rule: `Rule untuk ${intentName}`, steps: [{ intent: intentName }, { action: `utter_${intentName}` }] });
        fs.writeFileSync(rulesPath, yaml.dump(rulesData, { lineWidth: -1 }));

        // 3. Update Domain (Register the intent and its response)
        const domainPath = path.join(RASA_DIR, 'domain.yml'); let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8')) || { version: "3.1", intents: [], responses: {} };
        if (domainData) { 
            if (!domainData.intents) domainData.intents = [];
            if (!domainData.intents.includes(intentName)) {
                domainData.intents.push(intentName);
            }
            if (!domainData.responses) domainData.responses = {}; 
            domainData.responses[`utter_${intentName}`] = [{ text: botResponse }]; 
            fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 })); 
        }

        res.json({ message: 'Ilmu diperbarui!' });
    } catch (error) { res.status(500).json({ error: 'Gagal memperbarui file YAML' }); }
});

app.delete('/api/bot/intents/:intentName', authenticateJWT, (req, res) => {
    const intentName = req.params.intentName;
    if (PROTECTED_INTENTS.includes(intentName)) {
        return res.status(403).json({ error: 'Topik ini tidak boleh dihapus!' });
    }

    try {
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml'); let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8'));
        if (nluData && nluData.nlu) { nluData.nlu = nluData.nlu.filter(item => item.intent !== intentName); fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 })); }

        const rulesPath = path.join(RASA_DIR, 'data/rules.yml'); let rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8'));
        if (rulesData && rulesData.rules) { rulesData.rules = rulesData.rules.filter(r => !(r.steps && r.steps.length > 0 && r.steps[0].intent === intentName)); fs.writeFileSync(rulesPath, yaml.dump(rulesData, { lineWidth: -1 })); }

        const domainPath = path.join(RASA_DIR, 'domain.yml'); let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        if (domainData) { if (domainData.intents) domainData.intents = domainData.intents.filter(i => i !== intentName); if (domainData.responses && domainData.responses[`utter_${intentName}`]) delete domainData.responses[`utter_${intentName}`]; fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 })); }

        res.json({ message: 'Ilmu dihapus!' });
    } catch (error) { res.status(500).json({ error: 'Gagal menghapus file YAML' }); }
});

app.get('/api/chat/history/:senderId', async (req, res) => {
    try {
        const result = await db.query('SELECT sender_type, message, created_at FROM chat_logs WHERE sender_id = $1 ORDER BY id ASC', [req.params.senderId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Gagal mengambil riwayat' }); }
});

app.delete('/api/chat/history/:senderId', authenticateJWT, async (req, res) => {
    try {
        await db.query('DELETE FROM chat_logs WHERE sender_id = $1', [req.params.senderId]);
        broadcastUserList();
        res.json({ message: 'Riwayat dibersihkan!' });
    } catch (err) { res.status(500).json({ error: 'Gagal menghapus' }); }
});

// ==========================================
// 📚 RAG EXTERNAL KNOWLEDGE (PDF & URL) ROUTES
// ==========================================

const upload = multer({ dest: 'uploads/' });

app.post('/api/bot/upload-pdf', authenticateJWT, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });
    try {
        const dataBuffer = fs.readFileSync(req.file.path);
        const data = await pdfParse(dataBuffer);

        // Bersihkan teks agar rapih (menghapus enter/spasi ganda yang berantakan dari PDF)
        const cleanText = data.text.replace(/\s+/g, ' ').replace(/\s+([.,?!])/g, '$1').trim();
        const rawText = cleanText;

        if (!rawText) throw new Error('PDF kosong atau tidak dapat terbaca teksnya.');

        const fileName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_') + '.txt';
        const safePath = path.join(KNOWLEDGE_DOCS_DIR, fileName);

        if (!fs.existsSync(KNOWLEDGE_DOCS_DIR)) fs.mkdirSync(KNOWLEDGE_DOCS_DIR);
        fs.writeFileSync(safePath, `[SUMBER: ${req.file.originalname}]\n\n${rawText}`);
        fs.unlinkSync(req.file.path); // Hapus file temporary

        // === PROSES TRUE RAG: CHUNKING & EMBEDDING ===
        const chunks = chunkText(rawText);
        let existingEmbeddings = [];
        if (fs.existsSync(EMBEDDINGS_FILE)) {
            existingEmbeddings = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
        }

        // Buat judul natural dari nama file PDF (hilangkan ekstensi dan ubah tanda pisah jadi spasi)
        const docTitle = req.file.originalname.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');

        for (const chunk of chunks) {
            // RAG Metadata Injection: Menyuntikkan judul dokumen ke setiap potongan teks
            const contextChunk = `[Dokumen: ${docTitle}]\n${chunk}`;
            const vec = await generateEmbedding(contextChunk);
            if (vec) {
                existingEmbeddings.push({
                    txtFileName: fileName,
                    text: contextChunk,
                    vector: vec
                });
            }
        }
        fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(existingEmbeddings));
        // ===========================================

        res.json({ message: 'PDF berhasil disuntikkan ke otak bot!' });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Gagal mengekstrak teks PDF: ' + err.message });
    }
});



app.get('/api/bot/docs', authenticateJWT, (req, res) => {
    try {
        if (!fs.existsSync(KNOWLEDGE_DOCS_DIR)) return res.json([]);
        const files = fs.readdirSync(KNOWLEDGE_DOCS_DIR).filter(f => f.endsWith('.txt'));
        const docs = files.map(f => {
            const stats = fs.statSync(path.join(KNOWLEDGE_DOCS_DIR, f));
            return { filename: f.replace('.txt', ''), size: (stats.size / 1024).toFixed(1) + ' KB', date: stats.mtime };
        });
        res.json(docs);
    } catch (err) { res.status(500).json({ error: 'Gagal mengambil daftar dokumen.' }); }
});

app.get('/api/bot/docs/:filename', authenticateJWT, (req, res) => {
    try {
        // Sanitasi input: path.basename akan menghilangkan path traversal seperti ../../../
        const safeFilename = path.basename(req.params.filename);
        if (!safeFilename) return res.status(400).json({ error: 'Nama file tidak valid.' });
        
        const fullPath = path.join(KNOWLEDGE_DOCS_DIR, safeFilename + '.txt');
        
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'Dokumen tidak ditemukan.' });
        }
        
        const content = fs.readFileSync(fullPath, 'utf8');
        res.json({ filename: safeFilename, content: content });
    } catch (err) {
        console.error("Gagal membaca dokumen:", err);
        res.status(500).json({ error: 'Terjadi kesalahan saat membaca dokumen.' });
    }
});

app.get('/api/bot/token-usage', authenticateJWT, (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        let usageData = { date: today, groq: 0, gemini: 0 };
        if (fs.existsSync(TOKEN_USAGE_FILE)) {
            const raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8');
            usageData = JSON.parse(raw);
            if (usageData.date !== today) usageData = { date: today, groq: 0, gemini: 0 };
        }
        res.json({ ...usageData, apiStatus: globalApiStatus });
    } catch (err) {
        res.status(500).json({ error: 'Gagal mengambil data penggunaan token.' });
    }
});

app.delete('/api/bot/docs/:filename', authenticateJWT, (req, res) => {
    try {
        const targetFilename = req.params.filename.endsWith('.txt') ? req.params.filename : req.params.filename + '.txt';
        const safePath = path.join(KNOWLEDGE_DOCS_DIR, targetFilename);
        if (fs.existsSync(safePath)) {
            fs.unlinkSync(safePath);

            // Hapus juga vektor dari embeddings.json
            if (fs.existsSync(EMBEDDINGS_FILE)) {
                let existingEmbeddings = JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
                existingEmbeddings = existingEmbeddings.filter(e => e.txtFileName !== targetFilename);
                fs.writeFileSync(EMBEDDINGS_FILE, JSON.stringify(existingEmbeddings));
            }

            res.json({ message: 'Dokumen dilupakan.' });
        } else {
            res.status(404).json({ error: 'Dokumen tidak ditemukan.' });
        }
    } catch (err) { res.status(500).json({ error: 'Gagal menghapus dokumen.' }); }
});

// ==========================================
// 📊 DASHBOARD STATS ROUTE
// ==========================================
app.get('/api/bot/dashboard-stats', authenticateJWT, async (req, res) => {
    try {
        // 1. Total Warga Hari Ini
        const wargaTodayRes = await db.query(`SELECT COUNT(DISTINCT sender_id) AS total FROM chat_logs WHERE created_at >= CURRENT_DATE AND sender_type = 'warga'`);
        const totalWargaToday = parseInt(wargaTodayRes.rows[0].total) || 0;

        // 2. Deflection Rate (AI Resolution)
        const wargaAdminRes = await db.query(`
            SELECT COUNT(DISTINCT sender_id) AS total_admin_handled
            FROM chat_logs 
            WHERE created_at >= CURRENT_DATE AND 
            (sender_type = 'admin' OR (sender_type = 'bot' AND message ILIKE '%meneruskan pesan%'))
        `);
        const totalWargaAdmin = parseInt(wargaAdminRes.rows[0].total_admin_handled) || 0;
        
        let aiResolutionRate = 100;
        if (totalWargaToday > 0) {
            const aiHandled = totalWargaToday - totalWargaAdmin;
            aiResolutionRate = Math.round((aiHandled / totalWargaToday) * 100);
        }

        // 3. Peak Hours (Jam Sibuk Hari Ini)
        const peakHoursRes = await db.query(`
            SELECT EXTRACT(HOUR FROM created_at) AS jam, COUNT(*) AS jumlah
            FROM chat_logs
            WHERE created_at >= CURRENT_DATE AND sender_type = 'warga'
            GROUP BY jam
            ORDER BY jam ASC
        `);
        
        let hourlyData = Array(24).fill(0);
        peakHoursRes.rows.forEach(row => {
            hourlyData[row.jam] = parseInt(row.jumlah);
        });

        // 4. Token Usage
        let tokenUsage = { groq: 0, gemini: 0 };
        try {
            if (fs.existsSync(TOKEN_USAGE_FILE)) {
                const raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8');
                const parsed = JSON.parse(raw);
                const today = new Date().toISOString().split('T')[0];
                if (parsed.date === today) {
                    tokenUsage = { groq: parsed.groq, gemini: parsed.gemini };
                }
            }
        } catch (e) {}

        // 5. Recent Questions (5 latest)
        const recentQuestionsRes = await db.query(`
            SELECT sender_id, message, created_at 
            FROM chat_logs 
            WHERE sender_type = 'warga' 
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        
        // 6. Top Intents & Avg Response Time
        let extraStats = { avgResponseTime: 0, topIntents: [] };
        try {
            if (fs.existsSync(DASHBOARD_STATS_FILE)) {
                const raw = JSON.parse(fs.readFileSync(DASHBOARD_STATS_FILE, 'utf8'));
                
                // Convert topIntents object to sorted array
                const intentArr = Object.entries(raw.topIntents || {}).map(([intent, count]) => ({ intent, count }));
                intentArr.sort((a, b) => b.count - a.count);
                
                extraStats.avgResponseTime = Math.round(raw.avgResponseTime || 0);
                extraStats.topIntents = intentArr.slice(0, 5); // top 5
            }
        } catch(e) {}

        res.json({
            totalWargaToday,
            aiResolutionRate,
            hourlyData,
            tokenUsage,
            recentQuestions: recentQuestionsRes.rows,
            avgResponseTime: extraStats.avgResponseTime,
            topIntents: extraStats.topIntents
        });

    } catch (err) {
        console.error('Error fetching dashboard stats:', err);
        res.status(500).json({ error: 'Gagal memuat statistik dashboard.' });
    }
});

// ==========================================
// 🧹 CRON JOBS (TUGAS OTOMATIS)
// ==========================================

// Hapus riwayat obrolan yang usianya lebih dari 30 hari (Berjalan setiap hari jam 02:00 AM)
cron.schedule('0 2 * * *', async () => {
    try {
        const result = await db.query(`DELETE FROM chat_logs WHERE created_at < NOW() - INTERVAL '30 days'`);
        if (result.rowCount > 0) {
            console.log(`🧹 [CRON] Menghapus ${result.rowCount} riwayat chat yang sudah kedaluwarsa (>30 hari).`);
            broadcastUserList();
        }
    } catch (err) {
        console.error('❌ [CRON] Gagal menghapus riwayat chat lama:', err.message);
    }
});

server.listen(port, () => console.log(`🚀 Server menyala di http://localhost:${port}`));