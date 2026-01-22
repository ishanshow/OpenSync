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
    const platformCards = document.querySelectorAll('.platform-card');
    const activePlatform = document.getElementById('activePlatform');

    // State
    let canUsePopSync = false;
    let currentRoom = null;
    let activeTabId = null;
    let selectedPlatform = null;

    // Initialize
    await init();

    async function init() {
        try {
            // Load saved settings
            const state = await browser.runtime.sendMessage({ type: 'GET_STATE' });
            serverUrlInput.value = state.serverUrl || 'ws://localhost:3000';

            // Check active tab
            const tabInfo = await browser.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
            activeTabId = tabInfo.tabId;

            // Allow PopSync on any http/https page (not just popcornmovies)
            const isValidPage = tabInfo.url && (tabInfo.url.startsWith('http://') || tabInfo.url.startsWith('https://') || tabInfo.url.startsWith('file://'));
            canUsePopSync = isValidPage;

            // Check for existing room
            if (state.currentRoom) {
                currentRoom = state.currentRoom;
            }

            console.log('[OpenSync Popup] Init:', { canUsePopSync, activeTabId, currentRoom });
            updateUI();
        } catch (error) {
            console.error('[OpenSync Popup] Init error:', error);
            canUsePopSync = false;
            updateUI();
        }
    }

    function updateUI() {
        // Update status bar
        if (!canUsePopSync) {
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
    platformCards.forEach(card => {
        card.addEventListener('click', () => {
            // Remove selected from all
            platformCards.forEach(c => c.classList.remove('selected'));
            // Add selected to clicked
            card.classList.add('selected');
            selectedPlatform = card.dataset.platform;
            // Enable create button
            createRoomBtn.disabled = false;
        });
    });

    // Create Room
    createRoomBtn.addEventListener('click', async () => {
        createRoomBtn.disabled = true;
        createRoomBtn.innerHTML = '<span class="btn-icon">⏳</span> Creating...';

        try {
            console.log('[OpenSync Popup] Creating room with platform:', selectedPlatform, 'sending to tab:', activeTabId);

            // Send message to content script to create room
            const response = await browser.tabs.sendMessage(activeTabId, {
                type: 'CREATE_ROOM',
                serverUrl: serverUrlInput.value,
                platform: selectedPlatform
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
        createRoomBtn.innerHTML = '<span class="btn-icon">➕</span> Create Room';
    });

    // Join Room
    joinRoomBtn.addEventListener('click', async () => {
        const code = roomCodeInput.value.toUpperCase().trim();

        if (code.length !== 6) {
            showError('Room code must be 6 characters');
            return;
        }

        joinRoomBtn.disabled = true;
        joinRoomBtn.textContent = 'Joining...';

        try {
            console.log('[OpenSync Popup] Joining room:', code);

            const response = await browser.tabs.sendMessage(activeTabId, {
                type: 'JOIN_ROOM',
                roomCode: code,
                serverUrl: serverUrlInput.value
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
        const tooltip = document.createElement('div');
        tooltip.className = 'copied-tooltip';
        tooltip.style.background = 'var(--danger)';
        tooltip.textContent = message;
        document.body.appendChild(tooltip);
        setTimeout(() => tooltip.remove(), 3000);
    }

    function showTooltip(message) {
        const tooltip = document.createElement('div');
        tooltip.className = 'copied-tooltip';
        tooltip.textContent = message;
        document.body.appendChild(tooltip);
        setTimeout(() => tooltip.remove(), 1500);
    }

    // Listen for updates from content script
    browser.runtime.onMessage.addListener((message) => {
        if (message.type === 'PARTICIPANT_UPDATE') {
            if (currentRoom) {
                currentRoom.participants = message.count;
                participantCount.textContent = message.count;
            }
        } else if (message.type === 'ROOM_DISCONNECTED') {
            currentRoom = null;
            updateUI();
        }
    });
});
