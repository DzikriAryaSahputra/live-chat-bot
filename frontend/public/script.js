// ==========================================
// 1. KONEKSI SOCKET & SENDER ID
// ==========================================
const socket = io('http://localhost:3000');

let mySenderId = localStorage.getItem('bps_sender_id');
if (!mySenderId) {
    mySenderId = 'warga_' + Math.floor(Math.random() * 10000);
    localStorage.setItem('bps_sender_id', mySenderId);
}

// Variabel "Ingatan" untuk mengecek siapa lawan bicara saat ini
let currentResponder = 'bot';

// Tangkap elemen-elemen DOM HTML
const chatBox = document.getElementById('chat-box');
// ==========================================
// FUNGSI PENDETEKSI WAKTU (SAPAAN DINAMIS)
// ==========================================
function getGreeting() {
    const hour = new Date().getHours();

    // Logika waktu standar Indonesia
    if (hour >= 4 && hour < 11) {
        return '🌤️ Selamat Pagi';
    } else if (hour >= 11 && hour < 15) {
        return '☀️ Selamat Siang';
    } else if (hour >= 15 && hour < 18) {
        return '⛅ Selamat Sore';
    } else {
        return '🌙 Selamat Malam';
    }
}
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatContainer = document.querySelector('.chat-container');
const closeBtn = document.querySelector('button[aria-label="Close"]');
const openBtn = document.querySelector('.fixed.bottom-6.right-6 > button.w-14.h-14');

// ==========================================
// 2. FITUR BUKA-TUTUP WIDGET CHAT
// ==========================================
chatContainer.classList.add('scale-0', 'opacity-0', 'pointer-events-none', 'duration-300');

openBtn.addEventListener('click', () => {
    chatContainer.classList.remove('scale-0', 'opacity-0', 'pointer-events-none');
    chatContainer.classList.add('scale-100', 'opacity-100', 'pointer-events-auto');
    userInput.focus();
});

closeBtn.addEventListener('click', () => {
    chatContainer.classList.remove('scale-100', 'opacity-100', 'pointer-events-auto');
    chatContainer.classList.add('scale-0', 'opacity-0', 'pointer-events-none');
});

function formatWaktuChat(waktuMentah) {
    // Mengubah waktu mentah dari database menjadi objek Date
    const date = new Date(waktuMentah);

    // 1. Mengambil format Hari dan Tanggal (Bahasa Indonesia)
    // Contoh hasil: "Senin, 23 Februari 2026"
    const hariTanggal = date.toLocaleDateString('id-ID', {
        weekday: 'long',  // Menampilkan nama hari (Senin, Selasa, dll)
        day: 'numeric',   // Angka tanggal (1-31)
        month: 'long',    // Nama bulan (Januari, Februari, dll)
        year: 'numeric'   // Tahun (2026)
    });

    // 2. Mengambil format Jam 24-Hour (00:00 - 23:59)
    // Contoh hasil: "23:45"
    const jam = date.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false     // Kunci utama agar menggunakan format 24 jam!
    }).replace('.', ':'); // Memastikan pemisahnya titik dua (:), bukan titik (.)

    // 3. Menggabungkan semuanya
    return `${hariTanggal} | ${jam}`;
}
// ==========================================
// 3. FITUR FORMAT LINK
// ==========================================
function formatTextWithLink(text) {
    if (!text) return '';
    if (text.includes('<a href=') || text.includes("<a href='")) {
        return text.replace(/\n/g, '<br>');
    }
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    let formattedText = text.replace(urlRegex, function (url) {
        return `<a href="${url}" target="_blank" style="color: #38bdf8; text-decoration: underline;">${url}</a>`;
    });
    return formattedText.replace(/\n/g, '<br>');
}
// ==========================================
// 4. FITUR ANIMASI MENGETIK DINAMIS
// ==========================================
function showTypingIndicator() {
    removeTypingIndicator();

    const wrapper = document.createElement('div');
    wrapper.id = 'typing-indicator';
    wrapper.className = 'message-wrapper wrapper-bot flex flex-col gap-1 items-start max-w-[85%] mb-2';

    let senderName = currentResponder === 'admin' ? 'Petugas BPS' : 'Asisten Virtual';

    // Logika Gambar Profil Animasi Mengetik
    let senderFoto = currentResponder === 'admin'
        ? '<img src="https://cdn-icons-png.flaticon.com/512/3135/3135715.png" alt="Admin" class="w-5 h-5 rounded-full object-cover border border-gray-200">'
        : '<img src="https://cdn-icons-png.flaticon.com/512/4712/4712139.png" alt="Bot" class="w-5 h-5 rounded-full object-cover border border-gray-200">';

    wrapper.innerHTML = `
        <div class="sender-label label-bot flex items-center gap-1 text-[10px] text-gray-500 ml-1 font-medium">
            ${senderFoto}
            <span>${senderName}</span>
        </div>
        <div class="bg-white p-3 rounded-2xl rounded-tl-none shadow-sm border border-gray-100 w-16 flex items-center justify-center gap-1 h-[42px]">
            <span class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></span>
            <span class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.15s"></span>
            <span class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style="animation-delay: 0.3s"></span>
        </div>
    `;

    chatBox.appendChild(wrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function removeTypingIndicator() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) {
        indicator.remove();
    }
}

