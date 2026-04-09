require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken'); // Modul Keamanan JWT

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

const RASA_DIR = path.join(__dirname, '../../rasa-bot'); 

// ==========================================
// 🔐 KONFIGURASI KEAMANAN & SISTEM
// ==========================================
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'rahasia_negara_bps_sangat_rahasia';

// 👇 DAFTAR INTENT YANG HARAM DISENTUH (TIDAK BISA DIHAPUS/DIEDIT) 👇
const PROTECTED_INTENTS = [
    'greet', 'goodbye', 'affirm', 'deny', 'mood_great', 'mood_unhappy', 'bot_challenge',
    'hubungi_admin', 'teruskan_admin', 'tanya_admin' // Sesuaikan jika ada nama intent admin lain
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

// 🛡️ Middleware Socket.io: Cek Tiket JWT
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

        try { await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'warga', message]); } catch (err) {}

        io.emit('receive_message', { senderId: senderId, message: message, senderType: 'warga' });
        broadcastUserList();

        // Cek apakah warga sedang ditangani admin
        if (activeSessions[senderId] === 'admin') return;

        // Jika tidak, lempar ke RASA AI
        try {
            const rasaResponse = await axios.post('http://localhost:5005/webhooks/rest/webhook', { sender: senderId, message: message });
            const botResponses = rasaResponse.data;
            
            if (botResponses && botResponses.length > 0) {
                const botReply = botResponses[0].text;
                await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'bot', botReply]);
                
                io.emit('receive_message', { senderId: senderId, message: botReply, senderType: 'bot' });

                // Deteksi otomatis intent "Hubungi Admin"
                if (botReply.includes('meneruskan pesan')) { 
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
        if (!socket.data.isAdmin) return; // 🛡️ Hanya admin sah yang boleh kirim pesan
        
        const { targetSenderId, message } = data;
        
        // Perintah rahasia admin untuk mengakhiri sesi
        if (message.trim() === '/selesai') {
            delete activeSessions[targetSenderId]; 
            io.to(targetSenderId).emit('bot_response', { message: '✅ Sesi dengan petugas telah berakhir. Anda kembali terhubung dengan Asisten Virtual.' });
            return; 
        }
        
        try { await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [targetSenderId, 'admin', message]); } catch (err) {}
        
        io.to(targetSenderId).emit('admin_response', { message });
    });

    // 🤖 ADMIN MELATIH BOT (SUNTIK ILMU)
    socket.on('train_bot', async (data) => {
        if (!socket.data.isAdmin) return socket.emit('train_error', '🛡️ Akses Ditolak! Anda tidak memiliki izin Admin.'); 
        
        const { intentName, examples, botResponse } = data;
        if (!intentName || !examples || !botResponse) return socket.emit('train_error', 'Data tidak boleh kosong!');

        const safeIntentName = intentName.trim().toLowerCase().replace(/\s+/g, '_');

        try {
            if (safeIntentName !== 'skip_write') {
                socket.emit('train_log', `🛠️ Menyuntikkan ilmu baru: [${safeIntentName}]\n`);

                // Update NLU
                const nluPath = path.join(RASA_DIR, 'data/nlu.yml');
                let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')) || { version: "3.1", nlu: [] };
                if (!nluData.nlu) nluData.nlu = [];
                nluData.nlu = nluData.nlu.filter(item => item.intent !== safeIntentName);
                const formattedExamples = examples.split(/,|\n/).map(e => e.replace(/^-\s*/, '').trim()).filter(e => e.length > 0).map(e => `- ${e}`).join('\n') + '\n';
                nluData.nlu.push({ intent: safeIntentName, examples: formattedExamples });
                fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));

                // Update Rules
                const rulesPath = path.join(RASA_DIR, 'data/rules.yml');
                let rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8')) || { version: "3.1", rules: [] };
                if (!rulesData.rules) rulesData.rules = [];
                rulesData.rules = rulesData.rules.filter(r => !(r.steps && r.steps.length > 0 && r.steps[0].intent === safeIntentName));
                rulesData.rules.push({ rule: `Rule otomatis untuk ${safeIntentName}`, steps: [{ intent: safeIntentName }, { action: `utter_${safeIntentName}` }] });
                fs.writeFileSync(rulesPath, yaml.dump(rulesData, { lineWidth: -1 }));

                // Update Domain
                const domainPath = path.join(RASA_DIR, 'domain.yml');
                let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8')) || { version: "3.1", intents: [], responses: {} };
                if (!domainData.intents) domainData.intents = [];
                if (!domainData.intents.includes(safeIntentName)) domainData.intents.push(safeIntentName);
                if (!domainData.responses) domainData.responses = {};
                domainData.responses[`utter_${safeIntentName}`] = [{ text: botResponse }];
                fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 }));

                socket.emit('train_log', '✅ File YAML berhasil diperbarui.\n');
            } else { 
                socket.emit('train_log', '⏩ Menyimpan sinkronisasi perubahan data...\n'); 
            }

            socket.emit('train_log', '⏳ Memulai proses Rasa Train (Bulletproof Mode)...\n-----------------------------------\n');

            const isWin = process.platform === "win32";
            const pythonPath = isWin ? 'venv\\Scripts\\python.exe' : 'venv/bin/python';
            const args = ['-m', 'rasa', 'train', '--force'];
            const trainProcess = spawn(pythonPath, args, { cwd: RASA_DIR });

            trainProcess.stdout.on('data', chunk => socket.emit('train_log', chunk.toString()));
            trainProcess.stderr.on('data', chunk => socket.emit('train_log', chunk.toString()));
            trainProcess.on('error', error => socket.emit('train_error', `❌ Gagal menjalankan mesin: ${error.message}`));

            trainProcess.on('close', async (code) => {
                if (code !== 0) return socket.emit('train_error', `\n❌ Proses terhenti dengan kode error ${code}`);
                socket.emit('train_log', '\n-----------------------------------\n✅ Training Selesai!\n🔄 Melakukan Hot-Reload AI...\n');
                
                // Pembersihan Model Lama
                try {
                    const modelsDir = path.join(RASA_DIR, 'models');
                    if (fs.existsSync(modelsDir)) {
                        const files = fs.readdirSync(modelsDir).filter(file => file.endsWith('.tar.gz'));
                        if (files.length > 2) {
                            files.sort().reverse(); 
                            const filesToDelete = files.slice(2);
                            filesToDelete.forEach(file => fs.unlinkSync(path.join(modelsDir, file)));
                            socket.emit('train_log', `🧹 Auto-cleanup: Membakar ${filesToDelete.length} model usang.\n`);
                        }
                    }
                } catch (cleanupError) {}

                // Hot-Reload API RASA
                try {
                    await axios.put('http://localhost:5005/model', { model_file: "models" });
                    socket.emit('train_success', 'Bot berhasil dilatih dan semakin pintar!');
                } catch (apiError) { 
                    socket.emit('train_success', 'Training sukses! Namun bot perlu di-restart manual.'); 
                }
            });
        } catch (err) { socket.emit('train_error', 'Terjadi kesalahan sistem saat memodifikasi file YAML.'); }
    });

    socket.on('disconnect', () => console.log(`🔌 User terputus: ${socket.id}`));
});

