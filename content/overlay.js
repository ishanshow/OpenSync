// OpenSync Overlay UI
// Injects sync status indicator, chat panel, and Force Sync button

const OpenSyncOverlay = (function () {
    let overlayContainer = null;
    let chatContainer = null;
    let isVisible = false;
    let chatMessages = [];
    let onChatSend = null;
    let onForceSync = null;
    let isOverlayEnabled = true; // Set to false for headless mode

    // SVG Icons
    const icons = {
        logo: `<svg width="18" height="18" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="6" width="24" height="16" rx="3" stroke="currentColor" stroke-width="2"/>
            <circle cx="14" cy="14" r="4" fill="currentColor"/>
            <path d="M6 22L10 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M22 22L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`,
        users: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.5"/>
            <path d="M2 14C2 11.2386 4.23858 9 7 9H9C11.7614 9 14 11.2386 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`,
        sync: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 8C2 4.68629 4.68629 2 8 2C10.2208 2 12.1599 3.26686 13.1973 5.11111" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M14 8C14 11.3137 11.3137 14 8 14C5.77919 14 3.84012 12.7331 2.80274 10.8889" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M13 2V5.5H9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3 14V10.5H6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`,
        chat: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M14 10C14 10.5304 13.7893 11.0391 13.4142 11.4142C13.0391 11.7893 12.5304 12 12 12H5L2 15V4C2 3.46957 2.21071 2.96086 2.58579 2.58579C2.96086 2.21071 3.46957 2 4 2H12C12.5304 2 13.0391 2.21071 13.4142 2.58579C13.7893 2.96086 14 3.46957 14 4V10Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`,
        send: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M14.6667 1.33334L7.33334 8.66668" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M14.6667 1.33334L10 14.6667L7.33334 8.66668L1.33334 6.00001L14.6667 1.33334Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`,
        close: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`
    };

    // Create the overlay elements
    function create(callbacks = {}) {
        onChatSend = callbacks.onChatSend;
        onForceSync = callbacks.onForceSync;

        if (!isOverlayEnabled) {
            console.log('[OpenSync] Overlay creation skipped (headless mode)');
            return;
        }

        // Don't create duplicate overlays
        if (overlayContainer) {
            return;
        }

        // Create container
        overlayContainer = document.createElement('div');
        overlayContainer.id = 'opensync-overlay';
        overlayContainer.innerHTML = `
            <div class="opensync-status-bar">
                <div class="opensync-logo">
                    ${icons.logo}
                    <span>OpenSync</span>
                </div>
                <div class="opensync-room-info">
                    <span class="opensync-room-code">------</span>
                    <span class="opensync-participants">
                        ${icons.users}
                        <span class="count">1</span>
                    </span>
                </div>
                <div class="opensync-actions">
                    <button class="opensync-force-sync-btn" title="Sync all users">
                        ${icons.sync}
                        <span>Sync</span>
                    </button>
                    <button class="opensync-chat-toggle" title="Toggle chat">
                        ${icons.chat}
                    </button>
                </div>
            </div>
            <div class="opensync-chat-panel hidden">
                <div class="opensync-chat-header">
                    <span>Chat</span>
                    <button class="opensync-close-chat" title="Close chat">
                        ${icons.close}
                    </button>
                </div>
                <div class="opensync-chat-messages"></div>
                <div class="opensync-chat-input-container">
                    <input type="text" class="opensync-chat-input" placeholder="Type a message..." />
                    <button class="opensync-chat-send" title="Send message">
                        ${icons.send}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlayContainer);
        attachEventListeners();
        isVisible = true;

        console.log('[OpenSync] Overlay created');
    }

    // Attach event listeners
    function attachEventListeners() {
        if (!overlayContainer) return;

        // Force Sync button
        const forceSyncBtn = overlayContainer.querySelector('.opensync-force-sync-btn');
        if (forceSyncBtn) {
            forceSyncBtn.addEventListener('click', () => {
                if (onForceSync) {
                    // Add visual feedback
                    forceSyncBtn.classList.add('syncing');
                    const textSpan = forceSyncBtn.querySelector('span');
                    if (textSpan) textSpan.textContent = 'Syncing...';

                    onForceSync();

                    // Reset button after animation
                    setTimeout(() => {
                        forceSyncBtn.classList.remove('syncing');
                        if (textSpan) textSpan.textContent = 'Sync';
                    }, 2000);
                }
            });
        }

        // Chat toggle
        const chatToggle = overlayContainer.querySelector('.opensync-chat-toggle');
        if (chatToggle) {
            chatToggle.addEventListener('click', toggleChat);
        }

        // Close chat button
        const closeChat = overlayContainer.querySelector('.opensync-close-chat');
        if (closeChat) {
            closeChat.addEventListener('click', () => setChatVisible(false));
        }

        // Chat send
        const chatSendBtn = overlayContainer.querySelector('.opensync-chat-send');
        const chatInput = overlayContainer.querySelector('.opensync-chat-input');

        if (chatSendBtn && chatInput) {
            chatSendBtn.addEventListener('click', sendMessage);
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendMessage();
                }
            });
        }
    }

    // Toggle chat visibility
    function toggleChat() {
        const chatPanel = overlayContainer?.querySelector('.opensync-chat-panel');
        if (chatPanel) {
            chatPanel.classList.toggle('hidden');
        }
    }

    // Set chat visibility
    function setChatVisible(visible) {
        const chatPanel = overlayContainer?.querySelector('.opensync-chat-panel');
        if (chatPanel) {
            chatPanel.classList.toggle('hidden', !visible);
        }
    }

    // Send chat message
    function sendMessage() {
        const chatInput = overlayContainer?.querySelector('.opensync-chat-input');
        if (!chatInput) return;

        const text = chatInput.value.trim();
        if (text && onChatSend) {
            onChatSend(text);
            chatInput.value = '';
        }
    }

    // Add chat message to display
    function addChatMessage(username, text, isOwn = false) {
        console.log(`[OpenSync Chat] ${username}: ${text}`);

        if (!overlayContainer) return;

        const messagesContainer = overlayContainer.querySelector('.opensync-chat-messages');
        if (!messagesContainer) return;

        const messageEl = document.createElement('div');
        messageEl.className = `opensync-chat-message ${isOwn ? 'own' : ''}`;
        messageEl.innerHTML = `
            <span class="username">${escapeHtml(username)}</span>
            <span class="text">${escapeHtml(text)}</span>
        `;
        messagesContainer.appendChild(messageEl);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Add system message
    function addSystemMessage(text) {
        console.log(`[OpenSync System]: ${text}`);

        if (!overlayContainer) return;

        const messagesContainer = overlayContainer.querySelector('.opensync-chat-messages');
        if (!messagesContainer) return;

        const messageEl = document.createElement('div');
        messageEl.className = 'opensync-chat-message system';
        messageEl.innerHTML = `<span class="text">${escapeHtml(text)}</span>`;
        messagesContainer.appendChild(messageEl);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Update room info
    function updateRoomInfo(roomCode, participantCount) {
        if (!overlayContainer) return;

        const codeEl = overlayContainer.querySelector('.opensync-room-code');
        const countEl = overlayContainer.querySelector('.opensync-participants .count');

        if (codeEl) codeEl.textContent = roomCode;
        if (countEl) countEl.textContent = participantCount;
    }

    // Update status text
    function updateStatus(status) {
        console.log(`[OpenSync Status]: ${status}`);
    }

    // Show/hide overlay
    function show() {
        if (overlayContainer) {
            overlayContainer.style.display = 'block';
            isVisible = true;
        }
    }

    function hide() {
        if (overlayContainer) {
            overlayContainer.style.display = 'none';
            isVisible = false;
        }
    }

    // Destroy overlay
    function destroy() {
        if (overlayContainer) {
            overlayContainer.remove();
            overlayContainer = null;
        }
        isVisible = false;
    }

    // Check if overlay exists
    function exists() {
        return overlayContainer !== null;
    }

    // Utility: escape HTML
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    return {
        create,
        destroy,
        show,
        hide,
        updateRoomInfo,
        updateStatus,
        addChatMessage,
        addSystemMessage,
        setChatVisible,
        exists
    };
})();

// Make available globally
window.OpenSyncOverlay = OpenSyncOverlay;
