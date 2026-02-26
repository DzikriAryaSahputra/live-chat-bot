// src/config/db.js
require('dotenv').config(); // Memanggil file .env
const { Pool } = require('pg');

// Membuat instance Pool dengan data dari .env
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Mengetes koneksi saat file ini dipanggil
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Gagal terkoneksi ke Database:', err.stack);
    } else {
        console.log('✅ Berhasil terkoneksi ke Database PostgreSQL (bps_chatbot)');
    }
    if (client) release(); // Melepas koneksi kembali ke pool
});

module.exports = pool;