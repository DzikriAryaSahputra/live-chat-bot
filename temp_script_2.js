
        function toggleProfileMenu() {
            const menu = document.getElementById('profile-menu');
            const chevron = document.getElementById('profile-chevron');
            if (menu.classList.contains('hidden')) {
                menu.classList.remove('hidden');
                menu.classList.add('flex');
                chevron.classList.add('rotate-180');
            } else {
                menu.classList.add('hidden');
                menu.classList.remove('flex');
                chevron.classList.remove('rotate-180');
            }
        }

        // Close menu when clicking outside
        document.addEventListener('click', function (event) {
            const menu = document.getElementById('profile-menu');
            const profileArea = document.querySelector('.border-t.border-slate-100.relative');

            if (!profileArea.contains(event.target)) {
                menu.classList.add('hidden');
                menu.classList.remove('flex');
                document.getElementById('profile-chevron').classList.remove('rotate-180');
            }
        });

        function switchTab(tabId) {
            // Update nav buttons
            document.querySelectorAll('.nav-item').forEach(el => {
                el.classList.remove('active', 'text-primary-600', 'bg-primary-50', 'font-semibold');
                el.classList.add('text-slate-500');
            });
            const activeNav = document.getElementById('nav-' + tabId);
            activeNav.classList.remove('text-slate-500');
            activeNav.classList.add('active', 'text-primary-600', 'bg-primary-50', 'font-semibold');

            // Update content sections
            document.querySelectorAll('.tab-content').forEach(el => {
                el.classList.remove('active');
            });
            document.getElementById('tab-' + tabId).classList.add('active');

            // API Integrations
            if (tabId === 'knowledge-base') {
                fetchKnowledgeBase();
            } else if (tabId === 'ai-management') {
                fetchExternalDocs();
                fetchTokenUsage();
            }
        }
    