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
// FUNGSI BANTUAN UNTUK DASHBOARD ADMIN
// ==========================================
// Mengambil daftar warga unik dari database dan mengirimnya ke Admin
async function broadcastUserList() {
    try {
        const users = await db.query('SELECT DISTINCT sender_id FROM chat_logs ORDER BY sender_id ASC');
        const userList = users.rows.map(row => row.sender_id);
        io.emit('user_list', userList); // Memancarkan ke sidebar admin
    } catch (err) {
        console.error('Gagal mengambil daftar user:', err.message);
    }
}

// ==========================================
// LOGIKA REAL-TIME CHAT (SOCKET.IO)
// ==========================================
let activeSessions = {};

io.on('connection', (socket) => {
    console.log(`🔌 User terhubung: ${socket.id}`);

    // Langsung kirim daftar warga setiap ada yang connect (Untuk update sidebar Admin)
    broadcastUserList();

    // Menerima pesan dari Web Warga
    socket.on('user_message', async (data) => {
        const { senderId, message } = data;
        socket.join(senderId);

        // 👉 SIMPAN PESAN WARGA KE DATABASE
        try {
            await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [senderId, 'warga', message]);
        } catch (err) { console.error('Gagal simpan db:', err.message); }

        // [UPDATE] Kirim pesan warga ke Dashboard Admin yang baru
        io.emit('receive_message', { senderId: senderId, message: message, senderType: 'warga' });
        
        // Perbarui sidebar jika ada warga baru yang chat
        broadcastUserList();

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

                // [UPDATE] Kirim balasan Bot ke Dashboard Admin agar admin bisa ikut membaca
                io.emit('receive_message', { senderId: senderId, message: botReply, senderType: 'bot' });

                if (botReply.includes('meneruskan pesan Anda ke petugas')) {
                    activeSessions[senderId] = 'admin';
                    socket.emit('bot_response', { message: botReply });
                } else {
                    socket.emit('bot_response', { message: botReply });
                }
            }
        } catch (error) {
            console.error('❌ Error Rasa:', error.message);
            socket.emit('bot_response', { message: 'Gagal menghubungi otak AI.' });
        }
    });

    // [UPDATE] Menerima balasan dari Web Admin yang baru (admin_message)
    socket.on('admin_message', async (data) => {
        const { targetSenderId, message } = data;
        
        // 👇 FITUR BARU: MENGAKHIRI SESI MANUAL 👇
        if (message.trim() === '/selesai') {
            delete activeSessions[targetSenderId]; // Hapus status admin
            io.to(targetSenderId).emit('bot_response', { 
                message: '✅ Sesi dengan petugas telah berakhir. Anda kembali terhubung dengan Asisten Virtual.' 
            });
            console.log(`✅ Sesi ${targetSenderId} dikembalikan ke Bot.`);
            return; // Hentikan fungsi di sini, jangan simpan '/selesai' ke DB
        }
        // 👆 =================================== 👆

        // Simpan ke DB
        try {
            await db.query('INSERT INTO chat_logs (sender_id, sender_type, message) VALUES ($1, $2, $3)', [targetSenderId, 'admin', message]);
        } catch (err) { console.error('Gagal simpan db:', err.message); }

        // Kirimkan balasan Admin ke layar Warga
        io.to(targetSenderId).emit('admin_response', { message });
    });

    socket.on('disconnect', () => console.log(`🔌 User terputus: ${socket.id}`));
});

// ==========================================
// REST API ROUTES
// ==========================================
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

app.get('/api/admin/history', async (req, res) => {
    try {
        const result = await db.query('SELECT sender_id, sender_type, message, created_at FROM chat_logs ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error get history admin:', err);
        res.status(500).json({ error: 'Gagal mengambil riwayat admin' });
    }
});

app.delete('/api/chat/history/:senderId', async (req, res) => {
    try {
        const { senderId } = req.params;
        await db.query('DELETE FROM chat_logs WHERE sender_id = $1', [senderId]);
        
        // [UPDATE] Beritahu admin untuk merefresh sidebar jika chat dihapus
        broadcastUserList();
        
        res.json({ message: 'Riwayat obrolan berhasil dihapus!' });
    } catch (err) {
        console.error('Error delete history:', err);
        res.status(500).json({ error: 'Gagal menghapus riwayat' });
    }
});

server.listen(port, () => console.log(`🚀 Server Web & WebSocket berjalan di http://localhost:${port}`));