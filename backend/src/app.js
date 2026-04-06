require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

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

io.on('connection', (socket) => {
    console.log(`🔌 User terhubung: ${socket.id}`);
    broadcastUserList();

    socket.on('user_message', async (data) => {
        const { senderId, message } = data;
        socket.join(senderId);

        try {
            await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'warga', message]);
        } catch (err) { console.error('Gagal simpan db:', err.message); }

        io.emit('receive_message', { senderId: senderId, message: message, senderType: 'warga' });
        broadcastUserList();

        if (activeSessions[senderId] === 'admin') return;

        try {
            const rasaResponse = await axios.post('http://localhost:5005/webhooks/rest/webhook', {
                sender: senderId, message: message
            });

            const botResponses = rasaResponse.data;
            if (botResponses && botResponses.length > 0) {
                const botReply = botResponses[0].text;
                await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'bot', botReply]);
                io.emit('receive_message', { senderId: senderId, message: botReply, senderType: 'bot' });

                if (botReply.includes('meneruskan pesan Anda ke petugas')) {
                    activeSessions[senderId] = 'admin';
                }
                socket.emit('bot_response', { message: botReply });
            }
        } catch (error) {
            console.error('❌ Error Rasa:', error.message);
            socket.emit('bot_response', { message: 'Gagal menghubungi otak AI.' });
        }
    });

    socket.on('admin_message', async (data) => {
        const { targetSenderId, message } = data;
        if (message.trim() === '/selesai') {
            delete activeSessions[targetSenderId]; 
            io.to(targetSenderId).emit('bot_response', { message: '✅ Sesi dengan petugas telah berakhir. Anda kembali terhubung dengan Asisten Virtual.' });
            return; 
        }
        try {
            await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [targetSenderId, 'admin', message]);
        } catch (err) { console.error('Gagal simpan db:', err.message); }
        io.to(targetSenderId).emit('admin_response', { message });
    });

    // ==========================================
    // FITUR CMS: TAMBAH DATA & LIVE TRAINING 
    // ==========================================
    socket.on('train_bot', async (data) => {
        const { intentName, examples, botResponse } = data;

        if (!intentName || !examples || !botResponse) {
            return socket.emit('train_error', 'Data tidak boleh kosong!');
        }

        const safeIntentName = intentName.trim().toLowerCase().replace(/\s+/g, '_');

        try {
            if (safeIntentName !== 'skip_write') {
                socket.emit('train_log', `🛠️ Menyuntikkan ilmu baru: [${safeIntentName}]\n`);

                // 1. UPDATE NLU (OBJECT MANIPULATION)
                const nluPath = path.join(RASA_DIR, 'data/nlu.yml');
                let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')) || { version: "3.1", nlu: [] };
                if (!nluData.nlu) nluData.nlu = [];
                
                nluData.nlu = nluData.nlu.filter(item => item.intent !== safeIntentName);
                
                // 👇 Pembersih Anti-Dobel Dash (Strip) 👇
                const formattedExamples = examples
                    .split(/,|\n/)
                    .map(e => e.replace(/^-\s*/, '').trim()) 
                    .filter(e => e.length > 0)
                    .map(e => `- ${e}`)
                    .join('\n') + '\n';
                
                nluData.nlu.push({ intent: safeIntentName, examples: formattedExamples });
                fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));

                // 2. UPDATE RULES (OBJECT MANIPULATION)
                const rulesPath = path.join(RASA_DIR, 'data/rules.yml');
                let rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8')) || { version: "3.1", rules: [] };
                if (!rulesData.rules) rulesData.rules = [];
                
                rulesData.rules = rulesData.rules.filter(r => !(r.steps && r.steps.length > 0 && r.steps[0].intent === safeIntentName));
                rulesData.rules.push({
                    rule: `Rule otomatis untuk ${safeIntentName}`,
                    steps: [{ intent: safeIntentName }, { action: `utter_${safeIntentName}` }]
                });
                fs.writeFileSync(rulesPath, yaml.dump(rulesData, { lineWidth: -1 }));

                // 3. UPDATE DOMAIN (OBJECT MANIPULATION)
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

            socket.emit('train_log', '⏳ Memulai proses Rasa Train (Bulletproof Python Mode)...\n-----------------------------------\n');

            // 4. EKSEKUSI TERMINAL
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
                try {
                    await axios.put('http://localhost:5005/model', { model_file: "models" });
                    socket.emit('train_success', 'Bot berhasil dilatih dan semakin pintar!');
                } catch (apiError) {
                    socket.emit('train_success', 'Training sukses! Namun bot perlu di-restart manual.');
                }
            });
        } catch (err) {
            console.error('Error penulisan YAML:', err);
            socket.emit('train_error', 'Terjadi kesalahan sistem saat memodifikasi file YAML.');
        }
    });

    socket.on('disconnect', () => console.log(`🔌 User terputus: ${socket.id}`));
});

