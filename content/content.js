// OpenSync Main Content Script
// Orchestrates video sync, WebSocket communication, and UI

(function () {
    'use strict';

    // Prevent multiple initializations
    if (window.OpenSyncContentInitialized) {
        console.log('[OpenSync] Content script already initialized in this frame');
        return;
    }
    window.OpenSyncContentInitialized = true;

    // Determine if we're in the main frame or an iframe
    const isMainFrame = window === window.top;
    const frameInfo = isMainFrame ? 'main frame' : 'iframe';

    // Run on any page with http/https/file protocol
    const isValidProtocol = window.location.protocol === 'http:' ||
        window.location.protocol === 'https:' ||
        window.location.protocol === 'file:';

    if (!isValidProtocol) {
        console.log('[OpenSync] Skipping - invalid protocol');
        return;
    }

    console.log(`[OpenSync] Content script loaded in ${frameInfo} on ${window.location.hostname}`);

    // State
    let isInitialized = false;
    let isConnected = false;
    let isHost = false;
    let roomCode = null;
    let username = 'User_' + Math.random().toString(36).substring(2, 6);
    let serverUrl = 'ws://localhost:3000';
    let participantCount = 1;
    let currentPlatform = null; // Platform type: 'netflix', 'primevideo', 'hotstar'

    // Throttle sync updates
    let lastSyncTime = 0;
    let lastPlayingState = null; // Track last known state to prevent redundant events
    let lastLocalActionTime = 0; // Track last local interaction to ignore incoming stale updates
    let isLocallyBuffering = false; // Track if we are buffering due to local action
    const SYNC_INTERVAL = 500; // 500ms minimum between syncs
    const IGNORE_INCOMING_MS = 2000; // Ignore remote updates for 2s after local action
    let lastKnownUrl = window.location.href; // Track URL for navigation sync
    let lastKnownContentId = null; // Track content ID to prevent infinite loops
    let isNavigation = false;

    // Global Mode: Cross-frame video sync
    let isGlobalMode = false; // Whether Global Mode is active
    let iframeVideoSource = null; // Reference to iframe window containing video
    let iframeVideoFrameId = null; // URL/ID of iframe with video
    let hasLocalVideo = false; // Whether main frame has a video

    // Redirect/Navigation state - prevents race conditions during URL changes
    let isPendingRedirect = false; // True when we're about to redirect due to URL_CHANGE
    let isNavigatingAway = false; // True when WE changed the video (don't echo back)
    let pendingRedirectUrl = null; // The URL we're redirecting to

    // Video ready sync state - ensures all users are ready before playing
    let isWaitingForAllReady = false; // True when waiting for all users to be ready
    let pendingSyncTime = 0; // Time to sync to when all are ready

    // Tab-specific session ID - isolates sync to the tab that joined the room
    // This prevents other tabs from hijacking the sync session
    let tabSessionId = sessionStorage.getItem('opensync_tab_session_id');
    if (!tabSessionId) {
        tabSessionId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
        sessionStorage.setItem('opensync_tab_session_id', tabSessionId);
    }
    console.log('[OpenSync] Tab session ID:', tabSessionId);

    // ============================================
    // GLOBAL MODE: Cross-Frame Video Communication
    // ============================================

    // Listen for messages from iframes (Global Mode)
    if (isMainFrame) {
        window.addEventListener('message', handleIframeMessage);
        console.log('[OpenSync] Main frame: listening for iframe video messages');
    }

    // ============================================
    // BRIDGE MODE: Listen for events from platform bridges (Hotstar, etc.)
    // ============================================
    
    // Listen for video events forwarded from platform bridges
    window.addEventListener('message', handleBridgeMessage);
    
    function handleBridgeMessage(event) {
        // Only process messages from the page-level bridge
        if (event.data?.source !== 'OPENSYNC_BRIDGE') return;
        if (event.data.type !== 'VIDEO_EVENT') return;
        
        const { event: videoEvent, payload } = event.data;
        
        if (!isConnected || !payload) return;
        
        // Don't broadcast video events if we're navigating, redirect is pending, or waiting for all ready
        if (isNavigatingAway || isPendingRedirect || isWaitingForAllReady) {
            console.log('[OpenSync] Skipping bridge event broadcast (navigation/loading in progress)');
            return;
        }
        
        console.log('[OpenSync] Bridge VIDEO_EVENT:', videoEvent, 'at', payload.currentTime?.toFixed(2));
        
        lastLocalActionTime = Date.now();
        
        switch (videoEvent) {
            case 'play':
            case 'playing':
                if (lastPlayingState === true) return;
                lastPlayingState = true;
                console.log('[OpenSync] Bridge PLAY at', payload.currentTime?.toFixed(2));
                OpenSyncWebSocketClient.sendPlay(payload.currentTime);
                break;
                
            case 'pause':
                if (lastPlayingState === false) return;
                lastPlayingState = false;
                console.log('[OpenSync] Bridge PAUSE at', payload.currentTime?.toFixed(2));
                OpenSyncWebSocketClient.sendPause(payload.currentTime);
                break;
                
            case 'seek':
                const effectiveIsPlaying = payload.isPlaying || (lastPlayingState === true);
                console.log('[OpenSync] Bridge SEEK to', payload.currentTime?.toFixed(2), 'isPlaying:', effectiveIsPlaying);
                OpenSyncWebSocketClient.sendSeek(payload.currentTime, effectiveIsPlaying);
                break;
        }
    }

    function handleIframeMessage(event) {
        // Only process messages from child frames with our protocol
        if (event.data?.source !== 'OPENSYNC_IFRAME') return;

        const { type, frameId, state, event: videoEvent } = event.data;

        switch (type) {
            case 'VIDEO_FOUND':
                console.log('[OpenSync] VIDEO_FOUND from iframe:', frameId);
                iframeVideoSource = event.source;
                iframeVideoFrameId = frameId;
                
                // If we're in Global Mode and connected, this is good news
                if (isGlobalMode && isMainFrame) {
                    OpenSyncOverlay.addSystemMessage('Video detected in embedded player');
                }
                
                // If we don't have a local video, automatically use iframe video
                if (!hasLocalVideo && !OpenSyncVideoController.isAvailable()) {
                    console.log('[OpenSync] No local video, using iframe video for sync');
                    isGlobalMode = true;
                }
                break;

            case 'VIDEO_EVENT':
                // Relay iframe video events to the sync server
                if (!isConnected || !isGlobalMode) return;
                
                console.log('[OpenSync] VIDEO_EVENT from iframe:', videoEvent, state?.currentTime?.toFixed(2));
                handleIframeVideoEvent(videoEvent, state);
                break;

            case 'STATE_RESPONSE':
                // Handle state response from iframe (for sync requests)
                console.log('[OpenSync] STATE_RESPONSE from iframe:', state);
                if (state && isConnected) {
                    // Use this state for sync responses
                    handleIframeStateResponse(state);
                }
                break;
        }
    }

    // Handle video events forwarded from iframe
    function handleIframeVideoEvent(eventType, state) {
        if (!isConnected || !state) return;
        
        // Don't broadcast video events if we're navigating, redirect is pending, or waiting for all ready
        if (isNavigatingAway || isPendingRedirect || isWaitingForAllReady) {
            console.log('[OpenSync] Skipping iframe event broadcast (navigation/loading in progress)');
            return;
        }

        lastLocalActionTime = Date.now();

        switch (eventType) {
            case 'play':
                if (lastPlayingState === true) return;
                lastPlayingState = true;
                console.log('[OpenSync] Iframe PLAY at', state.currentTime?.toFixed(2));
                OpenSyncWebSocketClient.sendPlay(state.currentTime);
                break;

            case 'pause':
                if (lastPlayingState === false) return;
                lastPlayingState = false;
                console.log('[OpenSync] Iframe PAUSE at', state.currentTime?.toFixed(2));
                OpenSyncWebSocketClient.sendPause(state.currentTime);
                break;

            case 'seek':
                const effectiveIsPlaying = state.isPlaying || (lastPlayingState === true);
                console.log('[OpenSync] Iframe SEEK to', state.currentTime?.toFixed(2), 'isPlaying:', effectiveIsPlaying);
                OpenSyncWebSocketClient.sendSeek(state.currentTime, effectiveIsPlaying);
                break;
        }
    }

    // Handle state response from iframe for sync requests
    function handleIframeStateResponse(state) {
        if (!isHost) return;

        console.log('[OpenSync] Responding to sync request with iframe state:', state);
        OpenSyncWebSocketClient.sendSync({
            currentTime: state.currentTime,
            isPlaying: state.isPlaying,
            playbackRate: state.playbackRate || 1
        });
    }

    // Send command to iframe video
    function sendCommandToIframe(type, payload = {}) {
        if (!iframeVideoSource) {
            console.warn('[OpenSync] Cannot send command: no iframe video source');
            return false;
        }

        try {
            iframeVideoSource.postMessage({
                source: 'OPENSYNC_MAIN',
                type: type,
                ...payload
            }, '*');
            console.log('[OpenSync] Sent', type, 'command to iframe');
            return true;
        } catch (e) {
            console.error('[OpenSync] Failed to send command to iframe:', e);
            return false;
        }
    }

    // Request state from iframe video
    function requestIframeState() {
        if (!iframeVideoSource) return;
        sendCommandToIframe('GET_STATE');
    }

    // ============================================
    // END GLOBAL MODE
    // ============================================

    // Extract content/video ID from URL based on platform
    // This is critical to prevent infinite refresh loops
    function getContentIdFromUrl(url, platform) {
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.toLowerCase();
            const pathname = urlObj.pathname;

            // Auto-detect platform if not provided
            if (!platform) {
                if (hostname.includes('youtube') || hostname.includes('youtu.be')) {
                    platform = 'youtube';
                } else if (hostname.includes('netflix')) {
                    platform = 'netflix';
                } else if (hostname.includes('primevideo') || hostname.includes('amazon')) {
                    platform = 'primevideo';
                } else if (hostname.includes('hotstar')) {
                    platform = 'hotstar';
                }
            }

            switch (platform) {
                case 'youtube':
                    // YouTube: v=VIDEO_ID or /watch?v=VIDEO_ID or youtu.be/VIDEO_ID
                    const vParam = urlObj.searchParams.get('v');
                    if (vParam) return `yt:${vParam}`;
                    // Short URL format
                    if (hostname.includes('youtu.be')) {
                        const pathId = pathname.split('/')[1];
                        if (pathId) return `yt:${pathId}`;
                    }
                    return null;

                case 'netflix':
                    // Netflix: /watch/VIDEO_ID or /title/VIDEO_ID
                    const netflixMatch = pathname.match(/\/(watch|title)\/(\d+)/);
                    if (netflixMatch) return `nf:${netflixMatch[2]}`;
                    return null;

                case 'primevideo':
                    // Prime Video: /detail/ASIN or /dp/ASIN or /gp/video/detail/ASIN
                    // ASINs are 10 character alphanumeric
                    const primeMatch = pathname.match(/\/(detail|dp|gp\/video\/detail)\/([A-Z0-9]{10})/i);
                    if (primeMatch) return `pv:${primeMatch[2]}`;
                    // Also check for ref in URL which sometimes contains ASIN
                    const refMatch = pathname.match(/\/([A-Z0-9]{10})\//i);
                    if (refMatch) return `pv:${refMatch[1]}`;
                    return null;

                case 'hotstar':
                    // Hotstar: Last segment is usually content ID (numeric)
                    // e.g., /in/movies/movie-name/1234567890 or /in/shows/.../1234567890
                    const segments = pathname.split('/').filter(s => s);
                    const lastSegment = segments[segments.length - 1];
                    // Check if it's a numeric ID (Hotstar content IDs are long numbers)
                    if (lastSegment && /^\d{8,}$/.test(lastSegment)) {
                        return `hs:${lastSegment}`;
                    }
                    // Sometimes the ID is in a different position for shows
                    for (let i = segments.length - 1; i >= 0; i--) {
                        if (/^\d{8,}$/.test(segments[i])) {
                            return `hs:${segments[i]}`;
                        }
                    }
                    return null;

                default:
                    // Generic: use full pathname as content ID
                    return `gen:${pathname}`;
            }
        } catch (e) {
            console.error('[OpenSync] Error extracting content ID:', e);
            return null;
        }
    }

    // Check if two URLs point to the same content
    function isSameContent(url1, url2, platform) {
        const id1 = getContentIdFromUrl(url1, platform);
        const id2 = getContentIdFromUrl(url2, platform);
        
        // If we can't extract IDs, compare full URLs
        if (!id1 || !id2) {
            try {
                const u1 = new URL(url1);
                const u2 = new URL(url2);
                return u1.pathname === u2.pathname;
            } catch (e) {
                return url1 === url2;
            }
        }
        
        return id1 === id2;
    }

    // Initialize when video is available
    async function init() {
        if (isInitialized) return;

        console.log(`[OpenSync] Initializing video controller in ${frameInfo}...`);

        // Check if we have a video element
        // Pass the platform so the bridge gets injected
        const hasVideo = OpenSyncVideoController.init({
            onPlay: handleLocalPlay,
            onPause: handleLocalPause,
            onSeek: handleLocalSeek,
            onBuffer: handleLocalBuffer,
            onPlaying: handleLocalPlaying
        }, currentPlatform);

        if (hasVideo || isMainFrame) {
            if (hasVideo) {
                console.log(`[OpenSync] Video detected in ${frameInfo}, ready for sync`);
            } else {
                console.log(`[OpenSync] Running in Main Frame (Navigation Controller)`);
            }

            // Initialize content ID tracking
            lastKnownContentId = getContentIdFromUrl(window.location.href, currentPlatform);
            console.log('[OpenSync] Initial content ID:', lastKnownContentId);

            // Auto-detect navigation (SPA)
            setInterval(checkUrl, 1000);

            isInitialized = true;

            // Check for existing session and reconnect using browser.storage.local
            // This persists across origins (critical for cross-site redirects)
            if (isMainFrame) {
                try {
                    const stored = await browser.storage.local.get(['opensync_room', 'opensync_redirect', 'opensync_just_switched_url']);
                    
                    // Check if we just redirected (deliberate cross-origin redirect for sync)
                    const isRedirectingForSync = !!stored.opensync_redirect;
                    if (isRedirectingForSync) {
                        console.log('[OpenSync] Loaded via sync redirect, adhering to room.');
                        isNavigation = false;
                        
                        // IMPORTANT: Update the tab session ID in storage since this is the new active tab
                        // This allows the redirected tab to "take over" the session
                        if (stored.opensync_room) {
                            stored.opensync_room.tabSessionId = tabSessionId;
                            await browser.storage.local.set({ opensync_room: stored.opensync_room });
                            console.log('[OpenSync] Updated tab session ID after redirect');
                        }
                        
                        // Clear redirect flag after processing
                        setTimeout(() => {
                            browser.storage.local.remove('opensync_redirect').catch(() => {});
                        }, 2000);
                    }
                    
                    if (stored.opensync_room) {
                        const data = stored.opensync_room;
                        
                        // Check if this tab should reconnect:
                        // 1. If we just redirected for sync (cross-origin navigation) - YES
                        // 2. If our tab session ID matches the stored one - YES (same tab, maybe refreshed)
                        // 3. Otherwise - NO (different tab, don't hijack the session)
                        const shouldReconnect = isRedirectingForSync || 
                                               (data.tabSessionId && data.tabSessionId === tabSessionId);
                        
                        if (!shouldReconnect) {
                            console.log('[OpenSync] Found session but it belongs to a different tab, skipping reconnect');
                            console.log('[OpenSync] Stored tab ID:', data.tabSessionId, '| Our tab ID:', tabSessionId);
                            return; // Don't reconnect - this is a different tab
                        }
                        
                        console.log('[OpenSync] Found session token, reconnecting:', data.roomCode);

                        serverUrl = data.serverUrl || serverUrl;
                        username = data.username || username;
                        
                        // Set platform from stored data and initialize bridge
                        if (data.platform) {
                            currentPlatform = data.platform;
                            OpenSyncVideoController.setPlatform(currentPlatform);
                            
                            // Set Global Mode flag if platform is 'global'
                            if (currentPlatform === 'global') {
                                isGlobalMode = true;
                                console.log('[OpenSync] Global Mode enabled from stored session');
                            }
                        }

                        const connected = await connectToServer(serverUrl);
                        if (connected) {
                            console.log('[OpenSync] Rejoining room:', data.roomCode);
                            OpenSyncWebSocketClient.joinRoom(data.roomCode, username);

                            // Wait for room join confirmation
                            let waitedForJoin = 0;
                            while (!roomCode && waitedForJoin < 3000) {
                                await new Promise(resolve => setTimeout(resolve, 100));
                                waitedForJoin += 100;
                            }

                            // Update background storage with rejoined room state
                            if (roomCode) {
                                try {
                                    browser.runtime.sendMessage({
                                        type: 'SET_ROOM',
                                        room: {
                                            code: roomCode,
                                            participants: participantCount,
                                            isHost: isHost,
                                            platform: currentPlatform
                                        }
                                    }).catch(() => { });
                                    console.log('[OpenSync] Background storage updated after rejoin');
                                } catch (e) { }
                            } else {
                                // Failed to rejoin - clear stale session data
                                console.log('[OpenSync] Failed to rejoin room, clearing session');
                                await browser.storage.local.remove(['opensync_room', 'opensync_redirect', 'opensync_just_switched_url', 'opensync_sync_time']);
                                try {
                                    browser.runtime.sendMessage({ type: 'LEAVE_ROOM' }).catch(() => { });
                                } catch (e) { }
                            }

                            // If we just redirected (auto-followed), wait for video to load then signal ready
                            if (stored.opensync_just_switched_url) {
                                await browser.storage.local.remove(['opensync_just_switched_url', 'opensync_sync_time']);
                                
                                console.log('[OpenSync] Detected redirect, waiting for video to load...');
                                
                                // Set waiting flag - we're waiting for ALL_READY
                                isWaitingForAllReady = true;
                                
                                if (isMainFrame) {
                                    OpenSyncOverlay.updateStatus('Loading...');
                                    OpenSyncOverlay.addSystemMessage('Video loading...');
                                }
                                
                                // Wait for video to be ready, then send VIDEO_READY signal
                                // Server will send ALL_READY when everyone is ready
                                const delay = (currentPlatform === 'netflix' || currentPlatform === 'primevideo' || currentPlatform === 'hotstar') ? 4000 : 2000;
                                
                                setTimeout(async () => {
                                    // Check if video element exists and is ready
                                    const video = document.querySelector('video');
                                    if (video) {
                                        // Wait for video to have enough data
                                        const checkVideoReady = () => {
                                            if (video.readyState >= 2) { // HAVE_CURRENT_DATA or better
                                                console.log('[OpenSync] Video ready after redirect, signaling server');
                                                sendVideoReadySignal();
                                            } else {
                                                console.log('[OpenSync] Video not ready yet, waiting... readyState:', video.readyState);
                                                setTimeout(checkVideoReady, 500);
                                            }
                                        };
                                        checkVideoReady();
                                    } else {
                                        // No video yet, still send ready signal
                                        console.log('[OpenSync] No video element found, sending ready signal anyway');
                                        sendVideoReadySignal();
                                    }
                                }, delay);
                            }
                        } else {
                            // Connection failed - clear stale session data
                            console.log('[OpenSync] Failed to reconnect to server, clearing session');
                            await browser.storage.local.remove(['opensync_room', 'opensync_redirect', 'opensync_just_switched_url', 'opensync_sync_time']);
                            try {
                                browser.runtime.sendMessage({ type: 'LEAVE_ROOM' }).catch(() => { });
                            } catch (e) { }
                        }
                    }
                } catch (e) {
                    console.error('[OpenSync] Auto-join error:', e);
                }
            }
        } else {
            console.log(`[OpenSync] No video yet in ${frameInfo}, controller will keep looking...`);
        }
    }

    // Handle local video events
    function handleLocalPlay(state) {
        if (!isConnected || !state) return;
        
        // Don't broadcast video events if we're navigating, redirect is pending, or waiting for all ready
        if (isNavigatingAway || isPendingRedirect || isWaitingForAllReady) {
            console.log('[OpenSync] Skipping PLAY broadcast (navigation/loading in progress)');
            return;
        }

        lastLocalActionTime = Date.now();

        // Prevent redundant PLAY events
        if (lastPlayingState === true) return;
        lastPlayingState = true;

        console.log('[OpenSync] Sending PLAY to server at', state.currentTime.toFixed(2));
        OpenSyncWebSocketClient.sendPlay(state.currentTime);
    }

    function handleLocalPause(state) {
        if (!isConnected || !state) return;
        
        // Don't broadcast video events if we're navigating, redirect is pending, or waiting for all ready
        if (isNavigatingAway || isPendingRedirect || isWaitingForAllReady) {
            console.log('[OpenSync] Skipping PAUSE broadcast (navigation/loading in progress)');
            return;
        }

        lastLocalActionTime = Date.now();

        // Prevent redundant PAUSE events
        if (lastPlayingState === false) return;
        lastPlayingState = false;

        console.log('[OpenSync] Sending PAUSE to server at', state.currentTime.toFixed(2));
        OpenSyncWebSocketClient.sendPause(state.currentTime);
    }

    function handleLocalSeek(state) {
        if (!isConnected || !state) return;
        
        // Don't broadcast video events if we're navigating, redirect is pending, or waiting for all ready
        if (isNavigatingAway || isPendingRedirect || isWaitingForAllReady) {
            console.log('[OpenSync] Skipping SEEK broadcast (navigation/loading in progress)');
            return;
        }

        lastLocalActionTime = Date.now();
        isLocallyBuffering = false; // Reset

        // Robustness: fall back to lastPlayingState to handle race conditions
        const effectiveIsPlaying = state.isPlaying || (lastPlayingState === true);

        console.log('[OpenSync] Sending SEEK ... isPlaying:', effectiveIsPlaying);
        OpenSyncWebSocketClient.sendSeek(state.currentTime, effectiveIsPlaying);
    }

    function handleLocalBuffer(state) {
        if (!isConnected) return;
        
        // Don't broadcast video events if we're navigating, redirect is pending, or waiting for all ready
        if (isNavigatingAway || isPendingRedirect || isWaitingForAllReady) {
            return;
        }

        // If we recently interacted, keep priority during buffering
        if (Date.now() - lastLocalActionTime < IGNORE_INCOMING_MS) {
            isLocallyBuffering = true;
            lastLocalActionTime = Date.now(); // Keep lock active
        }

        console.log('[OpenSync] Buffering...');
        // Send BUFFER=true to pause others
        OpenSyncWebSocketClient.sendBuffer(state.currentTime, true);
    }

    function handleLocalPlaying(state) {
        if (!isConnected || !state) return;
        
        // Don't broadcast video events if we're navigating, redirect is pending, or waiting for all ready
        if (isNavigatingAway || isPendingRedirect || isWaitingForAllReady) {
            return;
        }

        // If we finished buffering from a local action, extend the lock
        if (isLocallyBuffering) {
            isLocallyBuffering = false;
            lastLocalActionTime = Date.now(); // Extend lock now that we are playing
            console.log('[OpenSync] Local buffering finished, extending priority lock');
        }

        // Resume others when we are playing again
        console.log('[OpenSync] Resumed playing, sending PLAY');
        // We use sendPlay instead of sendBuffer(false) to ensure playback resumes
        OpenSyncWebSocketClient.sendPlay(state.currentTime);
    }

    // Connect to sync server
    async function connectToServer(url) {
        serverUrl = url || serverUrl;

        try {
            console.log('[OpenSync] Connecting to server:', serverUrl);
            await OpenSyncWebSocketClient.connect(serverUrl, {
                onConnect: () => {
                    console.log('[OpenSync] Connected to server!');
                    isConnected = true;
                },
                onDisconnect: () => {
                    console.log('[OpenSync] Disconnected from server');
                    isConnected = false;
                    if (isMainFrame) {
                        OpenSyncOverlay.updateStatus('Disconnected');
                        
                        // Clear background storage if we're not navigating (unexpected disconnect)
                        // Check the local redirect flag (set by checkUrl initialization)
                        if (!isInRedirectMode) {
                            // Notify popup that we disconnected
                            try {
                                browser.runtime.sendMessage({ type: 'ROOM_DISCONNECTED' }).catch(() => { });
                            } catch (e) { }
                        }
                    }
                },
                onError: (error) => {
                    console.error('[OpenSync] Connection error:', error);
                },
                onRoomCreated: handleRoomCreated,
                onRoomJoined: handleRoomJoined,
                onRoomError: handleRoomError,
                onVideoControl: handleRemoteVideoControl,
                onSync: handleRemoteSync,
                onChat: handleChatMessage,
                onUserJoined: handleUserJoined,
                onUserLeft: handleUserLeft,
                onRoomState: handleRoomState,
                onSyncRequest: handleSyncRequest,
                onUrlChange: handleRemoteUrlChange,
                onForceSync: handleRemoteForceSync,
                onAllReady: handleAllReady,
                onWaitingForOthers: handleWaitingForOthers
            });

            return true;
        } catch (error) {
            console.error('[OpenSync] Failed to connect:', error);
            return false;
        }
    }

    // Room event handlers
    async function handleRoomCreated(payload) {
        roomCode = payload.roomCode;
        isHost = true;
        participantCount = 1;

        console.log('[OpenSync] Room created:', roomCode);

        // Initialize content tracking
        lastKnownContentId = getContentIdFromUrl(window.location.href, currentPlatform);

        // Persist session using browser.storage.local (persists across origins)
        // Include tabSessionId to prevent other tabs from hijacking this session
        try {
            await browser.storage.local.set({
                opensync_room: {
                    roomCode: payload.roomCode,
                    username: username,
                    serverUrl: serverUrl,
                    platform: currentPlatform,
                    tabSessionId: tabSessionId  // Tab-specific ID to isolate sync
                }
            });
        } catch (e) {
            console.warn('[OpenSync] Failed to save session:', e);
        }

        // Send current URL and video time to server so joining users can be redirected and synced
        if (isConnected) {
            // Get current video time to include with URL
            const state = OpenSyncVideoController.getState();
            const currentTime = state?.currentTime || 0;
            
            console.log('[OpenSync] Sending initial URL with time:', currentTime.toFixed(2));
            OpenSyncWebSocketClient.sendUrlChange(window.location.href, currentTime);
            
            // Also send video state for sync
            if (state) {
                OpenSyncWebSocketClient.sendSync({
                    currentTime: state.currentTime,
                    isPlaying: state.isPlaying,
                    playbackRate: state.playbackRate || 1
                });
            }
        }

        // Only create overlay in main frame
        if (isMainFrame) {
            OpenSyncOverlay.create({
                onChatSend: (text) => {
                    OpenSyncWebSocketClient.sendChat(text);
                    OpenSyncOverlay.addChatMessage(username, text, true);
                },
                onForceSync: handleForceSync
            });
            OpenSyncOverlay.updateRoomInfo(roomCode, participantCount);
            OpenSyncOverlay.updateStatus('Syncing');
            OpenSyncOverlay.addSystemMessage('Room created! Share the code to invite others.');
        }
    }

    // Handle Force Sync button click
    function handleForceSync() {
        // Global Mode: Request state from iframe first
        if (isGlobalMode && iframeVideoSource && !OpenSyncVideoController.isAvailable()) {
            console.log('[OpenSync] Force Sync: Requesting state from iframe (Global Mode)');
            
            // Set up a one-time listener for the state response
            const handleForceSyncResponse = (event) => {
                if (event.data?.source !== 'OPENSYNC_IFRAME' || event.data.type !== 'STATE_RESPONSE') return;
                
                window.removeEventListener('message', handleForceSyncResponse);
                
                const state = event.data.state;
                if (!state || !isConnected) {
                    if (isMainFrame) {
                        OpenSyncOverlay.addSystemMessage('Error: No video state available');
                    }
                    return;
                }
                
                console.log('[OpenSync] Force Sync with iframe state at', state.currentTime?.toFixed(2));
                OpenSyncWebSocketClient.sendForceSync(state.currentTime);
                
                if (isMainFrame) {
                    OpenSyncOverlay.addSystemMessage(`Force syncing all users to ${state.currentTime?.toFixed(1)}s...`);
                }
            };
            
            window.addEventListener('message', handleForceSyncResponse);
            requestIframeState();
            
            // Timeout fallback
            setTimeout(() => {
                window.removeEventListener('message', handleForceSyncResponse);
            }, 2000);
            return;
        }

        // Force re-detection of video element before getting state
        // This ensures we have the correct video for streaming platforms
        if (currentPlatform) {
            OpenSyncVideoController.redetect(currentPlatform);
        }

        // Small delay to let redetection complete
        setTimeout(() => {
            const state = OpenSyncVideoController.getState();
            if (!state || !isConnected) {
                console.warn('[OpenSync] Cannot force sync: no video or not connected');
                if (isMainFrame) {
                    OpenSyncOverlay.addSystemMessage('Error: No video found to sync');
                }
                return;
            }

            // Sanity check - if duration is available, time should be less than duration
            if (state.duration && state.currentTime > state.duration) {
                console.warn('[OpenSync] Invalid time detected, currentTime > duration');
                if (isMainFrame) {
                    OpenSyncOverlay.addSystemMessage('Error: Invalid video state');
                }
                return;
            }

            console.log('[OpenSync] Initiating Force Sync at', state.currentTime.toFixed(2), 'duration:', state.duration?.toFixed(0));

            // Send force sync command to all users
            OpenSyncWebSocketClient.sendForceSync(state.currentTime);

            // Show feedback
            if (isMainFrame) {
                OpenSyncOverlay.addSystemMessage(`Force syncing all users to ${state.currentTime.toFixed(1)}s...`);
            }
        }, 100);
    }

    async function handleRoomJoined(payload) {
        roomCode = payload.roomCode;
        isHost = false;
        participantCount = payload.participants || 2;
        
        // Set platform from room if available
        if (payload.platform && !currentPlatform) {
            currentPlatform = payload.platform;
            console.log('[OpenSync] Platform set from room:', currentPlatform);
            
            // Initialize the bridge for this platform
            OpenSyncVideoController.setPlatform(currentPlatform);
            
            // Set Global Mode flag if platform is 'global'
            if (currentPlatform === 'global') {
                isGlobalMode = true;
                console.log('[OpenSync] Global Mode enabled from room platform');
            }
        }

        console.log('[OpenSync] Joined room:', roomCode);

        // Persist session using browser.storage.local FIRST (before any redirect)
        // This persists across origins which is critical for cross-site redirects
        // Include tabSessionId to prevent other tabs from hijacking this session
        try {
            await browser.storage.local.set({
                opensync_room: {
                    roomCode: payload.roomCode,
                    username: username,
                    serverUrl: serverUrl,
                    platform: currentPlatform,
                    tabSessionId: tabSessionId  // Tab-specific ID to isolate sync
                }
            });
            console.log('[OpenSync] Session saved to browser.storage.local');
        } catch (e) {
            console.warn('[OpenSync] Failed to save session:', e);
        }

        // Update content tracking to match room's URL (prevents checkUrl from detecting false changes)
        if (payload.currentUrl) {
            lastKnownUrl = window.location.href;
            lastKnownContentId = getContentIdFromUrl(window.location.href, currentPlatform);
            console.log('[OpenSync] Updated content tracking:', lastKnownContentId);
        }
        
        // Check if we need to redirect to the video URL
        // This enables joining from any tab
        if (payload.currentUrl && !isSameContent(payload.currentUrl, window.location.href, currentPlatform)) {
            console.log('[OpenSync] Joining from different page, redirecting to video:', payload.currentUrl);
            
            // Set redirect flags using browser.storage.local (persists across origins!)
            try {
                await browser.storage.local.set({
                    opensync_redirect: true,
                    opensync_just_switched_url: true
                });
                console.log('[OpenSync] Redirect flags saved');
            } catch (e) {
                console.warn('[OpenSync] Failed to save redirect flags:', e);
            }
            
            // Update tracking for the redirect target
            lastKnownUrl = payload.currentUrl;
            lastKnownContentId = getContentIdFromUrl(payload.currentUrl, currentPlatform);
            
            // Redirect to the video URL
            window.location.href = payload.currentUrl;
            return; // Stop here - page will reload
        }

        // Only create overlay in main frame
        if (isMainFrame) {
            OpenSyncOverlay.create({
                onChatSend: (text) => {
                    OpenSyncWebSocketClient.sendChat(text);
                    OpenSyncOverlay.addChatMessage(username, text, true);
                },
                onForceSync: handleForceSync
            });
            OpenSyncOverlay.updateRoomInfo(roomCode, participantCount);
            OpenSyncOverlay.updateStatus('Syncing');
            
            // Only show "Joined" message if not a reconnection after redirect
            if (!payload.isReconnection) {
                OpenSyncOverlay.addSystemMessage('Joined the room!');
            } else {
                console.log('[OpenSync] Reconnected after navigation - staying synced');
            }
        }

        // Sync URL: If we navigated (changed video), tell room. Else follow room.
        if (isNavigation) {
            console.log('[OpenSync] We navigated, pushing update to room');
            OpenSyncWebSocketClient.sendUrlChange(window.location.href);
            isNavigation = false;
        } else if (payload.currentUrl && !isSameContent(payload.currentUrl, window.location.href, currentPlatform)) {
            // We're on a different video than the room - this shouldn't happen after the redirect above
            // but handle it as a fallback
            handleRemoteUrlChange({ url: payload.currentUrl });
        }

        // Request sync from host
        OpenSyncWebSocketClient.requestSync();
    }

    function handleRoomError(payload) {
        console.error('[OpenSync] Room error:', payload.message);

        // If room invalid, clear session
        browser.storage.local.remove(['opensync_room', 'opensync_redirect', 'opensync_just_switched_url', 'opensync_sync_time']).catch(() => {});

        if (isMainFrame) {
            OpenSyncOverlay.addSystemMessage('Error: ' + payload.message);
        }
    }

    // Remote video control handlers
    function handleRemoteVideoControl(type, payload) {
        // Ignore remote commands if a redirect is pending - we're about to change pages
        if (isPendingRedirect) {
            console.log(`[OpenSync] Ignoring remote ${type} (redirect pending to ${pendingRedirectUrl})`);
            return;
        }
        
        // Ignore remote commands if waiting for all users to be ready
        if (isWaitingForAllReady) {
            console.log(`[OpenSync] Ignoring remote ${type} (waiting for all users to load)`);
            return;
        }
        
        // Ignore remote commands if user is actively interacting
        if (Date.now() - lastLocalActionTime < IGNORE_INCOMING_MS) {
            console.log(`[OpenSync] Ignoring remote ${type} (recent local action)`);
            return;
        }

        console.log('[OpenSync] Remote command received:', type, 'at', payload.currentTime?.toFixed(2));

        // Global Mode: Relay commands to iframe if we have an iframe video source
        if (isGlobalMode && iframeVideoSource && !OpenSyncVideoController.isAvailable()) {
            console.log('[OpenSync] Relaying command to iframe (Global Mode)');
            
            switch (type) {
                case 'PLAY':
                    lastPlayingState = true;
                    sendCommandToIframe('PLAY', { currentTime: payload.currentTime });
                    break;
                case 'PAUSE':
                    lastPlayingState = false;
                    sendCommandToIframe('PAUSE', { currentTime: payload.currentTime });
                    break;
                case 'SEEK':
                    sendCommandToIframe('SEEK', { 
                        currentTime: payload.currentTime, 
                        isPlaying: payload.isPlaying 
                    });
                    if (payload.isPlaying === true) {
                        lastPlayingState = true;
                    } else if (payload.isPlaying === false) {
                        lastPlayingState = false;
                    }
                    break;
                case 'BUFFER':
                    if (payload.isBuffering) {
                        lastPlayingState = false;
                        sendCommandToIframe('PAUSE', { currentTime: payload.currentTime });
                        if (isMainFrame) {
                            OpenSyncOverlay.addSystemMessage(payload.username + ' is buffering...');
                        }
                    }
                    break;
            }
            return;
        }

        // Standard mode: Control local video directly
        switch (type) {
            case 'PLAY':
                // Update local state tracker so we don't echo back
                lastPlayingState = true;
                // Only seek if we are significantly off (> 0.5s)
                const localState = OpenSyncVideoController.getState();
                if (localState) {
                    const currentDiffPlay = Math.abs(localState.currentTime - payload.currentTime);
                    if (currentDiffPlay > 0.5) {
                        OpenSyncVideoController.seek(payload.currentTime);
                    }
                }
                OpenSyncVideoController.play();
                break;
            case 'PAUSE':
                // Update local state tracker so we don't echo back
                lastPlayingState = false;
                // Only seek if we are significantly off (> 0.5s)
                const localStatePause = OpenSyncVideoController.getState();
                if (localStatePause) {
                    const currentDiffPause = Math.abs(localStatePause.currentTime - payload.currentTime);
                    if (currentDiffPause > 0.5) {
                        OpenSyncVideoController.seek(payload.currentTime);
                    }
                }
                OpenSyncVideoController.pause();
                break;
            case 'SEEK':
                OpenSyncVideoController.seek(payload.currentTime);
                // Preserve play/pause state after seeking
                if (payload.isPlaying === true) {
                    lastPlayingState = true;
                    // Add small delay to let seek settle before playing
                    setTimeout(() => OpenSyncVideoController.play(), 500);
                } else if (payload.isPlaying === false) {
                    lastPlayingState = false;
                    OpenSyncVideoController.pause();
                }
                break;
            case 'BUFFER':
                if (payload.isBuffering) {
                    console.log('[OpenSync] Remote user buffering, pausing...');
                    lastPlayingState = false; // Remotely paused
                    OpenSyncVideoController.pause();
                    if (isMainFrame) {
                        OpenSyncOverlay.addSystemMessage(payload.username + ' is buffering...');
                    }
                }
                break;
        }
    }

    function handleRemoteSync(payload) {
        // Ignore sync updates if a redirect is pending
        if (isPendingRedirect) {
            console.log('[OpenSync] Ignoring sync (redirect pending)');
            return;
        }
        
        // Ignore sync updates if waiting for all users to be ready
        if (isWaitingForAllReady) {
            console.log('[OpenSync] Ignoring sync (waiting for all users to load)');
            return;
        }
        
        // Ignore sync updates if user is actively interacting
        if (Date.now() - lastLocalActionTime < IGNORE_INCOMING_MS) {
            return;
        }

        console.log('[OpenSync] Sync received:', payload);

        // Update local state tracker to match remote state
        // This is CRITICAL: otherwise we might ignore valid user actions because we think we are in the wrong state.
        if (typeof payload.isPlaying === 'boolean') {
            lastPlayingState = payload.isPlaying;
        }

        // Global Mode: Relay sync to iframe
        if (isGlobalMode && iframeVideoSource && !OpenSyncVideoController.isAvailable()) {
            console.log('[OpenSync] Relaying sync to iframe (Global Mode)');
            sendCommandToIframe('SYNC', {
                state: {
                    currentTime: payload.currentTime,
                    isPlaying: payload.isPlaying,
                    playbackRate: payload.playbackRate
                }
            });
            return;
        }

        OpenSyncVideoController.syncToState({
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
            playbackRate: payload.playbackRate
        });
    }

    function handleSyncRequest(payload) {
        // Only host responds to sync requests
        if (!isHost) return;

        // Global Mode: Request state from iframe
        if (isGlobalMode && iframeVideoSource && !OpenSyncVideoController.isAvailable()) {
            console.log('[OpenSync] Requesting state from iframe for sync request');
            requestIframeState();
            return; // Response will be sent when STATE_RESPONSE is received
        }

        const state = OpenSyncVideoController.getState();
        if (state) {
            console.log('[OpenSync] Responding to sync request with state:', state);
            OpenSyncWebSocketClient.sendSync({
                currentTime: state.currentTime,
                isPlaying: state.isPlaying,
                playbackRate: state.playbackRate
            });
        }
    }

    function handleChatMessage(payload) {
        if (payload.username !== username && isMainFrame) {
            OpenSyncOverlay.addChatMessage(payload.username, payload.text, false);
        }
    }

    function handleUserJoined(payload) {
        participantCount = payload.participants || participantCount + 1;
        if (isMainFrame) {
            OpenSyncOverlay.updateRoomInfo(roomCode, participantCount);
            OpenSyncOverlay.addSystemMessage(payload.username + ' joined the room');
        }

        // Notify popup
        try {
            browser.runtime.sendMessage({
                type: 'PARTICIPANT_UPDATE',
                count: participantCount
            }).catch(() => { });
        } catch (e) { }
    }

    function handleUserLeft(payload) {
        participantCount = payload.participants || Math.max(1, participantCount - 1);
        if (isMainFrame) {
            OpenSyncOverlay.updateRoomInfo(roomCode, participantCount);
            OpenSyncOverlay.addSystemMessage(payload.username + ' left the room');
        }

        // Notify popup
        try {
            browser.runtime.sendMessage({
                type: 'PARTICIPANT_UPDATE',
                count: participantCount
            }).catch(() => { });
        } catch (e) { }
    }

    function handleRoomState(payload) {
        participantCount = payload.participants || 1;
        if (isMainFrame) {
            OpenSyncOverlay.updateRoomInfo(roomCode, participantCount);
        }

        // Sync to current video state if provided
        if (payload.videoState) {
            handleRemoteSync(payload.videoState);
        }
    }

    // Message handlers from popup/background (only in main frame)
    if (isMainFrame && typeof browser !== 'undefined') {
        browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
            console.log('[OpenSync] Message received:', message.type);

            switch (message.type) {
                case 'CREATE_ROOM':
                    handleCreateRoom(message, sendResponse);
                    return true;

                case 'JOIN_ROOM':
                    handleJoinRoom(message, sendResponse);
                    return true;

                case 'LEAVE_ROOM':
                    handleLeaveRoom(sendResponse);
                    return true;

                case 'ROOM_UPDATED':
                    // Background script informing us about room state
                    if (message.room) {
                        roomCode = message.room.code;
                        isHost = message.room.isHost;
                        participantCount = message.room.participants || 1;
                    }
                    return false;

                case 'ROOM_LEFT':
                    handleLeaveRoom(() => { });
                    return false;

                default:
                    return false;
            }
        });
    }

    async function handleCreateRoom(message, sendResponse) {
        try {
            // Check if Global Mode is requested
            if (message.globalMode) {
                isGlobalMode = true;
                currentPlatform = 'global';
                console.log('[OpenSync] Creating room in Global Mode');
                // Initialize global bridge for event capture
                OpenSyncVideoController.setPlatform(currentPlatform);
            } else if (message.platform) {
                // Set platform if provided
                currentPlatform = message.platform;
                OpenSyncVideoController.setPlatform(currentPlatform);
                console.log('[OpenSync] Creating room with platform:', currentPlatform);
            } else {
                console.log('[OpenSync] Creating room without platform selection');
            }

            // Set username if provided
            if (message.username) {
                username = message.username;
                console.log('[OpenSync] Setting username:', username);
            }

            // Initialize if needed
            if (!isInitialized) {
                init();
            }

            // Re-detect video with platform (including Global Mode for bridge initialization)
            if (currentPlatform) {
                OpenSyncVideoController.redetect(currentPlatform);
            }

            // Check if we have a local video
            hasLocalVideo = OpenSyncVideoController.isAvailable();
            console.log('[OpenSync] Has local video:', hasLocalVideo, 'Has iframe video:', !!iframeVideoSource);

            // If no local video and no iframe video yet, that's okay for Global Mode
            // The iframe will announce itself when the video loads
            if (!hasLocalVideo && !iframeVideoSource && !isGlobalMode) {
                console.warn('[OpenSync] No video detected, but continuing...');
            }

            // Connect to server
            serverUrl = message.serverUrl || serverUrl;
            const connected = await connectToServer(serverUrl);

            if (!connected) {
                sendResponse({ success: false, error: 'Could not connect to server' });
                return;
            }

            // Create room with platform (use 'global' for Global Mode)
            OpenSyncWebSocketClient.createRoom(username, currentPlatform);

            // Wait for room creation with timeout
            let waited = 0;
            while (!roomCode && waited < 3000) {
                await new Promise(resolve => setTimeout(resolve, 100));
                waited += 100;
            }

            if (roomCode) {
                console.log('[OpenSync] Room created successfully:', roomCode);
                sendResponse({ success: true, roomCode: roomCode });
            } else {
                sendResponse({ success: false, error: 'Room creation timeout' });
            }
        } catch (error) {
            console.error('[OpenSync] Create room error:', error);
            sendResponse({ success: false, error: error.message });
        }
    }

    async function handleJoinRoom(message, sendResponse) {
        try {
            console.log('[OpenSync] Joining room:', message.roomCode);

            // Set username if provided
            if (message.username) {
                username = message.username;
                console.log('[OpenSync] Setting username:', username);
            }

            // Initialize if needed
            if (!isInitialized) {
                init();
            }

            // Connect to server
            serverUrl = message.serverUrl || serverUrl;
            const connected = await connectToServer(serverUrl);

            if (!connected) {
                sendResponse({ success: false, error: 'Could not connect to server' });
                return;
            }

            // Join room
            OpenSyncWebSocketClient.joinRoom(message.roomCode, username);

            // Wait for join confirmation with timeout
            let waited = 0;
            while (roomCode !== message.roomCode && waited < 3000) {
                await new Promise(resolve => setTimeout(resolve, 100));
                waited += 100;
            }

            if (roomCode === message.roomCode) {
                console.log('[OpenSync] Joined room successfully');
                sendResponse({ success: true, participants: participantCount });
            } else {
                sendResponse({ success: false, error: 'Could not join room' });
            }
        } catch (error) {
            console.error('[OpenSync] Join room error:', error);
            sendResponse({ success: false, error: error.message });
        }
    }

    function handleLeaveRoom(sendResponse) {
        OpenSyncWebSocketClient.disconnect();
        if (isMainFrame) {
            OpenSyncOverlay.destroy();
        }

        isConnected = false;
        isHost = false;
        roomCode = null;
        participantCount = 1;

        // Clear browser.storage.local to prevent auto-reconnect
        browser.storage.local.remove(['opensync_room', 'opensync_redirect', 'opensync_just_switched_url', 'opensync_sync_time']).catch(() => {});

        sendResponse({ success: true });
    }

    // Handle remote Force Sync command
    function handleRemoteForceSync(payload) {
        console.log('[OpenSync] Received Force Sync command at', payload.currentTime?.toFixed(2));

        // Show message to user
        if (isMainFrame) {
            OpenSyncOverlay.addSystemMessage('Syncing to ' + payload.currentTime?.toFixed(1) + 's...');
        }

        // Global Mode: Relay force sync to iframe
        if (isGlobalMode && iframeVideoSource && !OpenSyncVideoController.isAvailable()) {
            console.log('[OpenSync] Relaying Force Sync to iframe (Global Mode)');
            
            // Step 1: Pause
            sendCommandToIframe('PAUSE', { currentTime: payload.currentTime });
            
            // Step 2: Seek (with delay)
            setTimeout(() => {
                sendCommandToIframe('SEEK', { currentTime: payload.currentTime, isPlaying: true });
                
                // Step 3: Play after seek settles
                setTimeout(() => {
                    sendCommandToIframe('PLAY', { currentTime: payload.currentTime });
                    lastPlayingState = true;
                    lastLocalActionTime = 0;
                    
                    if (isMainFrame) {
                        OpenSyncOverlay.addSystemMessage('Synced!');
                    }
                }, 500);
            }, 200);
            return;
        }

        // Execute force sync sequence: pause → seek → play
        const videoController = OpenSyncVideoController;

        // Step 1: Pause
        videoController.pause();

        // Step 2: Seek to target time (with small delay to ensure pause is processed)
        setTimeout(() => {
            videoController.seek(payload.currentTime);

            // Step 3: Play after seek settles
            setTimeout(() => {
                videoController.play();

                // Update our state tracking
                lastPlayingState = true;
                lastLocalActionTime = 0; // Allow remote commands

                if (isMainFrame) {
                    OpenSyncOverlay.addSystemMessage('Synced!');
                }
            }, 500);
        }, 200);
    }

    // Handle ALL_READY - all users have loaded, time to sync and play
    function handleAllReady(payload) {
        console.log('[OpenSync] All users ready! Syncing to', payload.currentTime, 'seconds');
        
        isWaitingForAllReady = false;
        
        if (isMainFrame) {
            OpenSyncOverlay.addSystemMessage('All users ready - playing!');
            OpenSyncOverlay.updateStatus('Syncing');
        }
        
        const syncTime = payload.currentTime || 0;
        
        // Global Mode: Relay to iframe
        if (isGlobalMode && iframeVideoSource && !OpenSyncVideoController.isAvailable()) {
            sendCommandToIframe('SEEK', { currentTime: syncTime, isPlaying: true });
            setTimeout(() => {
                sendCommandToIframe('PLAY', { currentTime: syncTime });
                lastPlayingState = true;
                lastLocalActionTime = 0;
            }, 300);
            return;
        }
        
        // Sync and play
        const videoController = OpenSyncVideoController;
        
        // Seek to sync time
        videoController.seek(syncTime);
        
        // Play after seek settles
        setTimeout(() => {
            videoController.play();
            lastPlayingState = true;
            lastLocalActionTime = 0; // Allow remote commands
        }, 300);
    }

    // Handle WAITING_FOR_OTHERS - show loading status
    function handleWaitingForOthers(payload) {
        console.log(`[OpenSync] Waiting for others: ${payload.ready}/${payload.total} ready`);
        
        if (isMainFrame) {
            OpenSyncOverlay.updateStatus(`Loading (${payload.ready}/${payload.total})`);
            if (payload.ready < payload.total) {
                OpenSyncOverlay.addSystemMessage(`Waiting for others to load... (${payload.ready}/${payload.total})`);
            }
        }
    }

    // Send VIDEO_READY signal when our video is ready to play
    function sendVideoReadySignal() {
        if (!isConnected) return;
        
        console.log('[OpenSync] Sending VIDEO_READY signal');
        OpenSyncWebSocketClient.sendVideoReady();
        
        if (isMainFrame) {
            OpenSyncOverlay.addSystemMessage('Video loaded, waiting for others...');
        }
    }

    // Auto-play after redirect for streaming platforms
    // Uses multiple retries with increasing delays
    let autoPlayAttempts = 0;
    const MAX_AUTOPLAY_ATTEMPTS = 10;
    
    function autoPlayAfterRedirect() {
        autoPlayAttempts = 0;
        attemptAutoPlay();
    }
    
    function attemptAutoPlay() {
        autoPlayAttempts++;
        console.log(`[OpenSync] Auto-play attempt ${autoPlayAttempts}/${MAX_AUTOPLAY_ATTEMPTS} for platform:`, currentPlatform);
        
        // Check if video is already playing
        const video = document.querySelector('video');
        if (video && !video.paused) {
            console.log('[OpenSync] Video is already playing, auto-play successful!');
            return;
        }
        
        // Try using the video controller's play function
        const state = OpenSyncVideoController.getState();
        if (state && state.isPlaying === false) {
            console.log('[OpenSync] Video is paused, attempting to play via controller...');
            OpenSyncVideoController.play();
        }
        
        // Platform-specific auto-play handling
        let clicked = false;
        if (currentPlatform === 'netflix') {
            clicked = tryClickNetflixPlay();
        } else if (currentPlatform === 'primevideo') {
            clicked = tryClickPrimeVideoPlay();
        } else if (currentPlatform === 'hotstar') {
            clicked = tryClickHotstarPlay();
        }
        
        // If video still not playing and we haven't exceeded max attempts, retry
        if (autoPlayAttempts < MAX_AUTOPLAY_ATTEMPTS) {
            setTimeout(() => {
                const v = document.querySelector('video');
                if (v && v.paused) {
                    attemptAutoPlay();
                } else if (v && !v.paused) {
                    console.log('[OpenSync] Video started playing!');
                }
            }, 1000); // Retry every 1 second
        } else {
            console.log('[OpenSync] Max auto-play attempts reached');
            if (isMainFrame) {
                OpenSyncOverlay.addSystemMessage('Click play to start synced playback');
            }
        }
    }
    
    // Netflix auto-play: click the big play button if present
    function tryClickNetflixPlay() {
        console.log('[OpenSync] Netflix: looking for play button...');
        
        // Try multiple selectors for Netflix play button (updated for current Netflix UI)
        const playButtonSelectors = [
            // Current Netflix selectors
            '[data-uia="watch-video-player-play-button"]',
            '[data-uia="player-play-button"]',
            'button[data-uia*="play"]',
            '.watch-video--player-view [aria-label*="play" i]',
            // Older/alternative selectors
            '[data-uia="player-big-play-button"]',
            '.PlayerControlsNeo__button--play',
            '.button-nfplayerPlay',
            // Generic play button patterns
            'button[aria-label="Play"]',
            'button[aria-label="play"]',
            '.nf-player-container button[aria-label*="play" i]',
            // SVG play icon button
            'button svg[data-name="Play"]',
        ];
        
        for (const selector of playButtonSelectors) {
            try {
                const playButton = document.querySelector(selector);
                if (playButton) {
                    console.log('[OpenSync] Found Netflix play button:', selector);
                    // Try both click methods
                    playButton.click();
                    playButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    return true;
                }
            } catch (e) {
                console.log('[OpenSync] Selector failed:', selector, e);
            }
        }
        
        // Try to find any button with play in its accessible name
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
            const ariaLabel = btn.getAttribute('aria-label') || '';
            const dataUia = btn.getAttribute('data-uia') || '';
            if (ariaLabel.toLowerCase().includes('play') || dataUia.toLowerCase().includes('play')) {
                console.log('[OpenSync] Found play button via attributes:', ariaLabel || dataUia);
                btn.click();
                return true;
            }
        }
        
        // Try video.play() directly as last resort
        const video = document.querySelector('video');
        if (video && video.paused) {
            console.log('[OpenSync] Trying direct video.play()...');
            video.play().catch(e => console.log('[OpenSync] Direct play failed:', e.message));
        }
        
        return false;
    }
    
    // Prime Video auto-play
    function tryClickPrimeVideoPlay() {
        console.log('[OpenSync] Prime Video: looking for play button...');
        
        const playButtonSelectors = [
            // Current Prime Video selectors
            '.atvwebplayersdk-playpause-button[aria-label*="Play" i]',
            '[data-testid="play-button"]',
            '.atvwebplayersdk-playpause-button',
            '.fqye4e3[aria-label*="play" i]',
            // Player controls
            '.dv-player-fullscreen button[aria-label*="play" i]',
            'button[aria-label*="Play" i]',
            // Fallback
            '.webPlayerContainer button[aria-label*="play" i]'
        ];
        
        for (const selector of playButtonSelectors) {
            try {
                const playButton = document.querySelector(selector);
                if (playButton) {
                    console.log('[OpenSync] Found Prime Video play button:', selector);
                    playButton.click();
                    return true;
                }
            } catch (e) {}
        }
        
        // Direct play attempt
        const video = document.querySelector('video');
        if (video && video.paused) {
            video.play().catch(e => console.log('[OpenSync] Direct play failed:', e.message));
        }
        
        return false;
    }
    
    // Hotstar auto-play
    function tryClickHotstarPlay() {
        console.log('[OpenSync] Hotstar: looking for play button...');
        
        const playButtonSelectors = [
            '.bmpui-ui-playbacktogglebutton',
            '[data-testid="play-button"]',
            '.icon-player-play',
            'button[aria-label*="Play" i]',
            '.bmpui-ui-hugeplaybacktogglebutton'
        ];
        
        for (const selector of playButtonSelectors) {
            try {
                const playButton = document.querySelector(selector);
                if (playButton) {
                    console.log('[OpenSync] Found Hotstar play button:', selector);
                    playButton.click();
                    return true;
                }
            } catch (e) {}
        }
        
        // Direct play attempt
        const video = document.querySelector('video');
        if (video && video.paused) {
            video.play().catch(e => console.log('[OpenSync] Direct play failed:', e.message));
        }
        
        return false;
    }

    // URL Sync Logic - track redirect state locally to avoid async check every second
    let isInRedirectMode = false;
    let checkUrlInitialized = false;
    
    // Initialize redirect mode from storage on load
    browser.storage.local.get('opensync_redirect').then(result => {
        isInRedirectMode = !!result.opensync_redirect;
        // Clear flag after a delay
        if (isInRedirectMode) {
            console.log('[OpenSync] Redirect mode detected, suppressing URL checks for 5s');
            setTimeout(() => {
                isInRedirectMode = false;
                console.log('[OpenSync] Redirect mode ended');
            }, 5000);
        }
        // Mark as initialized so checkUrl can run
        checkUrlInitialized = true;
    }).catch(() => {
        checkUrlInitialized = true;
    });
    
    // Safety timeout: clear isWaitingForAllReady if it stays true too long
    // This prevents the client from being stuck if ALL_READY is never received
    let waitingForReadyStartTime = null;
    const MAX_WAITING_TIME = 30000; // 30 seconds max
    
    setInterval(() => {
        if (isWaitingForAllReady) {
            if (!waitingForReadyStartTime) {
                waitingForReadyStartTime = Date.now();
            } else if (Date.now() - waitingForReadyStartTime > MAX_WAITING_TIME) {
                console.log('[OpenSync] Safety timeout: clearing isWaitingForAllReady after', MAX_WAITING_TIME/1000, 'seconds');
                isWaitingForAllReady = false;
                isNavigatingAway = false;
                waitingForReadyStartTime = null;
                if (isMainFrame) {
                    OpenSyncOverlay.updateStatus('Syncing');
                    OpenSyncOverlay.addSystemMessage('Sync ready (timeout fallback)');
                }
            }
        } else {
            waitingForReadyStartTime = null;
        }
    }, 5000);
    
    function checkUrl() {
        // Skip if redirect mode check hasn't completed yet
        if (!checkUrlInitialized) {
            return;
        }
        
        // Skip if we're in redirect mode or pending redirect (prevent echo/loops)
        if (isInRedirectMode || isPendingRedirect) {
            return;
        }
        
        // Skip if we're waiting for all users to be ready (we just arrived via redirect)
        if (isWaitingForAllReady) {
            return;
        }

        const currentUrl = window.location.href;
        
        // URL hasn't changed
        if (currentUrl === lastKnownUrl) {
            return;
        }

        // Extract content IDs to check if actual content changed
        const currentContentId = getContentIdFromUrl(currentUrl, currentPlatform);
        const previousContentId = lastKnownContentId;

        // Update tracking
        lastKnownUrl = currentUrl;
        lastKnownContentId = currentContentId;

        // Only broadcast if content actually changed (not just params like playback position)
        if (currentContentId && previousContentId && currentContentId === previousContentId) {
            console.log('[OpenSync] URL params changed but same content, not broadcasting');
            return;
        }

        // Content changed - broadcast to room
        if (isConnected && currentContentId) {
            // Get current video time before pausing (this is where we want everyone to sync)
            const state = OpenSyncVideoController.getState();
            const currentTime = state?.currentTime || 0;
            
            // Set flag to prevent video events from being broadcast during transition
            isNavigatingAway = true;
            isWaitingForAllReady = true; // We're now waiting for all users to load
            pendingSyncTime = currentTime;
            
            console.log('[OpenSync] Content changed to:', currentContentId);
            console.log('[OpenSync] Pausing video at', currentTime, 's and waiting for all users');
            
            // PAUSE the video - we'll resume when all users are ready
            OpenSyncVideoController.pause();
            
            // Broadcast URL change with current time so others know where to sync
            OpenSyncWebSocketClient.sendUrlChange(currentUrl, currentTime);
            
            if (isMainFrame) {
                OpenSyncOverlay.addSystemMessage('Video changed - waiting for others to load...');
                OpenSyncOverlay.updateStatus('Loading...');
            }
            
            // After video loads on new content, send VIDEO_READY
            // Use a delay to allow the new video to initialize
            setTimeout(() => {
                isNavigatingAway = false;
                console.log('[OpenSync] Video transition complete, sending ready signal');
                sendVideoReadySignal();
            }, 2000); // 2 second delay for SPA video transition
        }
    }

    function handleRemoteUrlChange(payload) {
        console.log('[OpenSync] Remote URL change received:', payload.url);

        if (!payload.url) return;

        // Check if we're already on the same content
        if (isSameContent(payload.url, window.location.href, currentPlatform)) {
            console.log('[OpenSync] Already on same content, ignoring URL change');
            return;
        }
        
        // Check if this is the same URL we're already redirecting to (prevent loop)
        if (isPendingRedirect && pendingRedirectUrl === payload.url) {
            console.log('[OpenSync] Already redirecting to this URL, ignoring duplicate');
            return;
        }

        try {
            const newUrl = new URL(payload.url);
            const currentUrl = new URL(window.location.href);

            // Security: Check if same platform/origin for auto-redirect
            // Allow redirect if: same origin, OR same platform domain
            const isSameOrigin = newUrl.origin === currentUrl.origin;
            const isSamePlatform = isSamePlatformDomain(newUrl.hostname, currentUrl.hostname);

            if (isSameOrigin || isSamePlatform) {
                // IMMEDIATELY set ALL blocking flags to stop video command processing
                isPendingRedirect = true;
                isNavigatingAway = true; // Also set this to block outgoing events
                isWaitingForAllReady = true; // We'll wait for ALL_READY after loading
                pendingRedirectUrl = payload.url;
                pendingSyncTime = payload.syncTime || 0; // Store sync time from URL changer
                
                console.log(`[OpenSync] Auto-redirecting to: ${payload.url} (sync time: ${pendingSyncTime}s)`);
                
                // Pause current video before redirecting
                try {
                    OpenSyncVideoController.pause();
                } catch (e) {}
                
                if (isMainFrame) {
                    OpenSyncOverlay.addSystemMessage('Loading new video...');
                    OpenSyncOverlay.updateStatus('Loading...');
                }
                
                // Update our tracking IMMEDIATELY to prevent any URL_CHANGE echo
                lastKnownUrl = payload.url;
                lastKnownContentId = getContentIdFromUrl(payload.url, currentPlatform);
                
                // Set redirect flags using browser.storage.local (persists across origins!)
                // Also store the sync time so we know where to seek after redirect
                browser.storage.local.set({
                    opensync_redirect: true,
                    opensync_just_switched_url: true,
                    opensync_sync_time: pendingSyncTime // Store sync time for after redirect
                }).then(() => {
                    // Disconnect WebSocket BEFORE redirecting to prevent any race conditions
                    // The new page will reconnect
                    try {
                        OpenSyncWebSocketClient.disconnect();
                    } catch (e) {}
                    
                    window.location.href = payload.url;
                }).catch(e => {
                    console.error('[OpenSync] Failed to save redirect flags:', e);
                    // Still redirect even if flag save failed
                    try {
                        OpenSyncWebSocketClient.disconnect();
                    } catch (e2) {}
                    window.location.href = payload.url;
                });
                return;
            }

            // Different platform/origin - need to open in new tab or show prompt
            if (isMainFrame) {
                const platformName = getPlatformDisplayName(newUrl.hostname);
                OpenSyncOverlay.addSystemMessage(
                    `Video changed to ${platformName}. <a href="${payload.url}" target="_blank" style="color: #4CAF50; text-decoration: underline;">Open in New Tab</a>`
                );
            }
        } catch (e) {
            console.error('[OpenSync] Invalid URL update:', e);
        }
    }

    // Check if two hostnames belong to the same platform
    function isSamePlatformDomain(hostname1, hostname2) {
        const h1 = hostname1.toLowerCase();
        const h2 = hostname2.toLowerCase();

        // YouTube domains
        if ((h1.includes('youtube') || h1.includes('youtu.be')) &&
            (h2.includes('youtube') || h2.includes('youtu.be'))) {
            return true;
        }

        // Netflix domains
        if (h1.includes('netflix') && h2.includes('netflix')) {
            return true;
        }

        // Prime Video / Amazon domains
        if ((h1.includes('primevideo') || h1.includes('amazon')) &&
            (h2.includes('primevideo') || h2.includes('amazon'))) {
            return true;
        }

        // Hotstar domains
        if (h1.includes('hotstar') && h2.includes('hotstar')) {
            return true;
        }

        return false;
    }

    // Get display name for platform from hostname
    function getPlatformDisplayName(hostname) {
        const h = hostname.toLowerCase();
        if (h.includes('youtube') || h.includes('youtu.be')) return 'YouTube';
        if (h.includes('netflix')) return 'Netflix';
        if (h.includes('primevideo') || h.includes('amazon')) return 'Prime Video';
        if (h.includes('hotstar')) return 'Hotstar';
        return hostname;
    }

    // Start initialization
    // Ensure platform is known
    if (window.OpenSyncPlatformControllers && !currentPlatform) {
        currentPlatform = window.OpenSyncPlatformControllers.detectPlatform();
        if (currentPlatform) {
            console.log('[OpenSync] Auto-detected platform on load:', currentPlatform);
        }
    }

    init();

    // Re-detect video on navigation (for SPAs)
    if (isMainFrame) {
        let lastUrl = location.href;
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                console.log('[OpenSync] URL changed, re-detecting video');
                // Re-detect platform too
                if (window.OpenSyncPlatformControllers) {
                    const newPlatform = window.OpenSyncPlatformControllers.detectPlatform();
                    if (newPlatform && newPlatform !== currentPlatform) {
                        currentPlatform = newPlatform;
                        OpenSyncVideoController.setPlatform(currentPlatform);
                    }
                }

                setTimeout(() => {
                    OpenSyncVideoController.redetect(currentPlatform);
                }, 1000);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    console.log(`[OpenSync] Content script ready in ${frameInfo}`);

})();
