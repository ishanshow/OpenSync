// OpenSync Overlay UI
// Injects sync status indicator, chat sidebar, and Force Sync button

const OpenSyncOverlay = (function () {
    let overlayContainer = null;
    let chatContainer = null;
    let isVisible = false;
    let chatMessages = [];
    let onChatSend = null;
    let onForceSync = null;
    let isOverlayEnabled = true; // Set to false for headless mode

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
                <div class="opensync-logo">🎬 OpenSync</div>
                <div class="opensync-room-info">
                    <span class="opensync-room-code">------</span>
                    <span class="opensync-participants">👥 1</span>
                </div>
                <div class="opensync-actions">
                    <button class="opensync-force-sync-btn" title="Force Sync All Users">
                        🔄 Sync
                    </button>
                    <button class="opensync-chat-toggle" title="Toggle Chat">
                        💬
                    </button>
                </div>
            </div>
            <div class="opensync-chat-panel hidden">
                <div class="opensync-chat-messages"></div>
                <div class="opensync-chat-input-container">
                    <input type="text" class="opensync-chat-input" placeholder="Type a message..." />
                    <button class="opensync-chat-send">Send</button>
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
                    forceSyncBtn.textContent = '⏳ Syncing...';

                    onForceSync();

                    // Reset button after animation
                    setTimeout(() => {
                        forceSyncBtn.classList.remove('syncing');
                        forceSyncBtn.innerHTML = '🔄 Sync';
                    }, 2000);
                }
            });
        }

        // Chat toggle
        const chatToggle = overlayContainer.querySelector('.opensync-chat-toggle');
        if (chatToggle) {
            chatToggle.addEventListener('click', toggleChat);
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
            <span class="username">${username}</span>
            <span class="text">${text}</span>
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
        messageEl.innerHTML = `<span class="text">${text}</span>`;
        messagesContainer.appendChild(messageEl);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Update room info
    function updateRoomInfo(roomCode, participantCount) {
        if (!overlayContainer) return;

        const codeEl = overlayContainer.querySelector('.opensync-room-code');
        const countEl = overlayContainer.querySelector('.opensync-participants');

        if (codeEl) codeEl.textContent = roomCode;
        if (countEl) countEl.textContent = `👥 ${participantCount}`;
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
