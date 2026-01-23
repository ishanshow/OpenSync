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

    // State
    let canUseOpenSync = false;
    let currentRoom = null;
    let activeTabId = null;
    let selectedPlatform = null;

    // Initialize
    await init();

    async function init() {
        try {
            // Load saved settings
            const state = await browser.runtime.sendMessage({ type: 'GET_STATE' });

            // Load persistent storage for username
            const storedData = await browser.storage.local.get(['username', 'serverUrl']);

            serverUrlInput.value = state.serverUrl || storedData.serverUrl || 'ws://localhost:3000';

            // Set username if exists
            const usernameInput = document.getElementById('usernameInput');
            if (storedData.username) {
                usernameInput.value = storedData.username;
            }

            // Check active tab
            const tabInfo = await browser.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
            activeTabId = tabInfo.tabId;

            // Allow OpenSync on any http/https page
            const isValidPage = tabInfo.url && (tabInfo.url.startsWith('http://') || tabInfo.url.startsWith('https://') || tabInfo.url.startsWith('file://'));
            canUseOpenSync = isValidPage;

            // Auto-detect platform
            if (isValidPage) {
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
                }

                // If platform detected, auto-select UI
                if (selectedPlatform) {
                    const btn = document.querySelector(`.platform-btn[data-platform="${selectedPlatform}"]`);
                    if (btn) {
                        // Wait for DOM
                        setTimeout(() => {
                            platformBtns.forEach(b => b.classList.remove('selected'));
                            btn.classList.add('selected');
                            createRoomBtn.disabled = false;
                        }, 100);
                    }
                }
            }

            // Check for existing room
            if (state.currentRoom) {
                currentRoom = state.currentRoom;
            }

            console.log('[OpenSync Popup] Init:', { canUseOpenSync, activeTabId, currentRoom, selectedPlatform });
            updateUI();
        } catch (error) {
            console.error('[OpenSync Popup] Init error:', error);
            canUseOpenSync = false;
            updateUI();
        }
    }

    function getUsername() {
        const usernameInput = document.getElementById('usernameInput');
        let name = usernameInput.value.trim();
        if (!name) {
            name = 'User_' + Math.random().toString(36).substring(2, 6);
        }
        // Save it
        browser.storage.local.set({ username: name });
        return name;
    }

    // ... UI Update function ...
    function updateUI() {
        // Update status bar
        if (!canUseOpenSync) {
            statusBar.className = 'status-bar status-disconnected';
            statusText.textContent = 'Open a video page';
            showSection('notConnected');
        } else if (currentRoom) {
            statusBar.className = 'status-bar status-connected';
            statusText.textContent = 'Connected to room';
            showSection('activeRoom');
            activeRoomCode.textContent = currentRoom.code;
            participantCount.textContent = currentRoom.participants || 1;
            activePlatform.textContent = currentRoom.platform || '--';
        } else {
            statusBar.className = 'status-bar status-ready';
            statusText.textContent = 'Ready to sync';
            showSection('room');
        }
    }

    function showSection(section) {
        notConnectedSection.classList.add('hidden');
        roomSection.classList.add('hidden');
        activeRoomSection.classList.add('hidden');

        switch (section) {
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

    // Platform Selection
    platformBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remove selected from all
            platformBtns.forEach(b => b.classList.remove('selected'));
            // Add selected to clicked
            btn.classList.add('selected');
            selectedPlatform = btn.dataset.platform;
            // Enable create button
            createRoomBtn.disabled = false;
        });
    });

    // Create Room
    createRoomBtn.addEventListener('click', async () => {
        createRoomBtn.disabled = true;
        createRoomBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" class="spin">
            <circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5" stroke-dasharray="22" stroke-dashoffset="11"/>
        </svg><span>Creating...</span>`;

        const username = getUsername();

        try {
            console.log('[OpenSync Popup] Creating room with platform:', selectedPlatform, 'user:', username);

            // Send message to content script to create room
            const response = await browser.tabs.sendMessage(activeTabId, {
                type: 'CREATE_ROOM',
                serverUrl: serverUrlInput.value,
                platform: selectedPlatform,
                username: username
            });

            console.log('[OpenSync Popup] Create room response:', response);

            if (response && response.success) {
                currentRoom = {
                    code: response.roomCode,
                    participants: 1,
                    isHost: true,
                    platform: selectedPlatform
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
            showError('Could not connect. Make sure server is running and page has a video.');
        }

        createRoomBtn.disabled = false;
        createRoomBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="1.5"/>
            <path d="M9 6V12M6 9H12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg><span>Create Room</span>`;
    });

    // Join Room
    joinRoomBtn.addEventListener('click', async () => {
        const code = roomCodeInput.value.toUpperCase().trim();
        const username = getUsername();

        if (code.length !== 6) {
            showError('Room code must be 6 characters');
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
            showError('Could not connect. Make sure server is running.');
        }

        joinRoomBtn.disabled = false;
        joinRoomBtn.textContent = 'Join';
    });

    // Copy Room Code
    copyCodeBtn.addEventListener('click', () => {
        if (currentRoom && currentRoom.code) {
            navigator.clipboard.writeText(currentRoom.code);
            showTooltip('Copied!');
        }
    });

    // Leave Room
    leaveRoomBtn.addEventListener('click', async () => {
        try {
            await browser.tabs.sendMessage(activeTabId, { type: 'LEAVE_ROOM' });
        } catch (e) { }

        await browser.runtime.sendMessage({ type: 'LEAVE_ROOM' });
        currentRoom = null;
        updateUI();
    });

    // Server URL change
    serverUrlInput.addEventListener('change', () => {
        browser.runtime.sendMessage({
            type: 'UPDATE_SERVER_URL',
            serverUrl: serverUrlInput.value
        });
    });

    // Room code input formatting
    roomCodeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    // Enter key to join
    roomCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinRoomBtn.click();
        }
    });

    function showError(message) {
        const toast = document.createElement('div');
        toast.className = 'toast error';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    function showTooltip(message) {
        const toast = document.createElement('div');
        toast.className = 'toast success';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 1500);
    }

    // Listen for updates from content script
    browser.runtime.onMessage.addListener(async (message) => {
        if (message.type === 'PARTICIPANT_UPDATE') {
            if (currentRoom) {
                currentRoom.participants = message.count;
                participantCount.textContent = message.count;
                // Also update background storage with new participant count
                await browser.runtime.sendMessage({
                    type: 'SET_ROOM',
                    room: currentRoom
                });
            }
        } else if (message.type === 'ROOM_DISCONNECTED') {
            // Clear both local state and background storage
            currentRoom = null;
            await browser.runtime.sendMessage({ type: 'LEAVE_ROOM' });
            updateUI();
        }
    });
});
