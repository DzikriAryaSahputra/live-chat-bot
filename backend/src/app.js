require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const cheerio = require('cheerio');

// Modul CMS Bot
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

// Koneksi Database
const db = require('./config/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const port = process.env.PORT || 3000;

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

function chunkText(text, maxChars = 800) {
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
            chunks.push(currentChunk.join(' '));
            // Sisipkan sedikit kalimat sebelumnya (overlap ~15 kata) agar konteks tidak terputus
            const overlapWords = currentChunk.slice(-15);
            currentChunk = [...overlapWords];
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
    res.sendFile(path.join(PUBLIC_DIR, 'chatwidget.html'));
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

// Daftar Intent yang tidak bisa diubah/dihapus dari dashboard
const PROTECTED_INTENTS = [
    'greet', 'goodbye', 'affirm', 'deny', 'mood_great', 'trigger_alihkan_admin', 'cari_info_website',
    'hubungi_admin', 'teruskan_admin', 'tanya_admin'
];

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
                    // Ambil Top 6 chunks (agar AI tahu lebih banyak isi dari tengah ke bawah)
                    const topChunks = scoredChunks.slice(0, 6);
                    for (const chunk of topChunks) {
                        externalDocs += `\n\n--- DOKUMEN [${chunk.fileName}] (Relevansi: ${(chunk.score * 100).toFixed(1)}%) ---\n${chunk.text}`;
                    }
                }
            }
        }

        // Limit TOTAL pengetahuan agar tidak melampaui batas (dinaikkan ke 10000 agar muat 6 chunk)
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

async function generateLLMResponse(userMessage) {
    const knowledgeStr = await getKnowledgeBaseContext(userMessage);
    const systemPrompt = `Anda adalah Asisten Virtual BPS Kota Jambi bernama SISCA.
TUGAS UTAMA ANDA: Menjawab pertanyaan warga dengan cerdas, ramah, dan solutif HANYA berdasarkan informasi pada "DOKUMEN PENGETAHUAN BPS" (termasuk Dokumen Eksternal) di bawah ini.
DILARANG KERAS berhalusinasi atau memberikan informasi angka/fakta yang tidak tertulis pada dokumen di bawah ini.
Teks dari PDF terkadang "acak-acakan" (misal: "BPS me- naungi "). WAJIB BACALAH DENGAN SEKSAMA dan PERBAIKI TYPO DI KEPALA ANDA saat menjawab.
jawab dengan semaksimal mungkin.
jangan sisipkan nama file pdf.
Jika jawaban memang tidak tersedia sama sekali di dalam dokumen di bawah, katakan: "Maaf, SISCA belum dibekali jawaban terkait hal tersebut. Ketik 'bantuan' atau klik tombol 'Hubungi Admin' jika butuh bicara dengan petugas asli."

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
            if (!err && decoded.role === 'admin') {
                socket.data.isAdmin = true;
            }
        });
    }
    next();
});

io.on('connection', (socket) => {
    console.log(`🔌 User terhubung: ${socket.id} (Admin: ${socket.data.isAdmin})`);
    broadcastUserList();

    // 🔗 MENDAFTAR ROOM SAAT INisialisasi WIDGET (SANGAT PENTING AGAR CHAT ADMIN MASUK)
    socket.on('register_session', (data) => {
        if (data.senderId) {
            socket.join(data.senderId);
            console.log(`📡 Klien telah memasuki jaringan room: ${data.senderId}`);
            // Pancarkan ulang daftar, karena ada user yang baru online!
            broadcastUserList();
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
                await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'bot', botReply]);
                io.emit('receive_message', { senderId: senderId, message: botReply, senderType: 'bot' });

                if (botReply.toLowerCase().includes('meneruskan pesan')) {
                    activeSessions[senderId] = 'admin';
                }
                socket.emit('bot_response', { message: botReply });
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
            io.to(targetSenderId).emit('bot_response', { message: '✅ Sesi dengan petugas telah berakhir.' });
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

                // 👇 LANGSUNG KIRIM SINYAL SUKSES KE LAYAR ADMIN (Mencegah Loading Lama) 👇
                socket.emit('train_success', 'AI berhasil diverifikasi dan disinkronisasi!');

                // 👇 PROSES HOT-RELOAD BERJALAN DI BACKGROUND 👇
                try {
                    await axios.put('http://localhost:5005/model', { model_file: latestModelPath }, { timeout: 10000 });
                    console.log("✅ [RASA API] Model AI berhasil dimuat ulang (Hot-Reload) secara otomatis menggunakan file: " + path.basename(latestModelPath));
                } catch (e) {
                    console.log("⚠️ [RASA API] Gagal Hot-Reload otomatis. Bot mungkin perlu direstart manual. Error: " + e.message);
                }
            });
        } catch (err) { socket.emit('train_error', 'Gagal memproses file sistem.'); }
    });

    socket.on('disconnect', () => console.log(`🔌 Terputus: ${socket.id}`));
});

// ==========================================
// 🛡️ REST API ROUTES
// ==========================================

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } else { res.status(401).json({ error: 'Username/Password salah!' }); }
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
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml'); let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')) || { version: "3.1", nlu: [] };
        if (!nluData.nlu) nluData.nlu = []; nluData.nlu = nluData.nlu.filter(item => item.intent !== intentName);
        const formattedExamples = examples.split(/,|\n/).map(e => e.replace(/^-\s*/, '').trim()).filter(e => e.length > 0).map(e => `- ${e}`).join('\n') + '\n';
        nluData.nlu.push({ intent: intentName, examples: formattedExamples });
        fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));

        const domainPath = path.join(RASA_DIR, 'domain.yml'); let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        if (domainData) { if (!domainData.responses) domainData.responses = {}; domainData.responses[`utter_${intentName}`] = [{ text: botResponse }]; fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 })); }

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

        for (const chunk of chunks) {
            const vec = await generateEmbedding(chunk);
            if (vec) {
                existingEmbeddings.push({
                    txtFileName: fileName,
                    text: chunk,
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

app.get('/api/bot/token-usage', authenticateJWT, (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        let usageData = { date: today, groq: 0, gemini: 0 };
        if (fs.existsSync(TOKEN_USAGE_FILE)) {
            const raw = fs.readFileSync(TOKEN_USAGE_FILE, 'utf8');
            usageData = JSON.parse(raw);
            if (usageData.date !== today) usageData = { date: today, groq: 0, gemini: 0 };
        }
        res.json(usageData);
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

server.listen(port, () => console.log(`🚀 Server menyala di http://localhost:${port}`));