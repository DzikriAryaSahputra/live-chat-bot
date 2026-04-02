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
    // FITUR CMS: LIVE TRAINING VIA SOCKET
    // ==========================================
    socket.on('train_bot', async (data) => {
        const { intentName, examples, botResponse } = data;

        if (!intentName || !examples || !botResponse) {
            return socket.emit('train_error', 'Data tidak boleh kosong!');
        }

        const safeIntentName = intentName.trim().toLowerCase().replace(/\s+/g, '_');

        try {
            socket.emit('train_log', `🛠️ Menyuntikkan ilmu baru: [${safeIntentName}]\n`);

            // 1. Menulis nlu.yml (PRESISI: 0 spasi, 2 spasi, 4 spasi)
            const nluPath = path.join(RASA_DIR, 'data/nlu.yml');
            const formattedExamples = examples.split(/,|\n/).map(e => `    - ${e.trim()}`).filter(e => e !== '    - ' && e.length > 0).join('\n');
            const newNluEntry = `\n- intent: ${safeIntentName}\n  examples: |\n${formattedExamples}\n`;
            fs.appendFileSync(nluPath, newNluEntry);

            // 2. Menulis rules.yml (PRESISI SUPER KETAT: 2 spasi, 4 spasi, 6 SPASI)
            const rulesPath = path.join(RASA_DIR, 'data/rules.yml');
            const newRuleEntry = `\n  - rule: Rule otomatis untuk ${safeIntentName}\n    steps:\n      - intent: ${safeIntentName}\n      - action: utter_${safeIntentName}\n`;
            fs.appendFileSync(rulesPath, newRuleEntry);

            // 3. Menulis domain.yml
            const domainPath = path.join(RASA_DIR, 'domain.yml');
            const domainFile = fs.readFileSync(domainPath, 'utf8');
            let domainData = yaml.load(domainFile);

            if (!domainData.intents) domainData.intents = [];
            if (!domainData.intents.includes(safeIntentName)) domainData.intents.push(safeIntentName);

            if (!domainData.responses) domainData.responses = {};
            domainData.responses[`utter_${safeIntentName}`] = [{ text: botResponse }];

            fs.writeFileSync(domainPath, yaml.dump(domainData));
            socket.emit('train_log', '✅ File YAML berhasil diperbarui.\n⏳ Memulai proses Rasa Train (Bulletproof Python Mode)...\n-----------------------------------\n');

            // 4. Eksekusi Terminal DENGAN PYTHON LANGSUNG (Bulletproof Mode)
            const isWin = process.platform === "win32";
            
            // Trik Jitu: Panggil python.exe di dalam venv secara langsung!
            const pythonPath = isWin ? 'venv\\Scripts\\python.exe' : 'venv/bin/python';
            
            // Kita suruh Python yang menjalankan modul rasa beserta perintah paksa (--force)
            const args = ['-m', 'rasa', 'train', '--force'];
            
            // Perhatikan: shell: true dihapus agar proses terbaca langsung dengan stabil
            const trainProcess = spawn(pythonPath, args, { cwd: RASA_DIR });

            trainProcess.stdout.on('data', (chunk) => {
                socket.emit('train_log', chunk.toString()); 
            });

            trainProcess.stderr.on('data', (chunk) => {
                // Di Python/Rasa, log loading bar (epochs) sering kali masuk lewat stderr
                socket.emit('train_log', chunk.toString()); 
            });

            trainProcess.on('error', (error) => {
                 socket.emit('train_error', `❌ Gagal menjalankan mesin Python: ${error.message}`);
            });

            trainProcess.on('close', async (code) => {
                if (code !== 0) {
                    return socket.emit('train_error', `\n❌ Proses terhenti paksa dengan kode error ${code}`);
                }

                socket.emit('train_log', '\n-----------------------------------\n✅ Training Selesai 100%!\n🔄 Melakukan Hot-Reload ke Bot AI...\n');

                try {
                    await axios.put('http://localhost:5005/model', { model_file: "models" });
                    socket.emit('train_log', '🚀 AI Bot sudah menggunakan otak baru!\n');
                    socket.emit('train_success', 'Bot berhasil dilatih dan semakin pintar!');
                } catch (apiError) {
                    socket.emit('train_log', '⚠️ Training sukses, tapi Rasa API gagal reload. Coba restart Rasa.\n');
                    socket.emit('train_success', 'Training sukses! Namun bot perlu di-restart manual.');
                }
            });

        } catch (err) {
            console.error(err);
            socket.emit('train_error', 'Terjadi kesalahan sistem saat memodifikasi file YAML.');
        }
    });

    socket.on('disconnect', () => console.log(`🔌 User terputus: ${socket.id}`));
});

// REST API History
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