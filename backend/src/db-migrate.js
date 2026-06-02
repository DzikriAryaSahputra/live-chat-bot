const pool = require('./config/db');
const bcrypt = require('bcryptjs');

async function migrate() {
    try {
        console.log("Mulai migrasi tabel admin_users...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(100) NOT NULL,
                role VARCHAR(20) DEFAULT 'petugas',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Tabel admin_users berhasil dibuat (atau sudah ada)!");

        console.log("Mengecek apakah akun Super Admin default sudah ada...");
        const res = await pool.query(`SELECT id FROM admin_users WHERE username = 'admin'`);
        if (res.rows.length === 0) {
            const hashed = await bcrypt.hash('admin123', 10);
            await pool.query(`
                INSERT INTO admin_users (username, password_hash, full_name, role)
                VALUES ('admin', $1, 'Super Administrator', 'super_admin')
            `, [hashed]);
            console.log("✅ Akun Super Admin default berhasil dibuat! Username: admin | Pass: admin123");
        } else {
            console.log("⚡ Akun Super Admin sudah ada, lewati proses seed.");
        }
    } catch (err) {
        console.error("❌ Migrasi gagal:", err);
    } finally {
        pool.end();
        process.exit();
    }
}

migrate();
