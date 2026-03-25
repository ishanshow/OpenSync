// OpenSync Popup Script

document.addEventListener('DOMContentLoaded', async () => {
    // DOM Elements
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');
    const notConnectedSection = document.getElementById('notConnectedSection');
    const roomSection = document.getElementById('roomSection');
    const activeRoomSection = document.getElementById('activeRoomSection');
    const createRoomBtn = document.getElementById('createRoomBtn');
    const roomCodeInput = document.getElementById('roomCodeInput');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const activeRoomCode = document.getElementById('activeRoomCode');
    const copyCodeBtn = document.getElementById('copyCodeBtn');
    const participantCount = document.getElementById('participantCount');
    const leaveRoomBtn = document.getElementById('leaveRoomBtn');
    const serverUrlInput = document.getElementById('serverUrlInput');
    const platformBtns = document.querySelectorAll('.platform-btn');
    const activePlatform = document.getElementById('activePlatform');
    const serverStatusBtn = document.getElementById('serverStatusBtn');
    const refreshServerBtn = document.getElementById('refreshServerBtn');
    const welcomeSection = document.getElementById('welcomeSection');
    const welcomeNameInput = document.getElementById('welcomeNameInput');
    const welcomeSaveBtn = document.getElementById('welcomeSaveBtn');
    const welcomeSkipBtn = document.getElementById('welcomeSkipBtn');
    const activeUsernameInput = document.getElementById('activeUsernameInput');
    const globalModeHint = document.getElementById('globalModeHint');

    const ADJECTIVES = [
        'Swift', 'Brave', 'Lucky', 'Cosmic', 'Bright', 'Cool', 'Calm',
        'Happy', 'Zen', 'Bold', 'Chill', 'Witty', 'Vivid', 'Slick',
        'Keen', 'Nifty', 'Snowy', 'Sunny', 'Misty', 'Lazy'
    ];
    const NOUNS = [
        'Panda', 'Fox', 'Wolf', 'Hawk', 'Bear', 'Tiger', 'Eagle',
        'Otter', 'Lynx', 'Raven', 'Koala', 'Falcon', 'Owl', 'Moose',
        'Puma', 'Whale', 'Cobra', 'Bison', 'Heron', 'Mango'
    ];

    function generateFriendlyName() {
        const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
        const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
        return adj + noun;
    }

    // State
    let canUseOpenSync = false;
    let hasContentScript = false;
    let currentRoom = null;
    let activeTabId = null;
    let selectedPlatform = null;
    let currentTabPlatform = null;
    let serverCheckInFlight = false;

    const PLATFORM_URLS = {
        youtube: 'https://www.youtube.com',
        netflix: 'https://www.netflix.com',
        primevideo: 'https://www.primevideo.com',
        hotstar: 'https://www.hotstar.com'
    };
    let onboardingComplete = false;

    // --- Helper functions ---

    function getHealthUrl() {
        const wsUrl = serverUrlInput.value || 'wss://opensync.onrender.com';
        return wsUrl
            .replace(/^wss:\/\//, 'https://')
            .replace(/^ws:\/\//, 'http://') + '/health';
    }

    function setServerStatus(status) {
        serverStatusBtn.classList.remove('status-checking', 'status-online', 'status-offline');
        refreshServerBtn.classList.remove('refreshing');

        if (status === 'checking') {
            serverStatusBtn.classList.add('status-checking');
            serverStatusBtn.title = 'Checking server...';
            refreshServerBtn.classList.add('refreshing');
        } else if (status === 'online') {
            serverStatusBtn.classList.add('status-online');
            serverStatusBtn.title = 'Server is online';
        } else if (status === 'offline') {
            serverStatusBtn.classList.add('status-offline');
            serverStatusBtn.title = 'Server is offline — click to retry';
        } else {
            serverStatusBtn.title = 'Server status unknown';
        }
    }

    async function checkServerHealth() {
        if (serverCheckInFlight) return;
        serverCheckInFlight = true;
        setServerStatus('checking');

        try {
            const res = await fetch(getHealthUrl(), { signal: AbortSignal.timeout(10000) });
            setServerStatus(res.ok ? 'online' : 'offline');
        } catch {
            setServerStatus('offline');
        } finally {
            serverCheckInFlight = false;
        }
    }

    async function wakeAndCheck() {
        if (serverCheckInFlight) return;
        serverCheckInFlight = true;
        setServerStatus('checking');

        const url = getHealthUrl();
        const MAX = 24;
        const INTERVAL = 5000;

        for (let i = 1; i <= MAX; i++) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
                if (res.ok) {
                    setServerStatus('online');
                    serverCheckInFlight = false;
                    return;
                }
            } catch { /* keep trying */ }

            if (i < MAX) {
                await new Promise(r => setTimeout(r, INTERVAL));
            }
        }

        setServerStatus('offline');
        serverCheckInFlight = false;
    }

    function getUsername() {
        const usernameInput = document.getElementById('usernameInput');
        let name = usernameInput.value.trim();
        if (!name) {
            name = generateFriendlyName();
            usernameInput.value = name;
        }
        browser.storage.local.set({ username: name });
        return name;
    }

    function updateUI() {
        if (currentRoom) {
            statusBar.className = 'status-bar status-connected';
            statusText.textContent = 'Connected to room';
            showSection('activeRoom');
            activeRoomCode.textContent = currentRoom.code;
            participantCount.textContent = currentRoom.participants || 1;
            activePlatform.textContent = currentRoom.platform || '--';
            activeUsernameInput.value = document.getElementById('usernameInput').value;
        } else if (hasContentScript) {
            statusBar.className = 'status-bar status-ready';
            statusText.textContent = 'Ready to sync';
            showSection('room');
        } else {
            statusBar.className = 'status-bar status-disconnected';
            statusText.textContent = 'Navigate to a website to create a room';
            showSection('room');
        }
    }

    function showSection(section) {
        welcomeSection.classList.add('hidden');
        notConnectedSection.classList.add('hidden');
        roomSection.classList.add('hidden');
        activeRoomSection.classList.add('hidden');

        switch (section) {
            case 'welcome':
                welcomeSection.classList.remove('hidden');
                break;
            case 'notConnected':
                notConnectedSection.classList.remove('hidden');
                break;
            case 'room':
                roomSection.classList.remove('hidden');
                break;
            case 'activeRoom':
                activeRoomSection.classList.remove('hidden');
                break;
        }
    }

    async function completeOnboarding(name) {
        const usernameInput = document.getElementById('usernameInput');
        usernameInput.value = name;
        await browser.storage.local.set({ username: name, onboardingComplete: true });
        onboardingComplete = true;
        await init();
    }

    function showError(message) {
        const toast = document.createElement('div');
        toast.className = 'toast error';
        toast.textContent = message;
        document.body.appendChild(toast);
        toast.addEventListener('animationend', (e) => {
            if (e.animationName === 'toastOut') toast.remove();
        });
    }

    function showTooltip(message) {
        const toast = document.createElement('div');
        toast.className = 'toast success';
        toast.textContent = message;
        document.body.appendChild(toast);
        toast.addEventListener('animationend', (e) => {
            if (e.animationName === 'toastOut') toast.remove();
        });
    }

    async function broadcastLeaveToTabs() {
        try {
            const tabs = await browser.tabs.query({});
            for (const tab of tabs) {
                browser.tabs.sendMessage(tab.id, { type: 'ROOM_LEFT' }).catch(() => {});
            }
        } catch (e) { }
    }

    // --- Register ALL event listeners synchronously (before any async work) ---

    serverStatusBtn.addEventListener('click', () => {
        if (serverStatusBtn.classList.contains('status-offline')) {
            wakeAndCheck();
        } else {
            checkServerHealth();
        }
    });

    refreshServerBtn.addEventListener('click', () => {
        if (refreshServerBtn.classList.contains('refreshing')) return;
        checkServerHealth();
    });

    welcomeSaveBtn.addEventListener('click', () => {
        const name = welcomeNameInput.value.trim() || welcomeNameInput.placeholder;
        completeOnboarding(name);
    });

    welcomeSkipBtn.addEventListener('click', () => {
        completeOnboarding(welcomeNameInput.placeholder);
    });

    welcomeNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') welcomeSaveBtn.click();
    });

    platformBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            platformBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedPlatform = btn.dataset.platform;
            createRoomBtn.disabled = false;

            if (selectedPlatform === 'global') {
                if (globalModeHint) globalModeHint.style.display = 'block';
            } else {
                if (globalModeHint) globalModeHint.style.display = 'none';

                if (selectedPlatform !== currentTabPlatform && PLATFORM_URLS[selectedPlatform] && activeTabId) {
                    browser.tabs.update(activeTabId, { url: PLATFORM_URLS[selectedPlatform] });
                    currentTabPlatform = selectedPlatform;
                    hasContentScript = true;
                }
            }
        });
    });

    createRoomBtn.addEventListener('click', async () => {
        if (!hasContentScript) {
            showError('Switch to any website tab first, then create a room.');
            return;
        }

        createRoomBtn.disabled = true;
        createRoomBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" class="spin">
            <circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5" stroke-dasharray="22" stroke-dashoffset="11"/>
        </svg><span>Creating...</span>`;

        const username = getUsername();
        const isGlobalMode = selectedPlatform === 'global';

        try {
            console.log('[OpenSync Popup] Creating room with platform:', selectedPlatform, 'globalMode:', isGlobalMode, 'user:', username);

            const response = await browser.tabs.sendMessage(activeTabId, {
                type: 'CREATE_ROOM',
                serverUrl: serverUrlInput.value,
                platform: isGlobalMode ? null : selectedPlatform,
                globalMode: isGlobalMode,
                username: username
            });

            console.log('[OpenSync Popup] Create room response:', response);

            if (response && response.success) {
                currentRoom = {
                    code: response.roomCode,
                    participants: 1,
                    isHost: true,
                    platform: isGlobalMode ? 'Global' : selectedPlatform
                };

                await browser.runtime.sendMessage({
                    type: 'SET_ROOM',
                    room: currentRoom
                });

                updateUI();
            } else {
                showError(response?.error || 'Failed to create room');
            }
        } catch (error) {
            console.error('[OpenSync Popup] Create room error:', error);
            showError('Could not connect. Make sure server is running and you are on a website.');
        }

        createRoomBtn.disabled = false;
        createRoomBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/>
            <path d="M9 6V12M6 9H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg><span>Create Room</span>`;
    });

    joinRoomBtn.addEventListener('click', async () => {
        const code = roomCodeInput.value.toUpperCase().trim();
        const username = getUsername();

        if (code.length !== 6) {
            showError('Room code must be 6 characters');
            return;
        }

        if (!hasContentScript) {
            showError('Switch to any website tab first, then try again. You\'ll be redirected to the video.');
            return;
        }

        joinRoomBtn.disabled = true;
        joinRoomBtn.textContent = 'Joining...';

        try {
            console.log('[OpenSync Popup] Joining room:', code, 'user:', username);

            const response = await browser.tabs.sendMessage(activeTabId, {
                type: 'JOIN_ROOM',
                roomCode: code,
                serverUrl: serverUrlInput.value,
                username: username
            });

            console.log('[OpenSync Popup] Join room response:', response);

            if (response && response.success) {
                currentRoom = {
                    code: code,
                    participants: response.participants || 2,
                    isHost: false,
                    platform: response.platform || 'unknown'
                };

                await browser.runtime.sendMessage({
                    type: 'SET_ROOM',
                    room: currentRoom
                });

                updateUI();
            } else {
                showError(response?.error || 'Failed to join room');
            }
        } catch (error) {
            console.error('[OpenSync Popup] Join room error:', error);
            showError('Could not connect. Make sure server is running and you are on a website.');
        }

        joinRoomBtn.disabled = false;
        joinRoomBtn.textContent = 'Join';
    });

    copyCodeBtn.addEventListener('click', () => {
        if (currentRoom && currentRoom.code) {
            navigator.clipboard.writeText(currentRoom.code);
            showTooltip('Copied!');
        }
    });

    leaveRoomBtn.addEventListener('click', async () => {
        currentRoom = null;
        updateUI();

        // Clean up everything directly from the popup (don't rely on background staying alive)
        broadcastLeaveToTabs();
        browser.storage.local.remove(['currentRoom', 'opensync_room', 'opensync_redirect', 'opensync_just_switched_url', 'opensync_sync_time']).catch(() => {});
        try { await browser.runtime.sendMessage({ type: 'LEAVE_ROOM' }); } catch (e) { }
    });

    activeUsernameInput.addEventListener('change', () => {
        const name = activeUsernameInput.value.trim();
        if (name) {
            document.getElementById('usernameInput').value = name;
            browser.storage.local.set({ username: name });
        }
    });

    serverUrlInput.addEventListener('change', () => {
        browser.runtime.sendMessage({
            type: 'UPDATE_SERVER_URL',
            serverUrl: serverUrlInput.value
        });
        checkServerHealth();
    });

    roomCodeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    roomCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinRoomBtn.click();
        }
    });

    browser.runtime.onMessage.addListener((message) => {
        try {
            if (message.type === 'PARTICIPANT_UPDATE') {
                if (currentRoom) {
                    currentRoom.participants = message.count;
                    participantCount.textContent = message.count;
                    browser.runtime.sendMessage({ type: 'SET_ROOM', room: currentRoom }).catch(() => {});
                }
            } else if (message.type === 'ROOM_DISCONNECTED') {
                currentRoom = null;
                browser.storage.local.remove(['currentRoom', 'opensync_room']).catch(() => {});
                browser.runtime.sendMessage({ type: 'LEAVE_ROOM' }).catch(() => {});
                updateUI();
            }
        } catch (e) {
            console.error('[OpenSync Popup] Message handler error:', e);
        }
    });

    // --- Initialize (async, after all listeners are registered) ---

    await init();
    checkServerHealth();

    async function init() {
        try {
            const state = await browser.runtime.sendMessage({ type: 'GET_STATE' });
            const storedData = await browser.storage.local.get(['username', 'serverUrl', 'onboardingComplete']);

            serverUrlInput.value = state.serverUrl || storedData.serverUrl || 'wss://opensync.onrender.com';
            onboardingComplete = !!storedData.onboardingComplete;

            const usernameInput = document.getElementById('usernameInput');
            if (storedData.username) {
                usernameInput.value = storedData.username;
            }

            if (!onboardingComplete && !storedData.username) {
                welcomeNameInput.placeholder = generateFriendlyName();
                showSection('welcome');
                welcomeNameInput.focus();
                return;
            }

            const tabInfo = await browser.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
            activeTabId = tabInfo.tabId;

            const isContentScriptPage = tabInfo.url && (
                tabInfo.url.startsWith('http://') ||
                tabInfo.url.startsWith('https://') ||
                tabInfo.url.startsWith('file://')
            );

            const isValidPage = tabInfo.url && (
                isContentScriptPage ||
                tabInfo.url.startsWith('about:') ||
                tabInfo.url.startsWith('moz-extension://') ||
                tabInfo.url.startsWith('chrome://') ||
                tabInfo.url.startsWith('chrome-extension://')
            );
            canUseOpenSync = isValidPage;
            hasContentScript = isContentScriptPage;

            if (isValidPage && tabInfo.url) {
                try {
                    const url = new URL(tabInfo.url);
                    const hostname = url.hostname.toLowerCase();

                    if (hostname.includes('youtube') || hostname.includes('youtu.be')) {
                        selectedPlatform = 'youtube';
                    } else if (hostname.includes('netflix')) {
                        selectedPlatform = 'netflix';
                    } else if (hostname.includes('primevideo') || hostname.includes('amazon')) {
                        selectedPlatform = 'primevideo';
                    } else if (hostname.includes('hotstar')) {
                        selectedPlatform = 'hotstar';
                    } else {
                        selectedPlatform = 'global';
                    }
                } catch (e) {
                    selectedPlatform = 'global';
                }

                currentTabPlatform = selectedPlatform;

                if (selectedPlatform) {
                    const btn = document.querySelector(`.platform-btn[data-platform="${selectedPlatform}"]`);
                    if (btn) {
                        setTimeout(() => {
                            platformBtns.forEach(b => b.classList.remove('selected'));
                            btn.classList.add('selected');
                            createRoomBtn.disabled = false;

                            if (selectedPlatform === 'global') {
                                if (globalModeHint) globalModeHint.style.display = 'block';
                            }
                        }, 100);
                    }
                }
            }

            if (state.currentRoom) {
                currentRoom = state.currentRoom;
            } else {
                const roomData = await browser.storage.local.get('opensync_room');
                if (roomData.opensync_room && roomData.opensync_room.roomCode) {
                    currentRoom = {
                        code: roomData.opensync_room.roomCode,
                        participants: roomData.opensync_room.participantCount || 1,
                        platform: roomData.opensync_room.platform || '--'
                    };
                }
            }

            console.log('[OpenSync Popup] Init:', { canUseOpenSync, hasContentScript, activeTabId, currentRoom, selectedPlatform });
            updateUI();
        } catch (error) {
            console.error('[OpenSync Popup] Init error:', error);
            updateUI();
        }
    }
});
