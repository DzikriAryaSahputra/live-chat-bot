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

// ==========================================
// 3. FITUR FORMAT LINK
// ==========================================
function formatTextWithLink(text) {
    if (!text) return '';
    if (text.includes('<a href=') || text.includes("<a href='")) {
        return text.replace(/\n/g, '<br>');
    }
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    let formattedText = text.replace(urlRegex, function(url) {
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
    
    // 👇 NAMA & IKON BERUBAH SESUAI LAWAN BICARA 👇
    let senderName = currentResponder === 'admin' ? 'Petugas BPS' : 'Asisten Virtual';
    let senderIcon = currentResponder === 'admin' ? '👨‍💼' : '🤖';

    wrapper.innerHTML = `
        <div class="sender-label label-bot flex items-center gap-1 text-[10px] text-gray-500 ml-1 font-medium">
            <span class="sender-icon text-sm">${senderIcon}</span> ${senderName}
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
function appendMessage(sender, text) {
    const wrapper = document.createElement('div');
    const timeNow = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

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
        let senderIcon = sender === 'admin' ? '👨‍💼' : '🤖';

        wrapper.innerHTML = `
            <div class="sender-label label-bot flex items-center gap-1 text-[10px] text-gray-500 ml-1 font-medium">
                <span class="sender-icon text-sm">${senderIcon}</span> ${senderName}
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
// 8. MEMUAT RIWAYAT (DENGAN INGATAN)
// ==========================================
window.onload = async function() {
    try {
        const response = await fetch(`http://localhost:3000/api/chat/history/${mySenderId}`);
        const history = await response.json();
        
        history.forEach(chat => {
            let type = chat.sender_type;
            if (type === 'warga') type = 'user'; 
            appendMessage(type, chat.message);

            // Perbarui "ingatan" berdasarkan riwayat terakhir
            if (type === 'admin') currentResponder = 'admin';
            if (type === 'bot') currentResponder = 'bot';
        });
    } catch (error) {
        console.error('Gagal memuat riwayat:', error);
    }
};