// ==========================================
// 🛡️ REST API ROUTES (HTTP)
// ==========================================

// 1. API Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Username atau password tidak terdaftar di sistem!' });
    }
});

// 2. Middleware Pengecekan JWT (Satpam REST API)
function authenticateJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader) {
        const token = authHeader.split(' ')[1]; 
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ error: 'Sesi berakhir, silakan login ulang.' });
            req.user = user;
            next();
        });
    } else { 
        res.status(401).json({ error: 'Akses ditolak. Token tidak ditemukan.' }); 
    }
}

// 3. API Ambil Semua Database Ilmu (Read-Only, Bebas Akses)
app.get('/api/bot/intents', (req, res) => {
    try {
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml'); const domainPath = path.join(RASA_DIR, 'domain.yml');
        const nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')); const domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        let knowledgeBase = [];
        if (nluData && nluData.nlu) {
            nluData.nlu.forEach(item => {
                if (item.intent) {
                    let responseText = '-'; const utterName = `utter_${item.intent}`;
                    if (domainData && domainData.responses && domainData.responses[utterName]) { responseText = domainData.responses[utterName][0].text; }
                    knowledgeBase.push({ intent: item.intent, examples: item.examples ? item.examples.trim() : '', response: responseText });
                }
            });
        }
        res.json(knowledgeBase);
    } catch (error) { res.status(500).json({ error: 'Gagal mengambil data' }); }
});

