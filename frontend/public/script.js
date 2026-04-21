// ==========================================
// 1. KONEKSI SOCKET & SENDER ID
// ==========================================
const socket = io();

let mySenderId = localStorage.getItem('bps_sender_id');
if (!mySenderId) {
    // Gunakan kombinasi angka acak dan timestamp agar tidak bisa sembarangan ditebak orang lain (unguesabble)
    mySenderId = 'warga_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
    localStorage.setItem('bps_sender_id', mySenderId);
}

// Variabel "Ingatan" untuk mengecek siapa lawan bicara saat ini
let currentResponder = 'bot';

// Saat terkoneksi ke soket, langsung mendaftar ke server agar terhubung ke jaringan pesan pribadinya
socket.on('connect', () => {
    socket.emit('register_session', { senderId: mySenderId });
});

// Tangkap elemen-elemen DOM HTML
const chatBox = document.getElementById('chat-box');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const chatContainer = document.querySelector('.chat-container');
const closeBtn = document.querySelector('button[aria-label="Close"]');
const openBtn = document.querySelector('.fixed.bottom-6.right-6 > button.w-14.h-14');

// ==========================================
// FUNGSI PENDETEKSI WAKTU (SAPAAN DINAMIS)
// ==========================================
function getGreeting() {
    const hour = new Date().getHours();
    if (hour >= 4 && hour < 11) return '🌤️ Selamat Pagi';
    else if (hour >= 11 && hour < 15) return '☀️ Selamat Siang';
    else if (hour >= 15 && hour < 18) return '⛅ Selamat Sore';
    else return '🌙 Selamat Malam';
}

// ==========================================
// 2. FITUR BUKA-TUTUP WIDGET CHAT
// ==========================================
// Fungsi Komunikasi ke Web Utama (Minta perbesar/kecil)
function notifyParentWindow(state) {
    if (window.parent && window.parent !== window) {
        window.parent.postMessage(state, '*'); 
    }
}

chatContainer.classList.add('scale-0', 'opacity-0', 'pointer-events-none', 'duration-300');

openBtn.addEventListener('click', () => {
    chatContainer.classList.remove('scale-0', 'opacity-0', 'pointer-events-none');
    chatContainer.classList.add('scale-100', 'opacity-100', 'pointer-events-auto');
    userInput.focus();
    notifyParentWindow('CHAT_OPENED'); // Minta iframe dibesarkan
});

closeBtn.addEventListener('click', () => {
    chatContainer.classList.remove('scale-100', 'opacity-100', 'pointer-events-auto');
    chatContainer.classList.add('scale-0', 'opacity-0', 'pointer-events-none');
    notifyParentWindow('CHAT_CLOSED'); // Minta iframe dikecilkan
});

function formatWaktuChat(waktuMentah) {
    const date = new Date(waktuMentah);
    const hariTanggal = date.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const jam = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':');
    return `${hariTanggal} | ${jam}`;
}

