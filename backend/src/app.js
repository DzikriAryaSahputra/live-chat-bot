require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const axios = require('axios');

// 👇 PANGGIL KONEKSI DATABASE YANG SUDAH KITA BUAT DI AWAL 👇
const db = require('./config/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// 2. LOGIKA REAL-TIME CHAT (SOCKET.IO)
// ==========================================
let activeSessions = {};

io.on('connection', (socket) => {
    console.log(`🔌 User terhubung: ${socket.id}`);

    // Menerima pesan dari Web Warga
    socket.on('user_message', async (data) => {
        const { senderId, message } = data;
        socket.join(senderId);

        // 👉 SIMPAN PESAN WARGA KE DATABASE
        try {
            await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'warga', message]);
        } catch (err) { console.error('Gagal simpan db:', err.message); }

        io.emit('message_to_admin', { senderId, message, type: 'user' });

        if (activeSessions[senderId] === 'admin') return;

        // Jika tidak ditangani admin, kirim ke Rasa (Bot NLP)
        try {
            const rasaResponse = await axios.post('http://localhost:5005/webhooks/rest/webhook', {
                sender: senderId, message: message
            });

            const botResponses = rasaResponse.data;
            if (botResponses && botResponses.length > 0) {
                const botReply = botResponses[0].text;

                // 👉 SIMPAN PESAN BOT KE DATABASE
                await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'bot', botReply]);

                if (botReply.includes('meneruskan pesan Anda ke petugas')) {
                    activeSessions[senderId] = 'admin';
                    socket.emit('bot_response', { message: botReply });
                    io.emit('system_alert_admin', { message: `🚨 Warga (${senderId}) meminta bantuan Admin!` });
                } else {
                    socket.emit('bot_response', { message: botReply });
                    io.emit('message_to_admin', { senderId, message: botReply, type: 'bot' });
                }
            }
        } catch (error) {
            console.error('❌ Error Rasa:', error.message);
            socket.emit('bot_response', { message: 'Gagal menghubungi otak AI.' });
        }
    });

    // Menerima balasan dari Web Admin
    socket.on('admin_reply', async (data) => {
        const { targetUserId, message } = data;
        
        // 👇 FITUR BARU: MENGAKHIRI SESI MANUAL 👇
        if (message.trim() === '/selesai') {
            delete activeSessions[targetUserId]; // Hapus status admin
            io.to(targetUserId).emit('bot_response', { 
                message: '✅ Sesi dengan petugas telah berakhir. Anda kembali terhubung dengan Asisten Virtual.' 
            });
            console.log(`✅ Sesi ${targetUserId} dikembalikan ke Bot.`);
            return; // Hentikan fungsi di sini, jangan simpan '/selesai' ke DB
        }
        // 👆 =================================== 👆

        // Simpan ke DB
        try {
            await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [targetUserId, 'admin', message]);
        } catch (err) { console.error('Gagal simpan db:', err.message); }

        io.to(targetUserId).emit('admin_response', { message });
    });

    socket.on('disconnect', () => console.log(`🔌 User terputus: ${socket.id}`));
});
app.get('/api/chat/history/:senderId', async (req, res) => {
    try {
        const { senderId } = req.params;
        const result = await db.query(
            'SELECT sender_type, message, created_at FROM chat_logs WHERE sender_id = $1 ORDER BY id ASC',
            [senderId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error get history warga:', err);
        res.status(500).json({ error: 'Gagal mengambil riwayat' });
    }
});

// B. API untuk Dashboard Admin (Menarik SEMUA chat)
app.get('/api/admin/history', async (req, res) => {
    try {
        // 👇 TAMBAHKAN created_at DI SINI 👇
        const result = await db.query('SELECT sender_id, sender_type, message, created_at FROM chat_logs ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error get history admin:', err);
        res.status(500).json({ error: 'Gagal mengambil riwayat admin' });
    }
});
server.listen(port, () => console.log(`🚀 Server Web & WebSocket berjalan di http://localhost:${port}`));