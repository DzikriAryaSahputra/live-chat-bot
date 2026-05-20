
        const socket = io({ auth: { token: adminToken } });

        // 🛡️ FITUR KEAMANAN: Cek Otomatis JWT Kadaluwarsa & Penolakan Koneksi Server
        socket.on('connect_error', (err) => {
            if (err.message === 'Authentication Error') {
                localStorage.removeItem('bps_admin_token');
                window.location.replace('/login?expired=true');
            }
        });

        function checkTokenExpiry() {
            try {
                const payload = JSON.parse(atob(adminToken.split('.')[1]));
                if (payload.exp * 1000 < Date.now()) {
                    localStorage.removeItem('bps_admin_token');
                    window.location.replace('/login?expired=true');
                }
            } catch (e) {}
        }
        setInterval(checkTokenExpiry, 60000); // Cek setiap 1 menit
        checkTokenExpiry(); // Cek langsung saat pertama dimuat

        let activeSenderId = null; let activeUsersList = []; let unreadCounts = {}; let needsHelpSet = new Set();
        let currentKnowledgeBase = []; let isEditMode = false;
        let isDataChanged = localStorage.getItem('bps_needs_training') === 'true';

        // 🔊 Audio Notifikasi
        const notifSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
        const alertSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');

        const PROTECTED_INTENTS = ['greet', 'goodbye', 'affirm', 'deny', 'mood_great', 'cari_info_website', 'trigger_alihkan_admin', 'hubungi_admin', 'teruskan_admin', 'tanya_admin'];

        // ==========================================
        // 🛠️ UTILITIES & COMPONENTS
        // ==========================================
        function logoutAdmin() { openConfirmModal('Keluar', 'Yakin ingin keluar dari Dashboard?', () => { localStorage.removeItem('bps_admin_token'); window.location.replace('/login'); }); }

        // Pengolah Markdown ke HTML
        function mdToHtml(text) {
            let html = text || '';
            html = html.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            html = html.replace(/\*(.*?)\*/g, '<i>$1</i>');
            html = html.replace(/\[(.*?)\]\((https?:\/\/.*?)\)/g, '<a href="$2" target="_blank" class="text-blue-500 underline font-semibold">$1</a>');
            html = html.replace(/(?<!href="|href=")(https?:\/\/[^\s<()]+)/g, '<a href="$1" target="_blank" class="text-blue-500 underline">$1</a>');
            return html.replace(/\n/g, '<br>');
        }
        function htmlToMd(html) {
            let text = html || '';
            text = text.replace(/<br\s*\/?>/gi, '\n');
            text = text.replace(/<b>(.*?)<\/b>/gi, '**$1**');
            text = text.replace(/<i>(.*?)<\/i>/gi, '*$1*');
            text = text.replace(/<a\s+[^>]*href=["'](.*?)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)');
            return text;
        }
        function updatePreview() { const val = document.getElementById('train-response').value; document.getElementById('live-preview-box').innerHTML = val.trim() ? mdToHtml(val) : '<span class="text-slate-400 italic">Pratinjau jawaban akan muncul di sini...</span>'; }

        // 👇 PERBAIKAN KURSOR TOOLBAR MARKDOWN 👇
        function insertMarkdown(prefix, suffix) {
            const textarea = document.getElementById('train-response');
            const startPos = textarea.selectionStart;
            const endPos = textarea.selectionEnd;
            const selectedText = textarea.value.substring(startPos, endPos);

            // Masukkan teks
            textarea.value = textarea.value.substring(0, startPos) + prefix + selectedText + suffix + textarea.value.substring(endPos);
            textarea.focus();

            // Posisikan kursor secara akurat (tepat di tengah-tengah bintang jika teks kosong)
            const newCursorPos = startPos + prefix.length + selectedText.length;
            textarea.setSelectionRange(newCursorPos, newCursorPos);

            updatePreview();
        }

        let savedSelectionStart = 0, savedSelectionEnd = 0, activeLinkTarget = 'train-response';
        function openLinkModal(targetId = 'train-response') { activeLinkTarget = targetId; const textarea = document.getElementById(activeLinkTarget); savedSelectionStart = textarea.selectionStart; savedSelectionEnd = textarea.selectionEnd; document.getElementById('link-text-input').value = textarea.value.substring(savedSelectionStart, savedSelectionEnd); document.getElementById('link-url-input').value = 'https://'; const modal = document.getElementById('link-modal'); modal.classList.replace('hidden', 'flex'); setTimeout(() => { modal.classList.remove('opacity-0'); document.getElementById('link-modal-box').classList.replace('scale-95', 'scale-100'); }, 10); }
        function closeLinkModal() { const modal = document.getElementById('link-modal'); modal.classList.add('opacity-0'); document.getElementById('link-modal-box').classList.replace('scale-100', 'scale-95'); setTimeout(() => { modal.classList.replace('flex', 'hidden'); }, 300); }
        function insertLinkToEditor() {
            const text = document.getElementById('link-text-input').value.trim() || 'Klik di sini';
            const url = document.getElementById('link-url-input').value.trim();
            if (url === '' || url === 'https://') return;
            const textarea = document.getElementById(activeLinkTarget);
            const linkMd = `[${text}](${url})`;
            textarea.value = textarea.value.substring(0, savedSelectionStart) + linkMd + textarea.value.substring(savedSelectionEnd);
            closeLinkModal();
            if (activeLinkTarget === 'train-response') updatePreview();
            textarea.focus();
        }

        function showToastAlert(title, message) {
            const toast = document.createElement('div'); toast.className = 'bg-white border-l-4 border-primary-600 shadow-2xl rounded-xl p-4 w-80 transform transition-all duration-300 translate-x-full opacity-0 flex items-start gap-3 pointer-events-auto';
            toast.innerHTML = `<div class="bg-primary-600/10 p-2 rounded-full text-primary-600 shrink-0"><span class="material-symbols-outlined text-xl">notifications_active</span></div><div><h4 class="text-sm font-bold">${title}</h4><p class="text-xs text-slate-500">${message}</p></div>`;
            document.getElementById('toast-container').appendChild(toast); setTimeout(() => toast.classList.remove('translate-x-full', 'opacity-0'), 50); setTimeout(() => { toast.classList.add('translate-x-full', 'opacity-0'); setTimeout(() => toast.remove(), 300); }, 4000);
        }

        function openConfirmModal(title, message, callback) {
            document.getElementById('confirm-title').innerText = title; document.getElementById('confirm-message').innerHTML = message;
            const modal = document.getElementById('confirm-modal'); modal.classList.replace('hidden', 'flex'); setTimeout(() => { modal.classList.remove('opacity-0'); document.getElementById('confirm-modal-box').classList.replace('scale-95', 'scale-100'); }, 10);
            document.getElementById('confirm-action-btn').onclick = () => { closeConfirmModal(); if (callback) callback(); };
        }
        function closeConfirmModal() { const modal = document.getElementById('confirm-modal'); modal.classList.add('opacity-0'); document.getElementById('confirm-modal-box').classList.replace('scale-100', 'scale-95'); setTimeout(() => modal.classList.replace('flex', 'hidden'), 300); }

        // ==========================================
        // 📊 KNOWLEDGE BASE & CRUD
        // ==========================================
        async function fetchKnowledgeBase() {
            const grid = document.getElementById('knowledge-base-grid'); 
            if(grid) grid.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">Mengambil data AI...</div>`;
            try { 
                const response = await fetch('/api/bot/intents', { headers: { 'Authorization': `Bearer ${adminToken}` } }); 
                currentKnowledgeBase = await response.json(); 
                renderKnowledgeTable(currentKnowledgeBase); 
            } catch (e) { 
                if(grid) grid.innerHTML = `<div class="col-span-full text-center text-red-500 py-10">Gagal terhubung.</div>`; 
            }
        }

        function renderKnowledgeTable(dataArray) {
            const grid = document.getElementById('knowledge-base-grid'); 
            if(!grid) return;
            grid.innerHTML = '';
            
            if (dataArray.length === 0) {
                grid.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">Tidak ada data.</div>`;
                return;
            }
            
            dataArray.forEach(item => {
                const isSystem = PROTECTED_INTENTS.includes(item.intent);
                
                // Highlight {variable} in response with exact styling from user's code
                const highlightedResponse = (item.response || '').replace(/\{([^}]+)\}/g, '<span class="bg-[#faf8ff] px-1 py-0.5 rounded border border-[#c3c6d7] text-[#fd761a] font-mono text-[12px]">{$1}</span>');

                // Action buttons (edit/delete)
                let btns = isSystem ? '' : `
                    <div class="flex items-center transition-opacity opacity-100">
                        <button onclick="editIntent('${item.intent}')" class="w-8 h-8 rounded flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-blue-600 transition-colors" title="Edit Intent">
                            <span class="material-symbols-outlined text-[20px]">edit</span>
                        </button>
                        <button onclick="deleteIntent('${item.intent}')" class="w-8 h-8 rounded flex items-center justify-center text-slate-500 hover:bg-red-50 hover:text-red-600 transition-colors" title="Delete Intent">
                            <span class="material-symbols-outlined text-[20px]">delete</span>
                        </button>
                    </div>`;
                
                const statusBadge = isSystem 
                    ? `<span class="bg-[#dae2fd] text-[#434655] font-semibold text-[12px] px-2 py-0.5 rounded-full border border-[#c3c6d7]/50">SYSTEM</span>` 
                    : `<span class="bg-[#004ac6]/10 text-[#004ac6] font-semibold text-[12px] px-2 py-0.5 rounded-full border border-[#004ac6]/20">ACTIVE</span>`;

                // Handle examples
                let examplesArr = [];
                if (typeof item.examples === 'string') {
                    examplesArr = item.examples.split('\n').map(s => s.replace(/^-\s*/, '').trim()).filter(Boolean);
                } else if (Array.isArray(item.examples)) {
                    examplesArr = item.examples;
                }
                
                // Show max 4 chips initially
                const MAX_CHIPS = 4;
                const remaining = examplesArr.length > MAX_CHIPS ? examplesArr.length - MAX_CHIPS : 0;
                
                let chipsHtml = '';
                examplesArr.forEach((ex, idx) => {
                    const extraClass = idx >= MAX_CHIPS ? 'hidden extra-chip' : '';
                    chipsHtml += `<span class="bg-[#f2f3ff] text-[#131b2e] border border-[#c3c6d7]/50 px-3 py-1 rounded-md text-[13px] ${extraClass}">${ex}</span>`;
                });
                
                const moreChip = remaining > 0 
                    ? `<span onclick="this.style.display='none'; Array.from(this.parentElement.querySelectorAll('.extra-chip')).forEach(el => el.classList.remove('hidden'));" class="text-[#004ac6] font-semibold text-[12px] self-center ml-1 cursor-pointer hover:underline">+${remaining} more</span>` 
                    : '';

                const div = document.createElement('div');
                div.className = "bg-white rounded-xl shadow-[0_4px_6px_-1px_rgba(15,23,42,0.05),0_2px_4px_-2px_rgba(15,23,42,0.03)] border border-slate-200/60 flex flex-col hover:border-blue-500/30 transition-colors group";
                div.innerHTML = `
                    <!-- Card Header -->
                    <div class="p-5 border-b border-slate-200/60 flex items-start justify-between gap-3">
                        <div class="flex flex-col gap-1 min-w-0">
                            <div class="flex items-center gap-3">
                                <h3 class="font-semibold text-lg text-slate-900 truncate" title="${item.intent}">${item.intent}</h3>
                                ${statusBadge}
                            </div>
                            <span class="text-[13px] text-slate-500 truncate">${examplesArr[0] || 'No description'}</span>
                        </div>
                        ${btns}
                    </div>

                    <!-- Card Body -->
                    <div class="p-5 flex flex-col gap-5 flex-1">
                        <!-- Utterances -->
                        <div class="flex flex-col gap-3">
                            <div class="flex items-center justify-between">
                                <span class="font-semibold text-[14px] text-[#5e6e85]">Training Phrases (${examplesArr.length})</span>
                            </div>
                            <div class="flex flex-wrap gap-2">
                                ${chipsHtml}
                                ${moreChip}
                            </div>
                        </div>

                        <!-- Bot Response -->
                        <div class="flex flex-col gap-3 mt-auto">
                            <span class="font-semibold text-[14px] text-[#5e6e85]">Bot Response Template</span>
                            <div class="bg-[#eaedff] rounded-lg p-3 text-[14px] text-[#131b2e] border border-[#c3c6d7]/30 flex items-start gap-3">
                                <span class="material-symbols-outlined text-[#004ac6] text-[20px] shrink-0 mt-0.5">smart_toy</span>
                                <div class="leading-relaxed whitespace-pre-line max-h-28 overflow-y-auto custom-scrollbar">${highlightedResponse || '<span class="text-slate-400 italic">Tidak ada respons</span>'}</div>
                            </div>
                        </div>
                    </div>
                `;
                grid.appendChild(div);
            });
        }


        function filterKnowledge() {
            const q = document.getElementById('knowledge-search').value.toLowerCase();
            
            // Check if item.examples is an array or string
            renderKnowledgeTable(currentKnowledgeBase.filter(i => {
                let examplesStr = '';
                if (typeof i.examples === 'string') {
                    examplesStr = i.examples.toLowerCase();
                } else if (Array.isArray(i.examples)) {
                    examplesStr = i.examples.join(' ').toLowerCase();
                }
                
                return (i.intent || '').toLowerCase().includes(q) || 
                       examplesStr.includes(q) || 
                       (i.response || '').toLowerCase().includes(q);
            }));
        }

        function deleteIntent(intentName) {
            openConfirmModal('Hapus Topik AI', `Yakin menghapus topik <b>[${intentName}]</b> secara permanen?`, async () => {
                try {
                    const r = await fetch(`/api/bot/intents/${intentName}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${adminToken}` } });
                    if (r.ok) {
                        isDataChanged = true; localStorage.setItem('bps_needs_training', 'true'); showTrainBanner();
                        fetchKnowledgeBase(); showToastAlert('🗑️ Berhasil', `Topik ${intentName} dihapus.`);
                    }
                    else { const res = await r.json(); showToastAlert('❌ Gagal', res.error); if (r.status === 403) logoutAdmin(); }
                } catch (e) { showToastAlert('❌ Error', 'Jaringan terputus.'); }
            });
        }

        function editIntent(intentName) {
            const item = currentKnowledgeBase.find(i => i.intent === intentName); if (!item) return;
            openTrainModal(false);
            document.getElementById('modal-icon').innerText = 'edit_note'; document.getElementById('modal-title-text').innerText = 'Edit Ilmu AI';
            const intentInput = document.getElementById('train-intent'); intentInput.value = item.intent; intentInput.readOnly = true; intentInput.className = "w-full bg-slate-200 border-none rounded-lg p-2.5 text-sm text-slate-500 cursor-not-allowed";
            document.getElementById('train-examples').value = item.examples.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(l => l.length > 0).join('\n');
            document.getElementById('train-response').value = htmlToMd(item.response); updatePreview();
        }

        // ==========================================
        // 🤖 TRAINING LOGIC
        // ==========================================
        let loadingInterval;
        const botPhrases = ["Mengurai data NLU...", "Sinkronisasi dataset intent...", "Optimasi Neural Network...", "Membangun logika percakapan...", "Validasi integritas sistem..."];

        function startSmartLoading() {
            document.getElementById('form-inputs').classList.add('hidden'); document.getElementById('smart-loading-container').classList.replace('hidden', 'flex'); document.getElementById('train-submit-btn').classList.add('hidden'); document.getElementById('train-cancel-btn').disabled = true;
            document.getElementById('spinner-circle').className = "absolute inset-0 border-4 border-primary-600 rounded-full border-t-transparent animate-spin"; document.getElementById('spinner-icon').innerText = 'psychology';
            
            // Reset Smart Loading Elements
            document.getElementById('loading-bar-wrapper')?.classList.remove('hidden');
            const doneBtn = document.getElementById('train-done-btn');
            if (doneBtn) {
                doneBtn.classList.add('hidden');
                doneBtn.classList.remove('flex');
            }
            const header = document.getElementById('loading-header');
            if (header) header.innerText = "Mengajari AI Bot...";

            const textEl = document.getElementById('loading-text'); const progressEl = document.getElementById('loading-progress');
            textEl.className = "text-sm font-medium text-slate-500 mb-5 text-center px-4"; textEl.innerText = botPhrases[0]; progressEl.style.width = '10%'; progressEl.className = "h-full bg-primary-600 rounded-full w-0 transition-all duration-[2000ms] ease-out";
            let i = 0; loadingInterval = setInterval(() => { i = (i + 1) % botPhrases.length; textEl.innerText = botPhrases[i]; let w = parseFloat(progressEl.style.width) || 10; if (w < 90) progressEl.style.width = (w + 4) + '%'; }, 3000);
        }

        function stopSmartLoading(isSuccess, message) {
            clearInterval(loadingInterval);
            const p = document.getElementById('loading-progress'), c = document.getElementById('spinner-circle'), t = document.getElementById('loading-text');
            p.style.width = '100%'; c.classList.remove('animate-spin');
            if (isSuccess) { 
                p.classList.replace('bg-primary-600', 'bg-green-500'); 
                document.getElementById('spinner-icon').innerText = 'check_circle'; 
                t.innerText = message; 
                t.className = "text-sm text-green-600 mb-5 font-bold text-center px-4"; 
                
                // Hide progress bar, show 'Selesai' button
                document.getElementById('loading-bar-wrapper')?.classList.add('hidden');
                const doneBtn = document.getElementById('train-done-btn');
                if (doneBtn) {
                    doneBtn.classList.remove('hidden');
                    doneBtn.classList.add('flex');
                }
                const header = document.getElementById('loading-header');
                if (header) header.innerText = "Proses Selesai!";
            }
            else { 
                p.classList.replace('bg-primary-600', 'bg-red-500'); 
                document.getElementById('spinner-icon').innerText = 'error'; 
                t.innerText = message; 
                t.className = "text-sm text-red-600 mb-5 font-bold text-center px-4"; 
                document.getElementById('train-cancel-btn').disabled = false;
            }
        }

        function openTrainModal(isAdd = true) {
            const modal = document.getElementById('train-modal'); modal.classList.replace('hidden', 'flex'); setTimeout(() => { modal.classList.remove('opacity-0'); document.getElementById('train-modal-box').classList.replace('scale-95', 'scale-100'); }, 10);
            if (isAdd) { isEditMode = false; document.getElementById('train-form').reset(); document.getElementById('modal-icon').innerText = 'model_training'; document.getElementById('modal-title-text').innerText = 'Suntik Ilmu Baru & Latih AI'; document.getElementById('train-intent').readOnly = false; document.getElementById('train-intent').className = "w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/50 transition-colors"; updatePreview(); }
            else { isEditMode = true; }
        }

        function closeTrainModal() {
            const modal = document.getElementById('train-modal'); modal.classList.add('opacity-0'); document.getElementById('train-modal-box').classList.replace('scale-100', 'scale-95');
            setTimeout(() => { 
                modal.classList.replace('flex', 'hidden'); 
                document.getElementById('form-inputs').classList.remove('hidden'); 
                document.getElementById('smart-loading-container').classList.replace('flex', 'hidden'); 
                document.getElementById('train-submit-btn').classList.remove('hidden'); 
                document.getElementById('train-cancel-btn').disabled = false; 

                // Reset modal states for subsequent uses
                document.getElementById('loading-bar-wrapper')?.classList.remove('hidden');
                const doneBtn = document.getElementById('train-done-btn');
                if (doneBtn) {
                    doneBtn.classList.add('hidden');
                    doneBtn.classList.remove('flex');
                }
                const header = document.getElementById('loading-header');
                if (header) header.innerText = "Mengajari AI Bot...";
            }, 300);
            
            // Jika training sudah sukses (isDataChanged = false), sembunyikan banner saat modal ditutup
            if (!isDataChanged) { hideTrainBanner(); }
        }

        async function submitTrainData(e) {
            e.preventDefault(); 
            const intentName = document.getElementById('train-intent').value, examples = document.getElementById('train-examples').value, botResponse = mdToHtml(document.getElementById('train-response').value);
            
            if (!intentName) return showToastAlert('⚠️ Peringatan', 'Nama Intent kosong!');

            try { 
                const r = await fetch('/api/bot/intents', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` }, body: JSON.stringify({ intentName, examples, botResponse }) }); 
                if (r.ok) { 
                    isDataChanged = true; 
                    localStorage.setItem('bps_needs_training', 'true'); 
                    showTrainBanner(); 
                    fetchKnowledgeBase(); 
                    closeTrainModal(); 
                    showToastAlert('✅ Disimpan', 'Data tersimpan ke sistem. Latih AI untuk menerapkan.'); 
                } else { 
                    const err = await r.json(); 
                    showToastAlert('❌ Gagal', err.error); 
                } 
            } catch (err) { 
                showToastAlert('❌ Error', 'Jaringan bermasalah.'); 
            }
        }

        function showTrainBanner() {
            const el = document.getElementById('floating-train-reminder');
            if (!el) return;
            el.style.transform = 'translateX(-50%) translateY(0)';
            el.style.opacity = '1';
            el.style.pointerEvents = 'auto';
        }

        function hideTrainBanner() {
            const el = document.getElementById('floating-train-reminder');
            if (!el) return;
            el.style.transform = 'translateX(-50%) translateY(6rem)';
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
        }

        function triggerAITraining() {
            startSmartLoading();
            const modal = document.getElementById('train-modal'); 
            modal.classList.replace('hidden', 'flex'); 
            setTimeout(() => { modal.classList.remove('opacity-0'); document.getElementById('train-modal-box').classList.replace('scale-95', 'scale-100'); }, 10);
            socket.emit('train_bot', { intentName: 'SKIP_WRITE', examples: '-', botResponse: '-' });
        }

        function onTrainDone() {
            isDataChanged = false; localStorage.removeItem('bps_needs_training');
            hideTrainBanner();
            closeTrainModal();
        }

        socket.on('train_success', (msg) => {
            stopSmartLoading(true, "AI Berhasil Disinkronisasi!"); showToastAlert('🎉 Berhasil!', msg);
            fetchKnowledgeBase();
        });
        socket.on('train_error', (msg) => { stopSmartLoading(false, "Gagal Melatih Model AI"); showToastAlert('❌ Gagal', msg); document.getElementById('train-cancel-btn').disabled = false; });

        // ==========================================
        // 💬 CHAT LOGIC (WARGA & ADMIN)
        // ==========================================
        let onlineUsersSet = new Set();
        socket.on('user_list', (data) => {
            if (Array.isArray(data)) {
                activeUsersList = data; // Kompatibilitas mundur
            } else {
                activeUsersList = data.userList;
                onlineUsersSet = new Set(data.onlineUsers || []);
            }
            renderUserList();
        });

        // Fitur Alias / Ubah Nama Warga otomatis maupun manual
        let userAliases = JSON.parse(localStorage.getItem('bps_user_aliases')) || {};
        
        socket.on('user_name_updated', (data) => {
            if (data.senderId && data.name) {
                userAliases[data.senderId] = data.name;
                localStorage.setItem('bps_user_aliases', JSON.stringify(userAliases));
                renderUserList();
                if (activeSenderId === data.senderId) {
                    const cb = document.getElementById('chat-box');
                    // Render ulang header
                    const hdrTxt = document.getElementById('header-status-text');
                    const isOnline = onlineUsersSet.has(activeSenderId);
                    hdrTxt.innerHTML = `<span class="font-bold block">${data.name}</span><span class="${isOnline ? 'text-green-200' : 'text-slate-300'}">${isOnline ? 'Online' : 'Offline'}</span>`;
                }
            }
        });

        function renderUserList() {
            const query = document.getElementById('search-user-input').value.toLowerCase();
            const filtered = activeUsersList.filter(id => {
                const alias = userAliases[id] || id;
                return id.toLowerCase().includes(query) || alias.toLowerCase().includes(query);
            });
            const userListEl = document.getElementById('user-list'); userListEl.innerHTML = ''; document.getElementById('active-count').innerText = `${activeUsersList.length} ACTIVE`;
            if (filtered.length === 0) return userListEl.innerHTML = `<div class="p-8 text-center text-slate-400 text-sm">Tidak ada warga.</div>`;
            filtered.forEach(id => {
                const displayName = userAliases[id] || id;
                const active = activeSenderId === id, unread = unreadCounts[id] || 0, help = needsHelpSet.has(id);
                let bgCls = active ? 'border-primary-600 bg-primary-50' : 'border-transparent hover:bg-slate-50';
                if (help && !active) bgCls = 'border-orange-500 bg-orange-50';
                
                const isOnline = onlineUsersSet.has(id);
                const indicatorColor = isOnline ? 'bg-green-500' : 'bg-slate-300';
                
                const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=f1f5f9&color=64748b`;
                const helpText = help ? `<p class="text-xs text-orange-500 italic truncate mt-0.5"><i class="fa-solid fa-robot mr-1"></i> User requested human agent.</p>` : `<p class="text-xs text-slate-500 truncate mt-0.5">Klik untuk melihat pesan</p>`;
                const unreadBadge = unread > 0 ? `<div class="shrink-0 flex items-center justify-center w-5 h-5 bg-primary-600 text-white text-[9px] font-bold rounded-full">${unread}</div>` : '';
                
                const div = document.createElement('div');
                div.className = `p-4 border-l-4 ${bgCls} cursor-pointer flex gap-3 relative group`;
                div.onclick = () => { switchTab('live-chat'); selectUser(id); };
                
                div.innerHTML = `
                    <div class="relative shrink-0">
                        <img src="${avatarUrl}" class="w-10 h-10 rounded-full" alt="Avatar">
                        <span class="absolute bottom-0 right-0 w-3 h-3 ${indicatorColor} border-2 border-white rounded-full"></span>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between items-start">
                            <h3 class="text-sm font-bold text-slate-800 truncate flex items-center gap-1">
                                <span>${displayName}</span>
                                <button onclick="event.stopPropagation(); window.editAlias('${id}')" class="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-primary-600 transition-opacity" title="Ubah Nama"><i class="fa-solid fa-pen text-[10px]"></i></button>
                            </h3>
                            <span class="text-[10px] text-slate-400 font-medium">Aktif</span>
                        </div>
                        ${helpText}
                    </div>
                    ${unreadBadge}
                `;
                userListEl.appendChild(div);
            });

            // Render dan Sinkronisasi Header yang Sedang Aktif
            if (activeSenderId) {
                const isOnline = onlineUsersSet.has(activeSenderId);
                const hdrInd = document.getElementById('header-online-indicator');
                const hdrDot = document.getElementById('header-status-dot');
                const hdrTxt = document.getElementById('header-status-text');
                const hdrContainer = document.getElementById('header-status-container');
                const hdrAvatar = document.getElementById('header-avatar');
                const activeName = userAliases[activeSenderId] || activeSenderId;

                hdrAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(activeName)}&background=f1f5f9&color=64748b`;
                hdrInd.classList.remove('hidden');
                hdrContainer.classList.remove('hidden');

                if (isOnline) {
                    hdrInd.className = "absolute bottom-0 right-0 w-3 h-3 bg-green-500 border-2 border-white rounded-full shadow-sm";
                    hdrDot.className = "w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse";
                    hdrTxt.innerText = "Status: Terhubung (Online)";
                } else {
                    hdrInd.className = "absolute bottom-0 right-0 w-3 h-3 bg-slate-300 border-2 border-white rounded-full";
                    hdrDot.className = "w-1.5 h-1.5 rounded-full bg-slate-300";
                    hdrTxt.innerText = "Status: Terputus (Offline)";
                }
            }
        }

        async function selectUser(id) {
            const displayName = userAliases[id] || id;
            activeSenderId = id; 
            document.getElementById('active-user-title').innerText = displayName; 
            unreadCounts[id] = 0; 
            renderUserList(); 
            const chatBox = document.getElementById('chat-box'); 
            chatBox.innerHTML = '';
            try { 
                const r = await fetch(`/api/chat/history/${id}`, { headers: { 'Authorization': `Bearer ${adminToken}` } }); 
                const h = await r.json(); 
                if (h.length === 0) chatBox.innerHTML = '<div class="m-auto text-slate-400 text-sm">Belum ada riwayat.</div>'; 
                else h.forEach(c => appendMessage(c.sender_type, c.message, c.created_at)); 
            } catch (e) { }
        }

        socket.on('receive_message', (d) => {
            if (d.senderType === 'bot' && d.message.includes('meneruskan pesan')) { needsHelpSet.add(d.senderId); showToastAlert('🚨 Darurat!', `Warga <b>${d.senderId}</b> butuh bantuan.`); alertSound.play(); renderUserList(); }
            if (activeSenderId === d.senderId) { const cb = document.getElementById('chat-box'); if (cb.innerHTML.includes('Belum ada')) cb.innerHTML = ''; appendMessage(d.senderType === 'warga' ? 'user' : d.senderType, d.message, new Date()); }
            else if (d.senderType === 'warga') { unreadCounts[d.senderId] = (unreadCounts[d.senderId] || 0) + 1; if (!needsHelpSet.has(d.senderId)) notifSound.play(); renderUserList(); }
        });

        function appendMessage(sender, text, time) {
            const timeStr = (time ? new Date(time) : new Date()).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); 
            const div = document.createElement('div'); 
            const cb = document.getElementById('chat-box');
            const parsedText = mdToHtml(text);
            
            if (sender === 'user' || sender === 'warga') {
                const aliasName = (userAliases[activeSenderId] || 'WARGA');
                div.className = 'flex flex-col gap-1 items-start max-w-[85%] fade-in'; 
                div.innerHTML = `
                    <span class="text-[10px] font-semibold text-slate-500 ml-1">${aliasName}</span>
                    <div class="bg-white border border-slate-200 text-slate-700 p-3.5 rounded-2xl rounded-tl-sm shadow-sm text-sm leading-relaxed whitespace-pre-line">${parsedText}</div>
                    <span class="text-[10px] text-slate-400 ml-1 mt-0.5">${timeStr}</span>
                `;
            }
            else if (sender === 'bot') { 
                div.className = 'flex flex-col gap-1 items-start self-start max-w-[85%] fade-in'; 
                div.innerHTML = `
                    <span class="text-[10px] font-semibold text-slate-500 ml-1">BIPS AI Bot <i class="fa-solid fa-robot ml-1 text-bot-cyan"></i></span>
                    <div class="bg-bot-cyan/10 border border-bot-cyan/30 text-slate-800 p-3.5 rounded-2xl rounded-tl-sm shadow-sm text-sm leading-relaxed whitespace-pre-line">${parsedText}</div>
                    <span class="text-[10px] text-slate-400 ml-1 mt-0.5">${timeStr}</span>
                `; 
            }
            else { 
                div.className = 'flex flex-col gap-1 items-end self-end max-w-[85%] fade-in'; 
                div.innerHTML = `
                    <span class="text-[10px] font-semibold text-slate-500 mr-1">You (Admin)</span>
                    <div class="bg-primary-600 text-white p-3.5 rounded-2xl rounded-tr-sm shadow-sm text-sm leading-relaxed whitespace-pre-line">${parsedText}</div>
                    <span class="text-[10px] text-slate-400 mr-1 mt-0.5">${timeStr} <i class="fa-solid fa-check-double text-blue-400 ml-1"></i></span>
                `; 
            }
            cb.appendChild(div); cb.scrollTop = cb.scrollHeight;
        }

        function deleteChatHistory() {
            if (!activeSenderId) return showToastAlert('⚠️ Maaf', "Pilih warga dulu!");
            openConfirmModal('Hapus Riwayat', `Hapus chat dengan <b>${activeSenderId}</b> permanen?`, async () => { try { if ((await fetch(`/api/chat/history/${activeSenderId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${adminToken}` } })).ok) { document.getElementById('chat-box').innerHTML = `<div class="m-auto text-green-500 text-sm">Terhapus!</div>`; delete unreadCounts[activeSenderId]; needsHelpSet.delete(activeSenderId); renderUserList(); } } catch (e) { } });
        }

        function sendMessage() {
            const inp = document.getElementById('admin-input'); const text = inp.value.trim(); if (!activeSenderId || !text) return;
            socket.emit('admin_message', { targetSenderId: activeSenderId, message: text });
            if (text !== '/selesai') {
                appendMessage('admin', text, new Date());
            } else {
                needsHelpSet.delete(activeSenderId);
                renderUserList();

                // Notifikasi visual untuk Admin
                const cb = document.getElementById('chat-box');
                const div = document.createElement('div');
                div.className = 'flex justify-center my-4 fade-in w-full';
                div.innerHTML = `<div class="bg-slate-100 text-slate-500 border border-slate-200 text-[11px] font-bold px-4 py-1.5 rounded-full flex items-center gap-1.5 shadow-sm"><i class="fa-solid fa-circle-check text-green-500"></i> Anda telah mengakhiri sesi obrolan (Bot AI kembali mengambil alih)</div>`;
                cb.appendChild(div);
                cb.scrollTop = cb.scrollHeight;
                showToastAlert('🔌 Sesi Diakhiri', 'Chat dikembalikan ke Asisten Virtual BIPS.');
            }
            inp.value = '';
        }

        // Fitur klik saran balas cepat (Quick Replies)
        function insertAndSend(text) {
            document.getElementById('admin-input').value = text;
            sendMessage();
        }

        window.closeAliasModal = function () {
            const modal = document.getElementById('alias-modal');
            modal.classList.add('opacity-0');
            document.getElementById('alias-modal-box').classList.replace('scale-100', 'scale-95');
            setTimeout(() => { modal.classList.replace('flex', 'hidden'); }, 300);
        };

        window.confirmEditAlias = function () {
            if (!activeAliasTargetId) return closeAliasModal();
            const id = activeAliasTargetId;
            const newName = document.getElementById('alias-name-input').value;

            if (newName.trim() === '') {
                delete userAliases[id];
                showToastAlert('✅ Nama Direset', 'Dikembalikan ke ID Warga bawaan.');
            } else {
                userAliases[id] = newName.trim();
                showToastAlert('✅ Berhasil', 'Nama panggilan warga tersimpan.');
            }

            localStorage.setItem('bps_user_aliases', JSON.stringify(userAliases));
            renderUserList();
            if (activeSenderId === id) { selectUser(id); }
            closeAliasModal();
        };

        let activeAliasTargetId = null;
        window.editAlias = function (id) {
            activeAliasTargetId = id;
            const currentName = userAliases[id] || id;
            const input = document.getElementById('alias-name-input');
            input.value = currentName !== id ? currentName : '';

            const modal = document.getElementById('alias-modal');
            modal.classList.replace('hidden', 'flex');
            setTimeout(() => {
                modal.classList.remove('opacity-0');
                document.getElementById('alias-modal-box').classList.replace('scale-95', 'scale-100');
                input.focus();
            }, 10);
        };

        document.getElementById('alias-name-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') window.confirmEditAlias();
        });

        document.getElementById('send-btn').addEventListener('click', sendMessage); document.getElementById('admin-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
        
        // Add search listeners
        document.getElementById('search-user-input').addEventListener('input', renderUserList);
        document.getElementById('knowledge-search').addEventListener('input', filterKnowledge);

        // ==========================================
        // 📚 DOKUMEN EKSTERNAL RAG (PDF)
        // ==========================================
        async function fetchExternalDocs() {
            try {
                const res = await fetch('/api/bot/docs', { headers: { 'Authorization': `Bearer ${adminToken}` } });
                const docs = await res.json();
                const grid = document.getElementById('rag-documents-grid');

                if (!grid) return;
                grid.innerHTML = '';

                if (docs.length === 0) {
                    grid.innerHTML = `<div class="text-center text-slate-400 py-10">Belum ada dokumen eksternal.</div>`;
                    return;
                }

                docs.forEach(doc => {
                    let ext = doc.filename.split('.').pop().toLowerCase();
                    let icon = 'fa-file';
                    let bg = 'bg-slate-50', textCol = 'text-slate-500', border = 'border-slate-100';
                    if(ext === 'pdf') { icon = 'fa-file-pdf'; bg = 'bg-red-50'; textCol = 'text-red-500'; border = 'border-red-100'; }
                    else if(ext === 'txt') { icon = 'fa-file-lines'; bg = 'bg-blue-50'; textCol = 'text-blue-500'; border = 'border-blue-100'; }
                    else if(ext === 'doc' || ext === 'docx') { icon = 'fa-file-word'; bg = 'bg-blue-50'; textCol = 'text-blue-500'; border = 'border-blue-100'; }

                    const div = document.createElement('div');
                    div.className = "flex items-center gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors bg-white shadow-sm cursor-pointer";
                    div.innerHTML = `
                        <div class="w-10 h-10 ${bg} ${border} ${textCol} rounded-lg flex items-center justify-center text-lg shrink-0">
                            <i class="fa-solid ${icon}"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <h5 class="text-xs font-bold text-slate-700 truncate">${doc.filename}</h5>
                            <p class="text-[10px] text-slate-400 mt-0.5 font-medium">${doc.size}</p>
                        </div>
                        <button onclick="deleteExternalDoc('${doc.filename}')" class="w-6 h-6 flex items-center justify-center text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50 transition-colors"><i class="fa-solid fa-trash"></i></button>
                    `;
                    grid.appendChild(div);
                });

            } catch (err) { console.error("Gagal load docs:", err); }
        }

        async function handlePDFUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('file', file);

            const btnLabel = event.target.previousElementSibling.querySelector('.font-bold');
            const originalText = btnLabel.innerText;
            btnLabel.innerText = "Mengunggah...";

            try {
                const res = await fetch('/api/bot/upload-pdf', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${adminToken}` },
                    body: formData
                });

                const data = await res.json();
                if (res.ok) {
                    showToastAlert('✅ Berhasil', data.message);
                    fetchExternalDocs();
                } else {
                    showToastAlert('❌ Gagal', data.error || 'Terjadi kesalahan sistem.');
                }
            } catch (err) {
                showToastAlert('❌ Gagal', 'Koneksi ke server terputus.');
            } finally {
                btnLabel.innerText = originalText;
                event.target.value = ''; // reset
            }
        }

        async function deleteExternalDoc(filename) {
            openConfirmModal('Hapus Dokumen?', `Dokumen "${filename}" akan dilupakan oleh AI. Yakin?`, async () => {
                try {
                    const res = await fetch(`/api/bot/docs/${encodeURIComponent(filename)}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${adminToken}` }
                    });
                    if (res.ok) {
                        showToastAlert('🗑️ Terhapus', 'Dokumen berhasil dihapus.');
                        fetchExternalDocs();
                    }
                } catch (e) { showToastAlert('❌ Gagal', 'Gagal menghubungi server.'); }
            });
        }

        async function fetchTokenUsage() {
            try {
                const res = await fetch('/api/bot/token-usage', { headers: { 'Authorization': `Bearer ${adminToken}` } });
                if (!res.ok) return;
                const data = await res.json();

                const groqText = document.getElementById('groq-usage-text');
                if (groqText) groqText.innerText = data.groq.toLocaleString();
                
                const geminiText = document.getElementById('gemini-usage-text');
                if (geminiText) geminiText.innerText = data.gemini.toLocaleString();

            } catch (e) { console.error('Gagal load token usage:', e); }
        }

        // Initialize Fetching RAG
        fetchExternalDocs();
        fetchTokenUsage();
    