// ==========================================
// 3. FITUR FORMAT LINK
// ==========================================
function formatTextWithLink(text) {
    if (!text) return '';
    if (text.includes('<a href=') || text.includes("<a href='")) return text.replace(/\n/g, '<br>');
    
    // 1. Parsing Markdown: [Teks](URL)
    let formattedText = text.replace(/\[(.*?)\]\((https?:\/\/[^\s]+)\)/g, function(match, label, url) {
        return `<a href="${url}" target="_blank" style="color: #38bdf8; text-decoration: underline; font-weight: 600;">${label}</a>`;
    });

    // 2. Parsing Raw URLs murni yang belum kena Markdown
    const urlRegex = /(?<!href="|href=")(https?:\/\/[^\s<()]+)/g;
    formattedText = formattedText.replace(urlRegex, function (url) {
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

    let senderName = currentResponder === 'admin' ? 'Petugas BPS' : 'SISCA (Bot Asisten Virtual)';
    let senderFoto = currentResponder === 'admin'
        ? '<img src="https://cdn-icons-png.flaticon.com/512/3135/3135715.png" alt="Admin" class="w-5 h-5 rounded-full object-cover border border-gray-200">'
        : `<img src="img/SISCA_BOT.png" onerror="this.src='https://cdn-icons-png.flaticon.com/512/4712/4712139.png'" alt="Bot" class="w-5 h-5 rounded-full object-cover shadow-sm">`;

    wrapper.innerHTML = `
        <div class="sender-label label-bot flex items-center gap-1 text-[10px] text-gray-500 ml-1 font-medium">${senderFoto}<span>${senderName}</span></div>
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
    if (indicator) indicator.remove();
}

// ==========================================
// 5. FITUR MENAMPILKAN PESAN KE LAYAR
// ==========================================
function appendMessage(sender, text, timestamp = null) {
    const wrapper = document.createElement('div');
    const rawTime = timestamp ? timestamp : new Date();
    const timeNow = formatWaktuChat(rawTime);

    if (sender === 'user') {
        wrapper.className = 'message-wrapper wrapper-user flex flex-col gap-1 items-end self-end max-w-[85%]';
        wrapper.innerHTML = `
            <div class="message user-message bg-[var(--bps-blue)] text-white p-3 rounded-2xl rounded-tr-none shadow-sm text-sm leading-relaxed">${formatTextWithLink(text)}</div>
            <span class="text-[10px] text-gray-400 mr-1">${timeNow}</span>
        `;
    } else {
        wrapper.className = 'message-wrapper wrapper-bot flex flex-col gap-1 items-start max-w-[85%]';
        let senderName = sender === 'admin' ? 'Petugas BPS' : 'SISCA (Bot Asisten Virtual)';
        let senderFoto = sender === 'admin'
            ? '<img src="https://cdn-icons-png.flaticon.com/512/3135/3135715.png" alt="Admin" class="w-5 h-5 rounded-full object-cover border border-gray-200">'
            : `<img src="img/SISCA_BOT.png" onerror="this.src='https://cdn-icons-png.flaticon.com/512/4712/4712139.png'" alt="Bot" class="w-5 h-5 rounded-full object-cover shadow-sm">`;

        wrapper.innerHTML = `
            <div class="sender-label label-bot flex items-center gap-1 text-[10px] text-gray-500 ml-1 font-medium">${senderFoto}<span>${senderName}</span></div>
            <div class="message bot-message bg-white text-gray-800 p-3 rounded-2xl rounded-tl-none shadow-sm border border-gray-100 text-sm leading-relaxed">${formatTextWithLink(text)}</div>
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
userInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });

// ==========================================
// 7. MENERIMA BALASAN (MENGINGAT LAWAN BICARA)
// ==========================================
socket.on('bot_response', (data) => {
    currentResponder = 'bot';
    setTimeout(() => { removeTypingIndicator(); appendMessage('bot', data.message); }, 800);
});

socket.on('admin_response', (data) => {
    currentResponder = 'admin';
    removeTypingIndicator();
    appendMessage('admin', data.message);
});

// ==========================================
// 8. MEMUAT RIWAYAT (DENGAN INGATAN & QUICK REPLIES)
// ==========================================
window.onload = async function () {
    try {
        const response = await fetch(`/api/chat/history/${mySenderId}`);
        const history = await response.json();

        if (history.length === 0) {
            setTimeout(() => {
                const sapaan = getGreeting();
                appendMessage('bot', `${sapaan}! Selamat datang di Layanan Live Chat BPS Kota Jambi. Ada yang bisa SISCA bantu hari ini?`);
                showQuickReplies();
            }, 500);
        } else {
            history.forEach(chat => {
                let type = chat.sender_type;
                if (type === 'warga') type = 'user';
                appendMessage(type, chat.message, chat.created_at);
                if (type === 'admin') currentResponder = 'admin';
                if (type === 'bot') currentResponder = 'bot';
            });
        }
    } catch (error) { console.error('Gagal memuat riwayat:', error); }
};

// ==========================================
// 9. FUNGSI UNTUK TOMBOL DARI BOT
// ==========================================
window.sendBotButton = function (text) {
    appendMessage('user', text);
    showTypingIndicator();
    socket.emit('user_message', { senderId: mySenderId, message: text });
};

// ==========================================
// 10. FITUR QUICK REPLIES (Saran Pertanyaan)
// ==========================================
function showQuickReplies() {
    const wrapper = document.createElement('div');
    wrapper.id = 'quick-replies-container';
    wrapper.className = 'flex flex-wrap gap-2 mt-2 mb-4 ml-8 max-w-[80%]';

    const suggestions = [ "📊 Data Inflasi Jambi", "👥 Jumlah Penduduk", "👨‍💼 Hubungi Admin" ];

    suggestions.forEach(text => {
        const btn = document.createElement('button');
        btn.className = 'bg-white text-[var(--bps-blue)] border border-[var(--bps-blue)] text-xs px-3 py-1.5 rounded-full hover:bg-[var(--bps-blue)] hover:text-white transition-colors duration-200 cursor-pointer';
        btn.innerText = text;
        btn.onclick = () => {
            window.sendBotButton(text);
            wrapper.remove(); 
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

window.openDeleteModal = function () {
    deleteModal.classList.remove('hidden');
    deleteModal.querySelector('.relative').classList.add('animate-in', 'fade-in', 'zoom-in', 'duration-200');
};

window.closeDeleteModal = function () {
    deleteModal.classList.add('hidden');
};

window.confirmClearChat = function() {
    // 1. Tembakkan sinyal hapus ke Backend menggunakan variabel mySenderId yang benar
    socket.emit('user_clear_chat', { senderId: mySenderId });

    // 2. Bersihkan kotak chat di layar Widget secara instan
    const chatBox = document.getElementById('chat-box');
    if (chatBox) {
        chatBox.innerHTML = `
            <div class="m-auto text-center flex flex-col items-center opacity-50 pt-10 pb-4">
                <span class="material-symbols-outlined text-5xl mb-2 text-green-500">check_circle</span>
                <p class="text-gray-500 text-sm font-medium mt-1">Riwayat obrolan telah dibersihkan.</p>
            </div>
        `;
    }

    // 3. Tutup Modal Pop-up Merah
    window.closeDeleteModal();

    // 4. (Bonus) Panggil ulang sambutan awal bot agar layar tidak kosong melompong
    setTimeout(() => {
        const sapaan = getGreeting();
        appendMessage('bot', `Sistem telah di-reset. ${sapaan}, ada yang bisa Asisten Virtual bantu lagi?`);
        showQuickReplies();
    }, 1200);
};