// ==========================================
// REST API ROUTES (READ, UPDATE, DELETE KNOWLEDGE)
// ==========================================
app.get('/api/bot/intents', (req, res) => {
    try {
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml');
        const domainPath = path.join(RASA_DIR, 'domain.yml');
        const nluData = yaml.load(fs.readFileSync(nluPath, 'utf8'));
        const domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        let knowledgeBase = [];

        if (nluData && nluData.nlu) {
            nluData.nlu.forEach(item => {
                if (item.intent) {
                    let responseText = '-';
                    const utterName = `utter_${item.intent}`;
                    if (domainData && domainData.responses && domainData.responses[utterName]) {
                        responseText = domainData.responses[utterName][0].text;
                    }
                    knowledgeBase.push({ intent: item.intent, examples: item.examples ? item.examples.trim() : '', response: responseText });
                }
            });
        }
        res.json(knowledgeBase);
    } catch (error) { res.status(500).json({ error: 'Gagal mengambil data file YAML' }); }
});

app.put('/api/bot/intents', (req, res) => {
    const { intentName, examples, botResponse } = req.body;
    if (!intentName || !examples || !botResponse) return res.status(400).json({ error: 'Data tidak boleh kosong!' });

    try {
        // 1. UPDATE NLU VIA OBJECT
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml');
        let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8')) || { version: "3.1", nlu: [] };
        if (!nluData.nlu) nluData.nlu = [];
        
        nluData.nlu = nluData.nlu.filter(item => item.intent !== intentName);
        
        // 👇 Pembersih Anti-Dobel Dash (Strip) 👇
        const formattedExamples = examples
            .split(/,|\n/)
            .map(e => e.replace(/^-\s*/, '').trim())
            .filter(e => e.length > 0)
            .map(e => `- ${e}`)
            .join('\n') + '\n';
            
        nluData.nlu.push({ intent: intentName, examples: formattedExamples });
        fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));

        // 2. UPDATE DOMAIN VIA OBJECT
        const domainPath = path.join(RASA_DIR, 'domain.yml');
        let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        if (domainData) {
            if (!domainData.responses) domainData.responses = {};
            domainData.responses[`utter_${intentName}`] = [{ text: botResponse }];
            fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 }));
        }

        res.json({ message: `Topik '${intentName}' berhasil diperbarui!` });
    } catch (error) { res.status(500).json({ error: 'Gagal memperbarui file YAML' }); }
});

app.delete('/api/bot/intents/:intentName', (req, res) => {
    const intentName = req.params.intentName;
    try {
        const nluPath = path.join(RASA_DIR, 'data/nlu.yml');
        let nluData = yaml.load(fs.readFileSync(nluPath, 'utf8'));
        if(nluData && nluData.nlu) {
            nluData.nlu = nluData.nlu.filter(item => item.intent !== intentName);
            fs.writeFileSync(nluPath, yaml.dump(nluData, { lineWidth: -1 }));
        }

        const rulesPath = path.join(RASA_DIR, 'data/rules.yml');
        let rulesData = yaml.load(fs.readFileSync(rulesPath, 'utf8'));
        if(rulesData && rulesData.rules) {
            rulesData.rules = rulesData.rules.filter(r => !(r.steps && r.steps.length > 0 && r.steps[0].intent === intentName));
            fs.writeFileSync(rulesPath, yaml.dump(rulesData, { lineWidth: -1 }));
        }

        const domainPath = path.join(RASA_DIR, 'domain.yml');
        let domainData = yaml.load(fs.readFileSync(domainPath, 'utf8'));
        if (domainData) {
            if (domainData.intents) domainData.intents = domainData.intents.filter(i => i !== intentName);
            if (domainData.responses && domainData.responses[`utter_${intentName}`]) delete domainData.responses[`utter_${intentName}`];
            fs.writeFileSync(domainPath, yaml.dump(domainData, { lineWidth: -1 }));
        }

        res.json({ message: `Topik '${intentName}' dihapus.` });
    } catch (error) { res.status(500).json({ error: 'Gagal menghapus file YAML' }); }
});

// REST API History Obrolan
app.get('/api/chat/history/:senderId', async (req, res) => {
    try {
        const { senderId } = req.params;
        const result = await db.query('SELECT sender_type, message, created_at FROM chat_logs WHERE sender_id = $1 ORDER BY id ASC', [senderId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Gagal mengambil riwayat' }); }
});

app.get('/api/admin/history', async (req, res) => {
    try {
        const result = await db.query('SELECT sender_id, sender_type, message, created_at FROM chat_logs ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Gagal mengambil riwayat admin' }); }
});

app.delete('/api/chat/history/:senderId', async (req, res) => {
    try {
        const { senderId } = req.params;
        await db.query('DELETE FROM chat_logs WHERE sender_id = $1', [senderId]);
        broadcastUserList();
        res.json({ message: 'Riwayat dihapus!' });
    } catch (err) { res.status(500).json({ error: 'Gagal menghapus' }); }
});

server.listen(port, () => console.log(`🚀 Server berjalan di http://localhost:${port}`));