// 4. API Update Ilmu (Membutuhkan JWT & Dibatasi oleh Gembok)
app.put('/api/bot/intents', authenticateJWT, (req, res) => {
    const { intentName, examples, botResponse } = req.body;
    if (!intentName || !examples || !botResponse) return res.status(400).json({ error: 'Data kosong!' });
    
    // 🛡️ GEMBOK BACKEND: Tolak jika itu Intent Sistem Inti
    if (PROTECTED_INTENTS.includes(intentName)) {
        return res.status(403).json({ error: `Topik [${intentName}] dilindungi sistem. Hanya bisa diubah melalui source code!` });
    }

    try {
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml'); let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')) || { version: "3.1", nlu: [] };
        if (!nluData.nlu) nluData.nlu = []; nluData.nlu = nluData.nlu.filter(item => item.intent !== intentName);
        const formattedExamples = examples.split(/,|\n/).map(e => e.replace(/^-\s*/, '').trim()).filter(e => e.length > 0).map(e => `- ${e}`).join('\n') + '\n';
        nluData.nlu.push({ intent: intentName, examples: formattedExamples });
        fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));

        const domainPath = path.join(RASA_DIR, 'domain.yml'); let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        if (domainData) { if (!domainData.responses) domainData.responses = {}; domainData.responses[`utter_${intentName}`] = [{ text: botResponse }]; fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 })); }
        
        res.json({ message: `Topik '${intentName}' berhasil diperbarui!` });
    } catch (error) { res.status(500).json({ error: 'Gagal memperbarui file YAML' }); }
});

// 5. API Hapus Ilmu (Membutuhkan JWT & Dibatasi oleh Gembok)
app.delete('/api/bot/intents/:intentName', authenticateJWT, (req, res) => {
    const intentName = req.params.intentName;
    
    // 🛡️ GEMBOK BACKEND: Tolak jika itu Intent Sistem Inti
    if (PROTECTED_INTENTS.includes(intentName)) {
        return res.status(403).json({ error: `Topik [${intentName}] dilindungi sistem dan tidak boleh dihapus!` });
    }

    try {
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml'); let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8'));
        if(nluData && nluData.nlu) { nluData.nlu = nluData.nlu.filter(item => item.intent !== intentName); fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 })); }

        const rulesPath = path.join(RASA_DIR, 'data/rules.yml'); let rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8'));
        if(rulesData && rulesData.rules) { rulesData.rules = rulesData.rules.filter(r => !(r.steps && r.steps.length > 0 && r.steps[0].intent === intentName)); fs.writeFileSync(rulesPath, yaml.dump(rulesData, { lineWidth: -1 })); }

        const domainPath = path.join(RASA_DIR, 'domain.yml'); let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        if (domainData) { if (domainData.intents) domainData.intents = domainData.intents.filter(i => i !== intentName); if (domainData.responses && domainData.responses[`utter_${intentName}`]) delete domainData.responses[`utter_${intentName}`]; fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 })); }
        
        res.json({ message: `Topik '${intentName}' dihapus.` });
    } catch (error) { res.status(500).json({ error: 'Gagal menghapus file YAML' }); }
});

// 6. API Ambil Riwayat Chat
app.get('/api/chat/history/:senderId', async (req, res) => {
    try { 
        const result = await db.query('SELECT sender_type, message, created_at FROM chat_logs WHERE sender_id = $1 ORDER BY id ASC', [req.params.senderId]); 
        res.json(result.rows); 
    } catch (err) { res.status(500).json({ error: 'Gagal mengambil riwayat' }); }
});

// 7. API Hapus Riwayat Chat (Membutuhkan JWT)
app.delete('/api/chat/history/:senderId', authenticateJWT, async (req, res) => {
    try { 
        await db.query('DELETE FROM chat_logs WHERE sender_id = $1', [req.params.senderId]); 
        broadcastUserList(); 
        res.json({ message: 'Riwayat dihapus!' }); 
    } catch (err) { res.status(500).json({ error: 'Gagal menghapus' }); }
});

// Jalankan Server
server.listen(port, () => console.log(`🚀 Server berjalan di http://localhost:${port}`));