// ==========================================
// 5. FITUR MENAMPILKAN PESAN KE LAYAR
// ==========================================
function appendMessage(sender, text, timestamp = null) {
    const wrapper = document.createElement('div');
    const rawTime = timestamp ? timestamp : new Date();
    const timeNow = formatWaktuChat(rawTime); // Memanggil fungsi waktu yang kita buat sebelumnya

    if (sender === 'user') {
        wrapper.className = 'message-wrapper wrapper-user flex flex-col gap-1 items-end self-end max-w-[85%]';
        wrapper.innerHTML = `
            <div class="message user-message bg-[var(--bps-blue)] text-white p-3 rounded-2xl rounded-tr-none shadow-sm text-sm leading-relaxed">
                ${formatTextWithLink(text)}
            </div>
            <span class="text-[10px] text-gray-400 mr-1">${timeNow}</span>
        `;
    } else {
        wrapper.className = 'message-wrapper wrapper-bot flex flex-col gap-1 items-start max-w-[85%]';
        let senderName = sender === 'admin' ? 'Petugas BPS' : 'Asisten Virtual';

        // Logika Gambar Profil Balasan Pesan
        let senderFoto = sender === 'admin'
            ? '<img src="https://cdn-icons-png.flaticon.com/512/3135/3135715.png" alt="Admin" class="w-5 h-5 rounded-full object-cover border border-gray-200">'
            : '<img src="https://cdn-icons-png.flaticon.com/512/4712/4712139.png" alt="Bot" class="w-5 h-5 rounded-full object-cover border border-gray-200">';

        wrapper.innerHTML = `
            <div class="sender-label label-bot flex items-center gap-1 text-[10px] text-gray-500 ml-1 font-medium">
                ${senderFoto}
                <span>${senderName}</span>
            </div>
            <div class="message bot-message bg-white text-gray-800 p-3 rounded-2xl rounded-tl-none shadow-sm border border-gray-100 text-sm leading-relaxed">
                ${formatTextWithLink(text)}
            </div>
            <span class="text-[10px] text-gray-400 ml-1">${timeNow}</span>
        `;
    }

    chatBox.appendChild(wrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
}
// ==========================================
// 6. MENGIRIM PESAN
// ==========================================
function sendMessage() {
    const text = userInput.value.trim();
    if (text) {
        appendMessage('user', text);
        showTypingIndicator();

        socket.emit('user_message', { senderId: mySenderId, message: text });
        userInput.value = '';
    }
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

// ==========================================
// 7. MENERIMA BALASAN (MENGINGAT LAWAN BICARA)
// ==========================================
socket.on('bot_response', (data) => {
    currentResponder = 'bot'; // 👈 Mengingat bahwa lawan bicaranya kembali jadi Bot
    setTimeout(() => {
        removeTypingIndicator();
        appendMessage('bot', data.message);
    }, 800);
});

socket.on('admin_response', (data) => {
    currentResponder = 'admin'; // 👈 Mengingat bahwa lawan bicaranya sekarang adalah Admin
    removeTypingIndicator();
    appendMessage('admin', data.message);
});

// ==========================================
// 8. MEMUAT RIWAYAT (DENGAN INGATAN & QUICK REPLIES)
// ==========================================
window.onload = async function () {
    try {
        const response = await fetch(`http://localhost:3000/api/chat/history/${mySenderId}`);
        const history = await response.json();

        if (history.length === 0) {
            // JIKA KOSONG: Warga baru pertama kali buka chat
            setTimeout(() => {
                // 👇 Panggil fungsi deteksi waktu di sini 👇
                const sapaan = getGreeting();

                // Masukkan variabel sapaan ke dalam pesan bot
                appendMessage('bot', `${sapaan}! Selamat datang di Layanan Live Chat BPS Kota Jambi. Ada yang bisa Asisten Virtual bantu hari ini?`);

                // Munculkan tombol saran pertanyaan
                showQuickReplies();
            }, 500);
        } else {
            // JIKA ADA RIWAYAT: Muat chat lama seperti biasa
            history.forEach(chat => {
                let type = chat.sender_type;
                if (type === 'warga') type = 'user';

                appendMessage(type, chat.message, chat.created_at);

                if (type === 'admin') currentResponder = 'admin';
                if (type === 'bot') currentResponder = 'bot';
            });
        }
    } catch (error) {
        console.error('Gagal memuat riwayat:', error);
    }
};
// ==========================================
// 9. FUNGSI UNTUK TOMBOL DARI BOT
// ==========================================
window.sendBotButton = function (text) {
    // Memunculkan pesan di layar warga
    appendMessage('user', text);
    showTypingIndicator();

    // Mengirim ke backend/bot
    socket.emit('user_message', { senderId: mySenderId, message: text });
};

// ==========================================
// 10. FITUR QUICK REPLIES (Saran Pertanyaan)
// ==========================================
function showQuickReplies() {
    // 1. Buat bungkus (container) untuk tombol-tombolnya
    const wrapper = document.createElement('div');
    wrapper.id = 'quick-replies-container';
    // Menggunakan class Tailwind agar rapi dan berjajar
    wrapper.className = 'flex flex-wrap gap-2 mt-2 mb-4 ml-8 max-w-[80%]';

    // 2. Daftar pertanyaan khas BPS (Bisa kamu ganti teksnya nanti)
    const suggestions = [
        "📊 Data Inflasi Jambi",
        "👥 Jumlah Penduduk",
        "👨‍💼 Hubungi Admin"
    ];

    // 3. Cetak tombol ke layar satu per satu
    suggestions.forEach(text => {
        const btn = document.createElement('button');
        // Desain tombol (Outline border yang akan terisi warna saat di-hover)
        btn.className = 'bg-white text-[var(--bps-blue)] border border-[var(--bps-blue)] text-xs px-3 py-1.5 rounded-full hover:bg-[var(--bps-blue)] hover:text-white transition-colors duration-200 cursor-pointer';
        btn.innerText = text;

        // 4. Aksi ketika tombol diklik
        btn.onclick = () => {
            window.sendBotButton(text); // Otomatis mengirim pesan
            wrapper.remove(); // Hapus kumpulan tombol ini agar layar tidak penuh
        };

        wrapper.appendChild(btn);
    });

    chatBox.appendChild(wrapper);
    chatBox.scrollTop = chatBox.scrollHeight;
}

// ==========================================
// 11. FITUR MODAL HAPUS RIWAYAT
// ==========================================

const deleteModal = document.getElementById('delete-modal');

// 1. Fungsi Buka Modal
window.openDeleteModal = function () {
    deleteModal.classList.remove('hidden');
    // Tambahkan animasi masuk (opsional)
    deleteModal.querySelector('.relative').classList.add('animate-in', 'fade-in', 'zoom-in', 'duration-200');
};

// 2. Fungsi Tutup Modal
window.closeDeleteModal = function () {
    deleteModal.classList.add('hidden');
};

// 3. Fungsi Eksekusi Hapus (Setelah Klik "Ya, Hapus")
window.confirmClearChat = async function () {
    try {
        // Tembak API Backend
        const response = await fetch(`http://localhost:3000/api/chat/history/${mySenderId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            // Tutup Modal
            closeDeleteModal();

            // Bersihkan Layar Chat
            chatBox.innerHTML = '';

            // Notifikasi Visual Singkat (Opsional)
            console.log("Riwayat berhasil dihapus.");

            // Munculkan kembali sambutan bot & Quick Replies
            // Di dalam fungsi confirmClearChat, ganti bagian setTimeout menjadi:
            setTimeout(() => {
                const sapaan = getGreeting();
                appendMessage('bot', `Riwayat obrolan telah dibersihkan. ${sapaan}, ada yang bisa Asisten Virtual bantu lagi?`);
                showQuickReplies();
            }, 400);
        }
    } catch (error) {
        console.error('Gagal menghapus riwayat:', error);
        alert('Terjadi gangguan koneksi ke server.');
        closeDeleteModal();
    }
};