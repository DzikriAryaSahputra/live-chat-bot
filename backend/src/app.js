require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');

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
        io.emit('user_list', userList);
    } catch (err) {
        console.error('Gagal mengambil daftar user:', err.message);
    }
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

    // 💬 WARGA MENGIRIM PESAN
    socket.on('user_message', async (data) => {
        const { senderId, message } = data;
        socket.join(senderId);

        try { await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'warga', message]); } catch (err) { }

        io.emit('receive_message', { senderId: senderId, message: message, senderType: 'warga' });
        broadcastUserList();

        if (activeSessions[senderId] === 'admin') return;

        try {
            const rasaResponse = await axios.post('http://localhost:5005/webhooks/rest/webhook', { sender: senderId, message: message });
            const botResponses = rasaResponse.data;
            if (botResponses && botResponses.length > 0) {
                const botReply = botResponses[0].text;
                await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'bot', botReply]);
                io.emit('receive_message', { senderId: senderId, message: botReply, senderType: 'bot' });

                if (botReply.includes('meneruskan pesan')) { activeSessions[senderId] = 'admin'; }
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

server.listen(port, () => console.log(`🚀 Server menyala di http://localhost:${port}`));