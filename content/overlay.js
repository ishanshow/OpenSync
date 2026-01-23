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
        logo: `<svg width="18" height="18" viewBox="0 0 28 28" fill="none"><rect x="2" y="6" width="24" height="16" rx="3" stroke="currentColor" stroke-width="2"/><circle cx="14" cy="14" r="4" fill="currentColor"/><path d="M6 22L10 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M22 22L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
        users: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M2 14C2 11.2386 4.23858 9 7 9H9C11.7614 9 14 11.2386 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
        sync: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 8C2 4.68629 4.68629 2 8 2C10.2208 2 12.1599 3.26686 13.1973 5.11111" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M14 8C14 11.3137 11.3137 14 8 14C5.77919 14 3.84012 12.7331 2.80274 10.8889" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13 2V5.5H9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 14V10.5H6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        chat: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14 10C14 10.5304 13.7893 11.0391 13.4142 11.4142C13.0391 11.7893 12.5304 12 12 12H5L2 15V4C2 3.46957 2.21071 2.96086 2.58579 2.58579C2.96086 2.21071 3.46957 2 4 2H12C12.5304 2 13.0391 2.21071 13.4142 2.58579C13.7893 2.96086 14 3.46957 14 4V10Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        send: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M14.6667 1.33334L7.33334 8.66668" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.6667 1.33334L10 14.6667L7.33334 8.66668L1.33334 6.00001L14.6667 1.33334Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        close: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
    };

    // Helper function to safely create SVG element from string
    function createSvgElement(svgString) {
        // Create a temporary container to parse the SVG
        const container = document.createElement('div');
        // Use textContent assignment to build HTML safely
        // The SVG strings are static constants defined above, not user input
        container.insertAdjacentHTML('beforeend', svgString.trim());
        return container.firstChild;
    }

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

        // Create container using DOM methods to avoid innerHTML warnings
        overlayContainer = document.createElement('div');
        overlayContainer.id = 'opensync-overlay';
        
        // Build overlay using DOM manipulation for security compliance
        const statusBar = document.createElement('div');
        statusBar.className = 'opensync-status-bar';
        
        // Logo section
        const logoDiv = document.createElement('div');
        logoDiv.className = 'opensync-logo';
        const logoSvg = createSvgElement(icons.logo);
        logoDiv.appendChild(logoSvg);
        const logoText = document.createElement('span');
        logoText.textContent = 'OpenSync';
        logoDiv.appendChild(logoText);
        statusBar.appendChild(logoDiv);
        
        // Room info section
        const roomInfo = document.createElement('div');
        roomInfo.className = 'opensync-room-info';
        const roomCode = document.createElement('span');
        roomCode.className = 'opensync-room-code';
        roomCode.textContent = '------';
        roomInfo.appendChild(roomCode);
        
        const participants = document.createElement('span');
        participants.className = 'opensync-participants';
        const usersSvg = createSvgElement(icons.users);
        participants.appendChild(usersSvg);
        const countSpan = document.createElement('span');
        countSpan.className = 'count';
        countSpan.textContent = '1';
        participants.appendChild(countSpan);
        roomInfo.appendChild(participants);
        statusBar.appendChild(roomInfo);
        
        // Actions section
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'opensync-actions';
        
        const syncBtn = document.createElement('button');
        syncBtn.className = 'opensync-force-sync-btn';
        syncBtn.title = 'Sync all users';
        const syncSvg = createSvgElement(icons.sync);
        syncBtn.appendChild(syncSvg);
        const syncText = document.createElement('span');
        syncText.textContent = 'Sync';
        syncBtn.appendChild(syncText);
        actionsDiv.appendChild(syncBtn);
        
        const chatToggle = document.createElement('button');
        chatToggle.className = 'opensync-chat-toggle';
        chatToggle.title = 'Toggle chat';
        const chatSvg = createSvgElement(icons.chat);
        chatToggle.appendChild(chatSvg);
        actionsDiv.appendChild(chatToggle);
        statusBar.appendChild(actionsDiv);
        
        overlayContainer.appendChild(statusBar);
        
        // Chat panel
        const chatPanel = document.createElement('div');
        chatPanel.className = 'opensync-chat-panel hidden';
        
        const chatHeader = document.createElement('div');
        chatHeader.className = 'opensync-chat-header';
        const chatTitle = document.createElement('span');
        chatTitle.textContent = 'Chat';
        chatHeader.appendChild(chatTitle);
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'opensync-close-chat';
        closeBtn.title = 'Close chat';
        const closeSvg = createSvgElement(icons.close);
        closeBtn.appendChild(closeSvg);
        chatHeader.appendChild(closeBtn);
        chatPanel.appendChild(chatHeader);
        
        const messagesDiv = document.createElement('div');
        messagesDiv.className = 'opensync-chat-messages';
        chatPanel.appendChild(messagesDiv);
        
        const inputContainer = document.createElement('div');
        inputContainer.className = 'opensync-chat-input-container';
        const chatInput = document.createElement('input');
        chatInput.type = 'text';
        chatInput.className = 'opensync-chat-input';
        chatInput.placeholder = 'Type a message...';
        inputContainer.appendChild(chatInput);
        
        const sendBtn = document.createElement('button');
        sendBtn.className = 'opensync-chat-send';
        sendBtn.title = 'Send message';
        const sendSvg = createSvgElement(icons.send);
        sendBtn.appendChild(sendSvg);
        inputContainer.appendChild(sendBtn);
        chatPanel.appendChild(inputContainer);
        
        overlayContainer.appendChild(chatPanel);

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
        
        const usernameSpan = document.createElement('span');
        usernameSpan.className = 'username';
        usernameSpan.textContent = username;
        
        const textSpan = document.createElement('span');
        textSpan.className = 'text';
        textSpan.textContent = text;
        
        messageEl.appendChild(usernameSpan);
        messageEl.appendChild(textSpan);
        messagesContainer.appendChild(messageEl);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Add system message (supports HTML for links)
    function addSystemMessage(text) {
        console.log(`[OpenSync System]: ${text}`);

        if (!overlayContainer) return;

        const messagesContainer = overlayContainer.querySelector('.opensync-chat-messages');
        if (!messagesContainer) return;

        const messageEl = document.createElement('div');
        messageEl.className = 'opensync-chat-message system';
        
        const textSpan = document.createElement('span');
        textSpan.className = 'text';
        
        // Check if text contains HTML links and build safely with DOM
        const linkMatch = text.match(/<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
        if (linkMatch) {
            // Extract text before and after the link
            const linkStart = text.indexOf('<a ');
            const linkEnd = text.indexOf('</a>') + 4;
            const beforeText = text.substring(0, linkStart);
            const afterText = text.substring(linkEnd);
            
            // Build with DOM methods
            if (beforeText) {
                textSpan.appendChild(document.createTextNode(beforeText));
            }
            
            const link = document.createElement('a');
            link.href = linkMatch[1];
            link.textContent = linkMatch[2];
            link.target = '_blank';
            link.style.color = '#4CAF50';
            link.style.textDecoration = 'underline';
            textSpan.appendChild(link);
            
            if (afterText) {
                textSpan.appendChild(document.createTextNode(afterText));
            }
        } else {
            textSpan.textContent = text;
        }
        
        messageEl.appendChild(textSpan);
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
