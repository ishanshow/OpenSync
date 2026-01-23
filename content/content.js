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
    // Persist username to session storage to avoid multiple "users" on reload
    let savedUsername = null;
    try {
        const sessionData = sessionStorage.getItem('opensync_room');
        if (sessionData) savedUsername = JSON.parse(sessionData).username;
    } catch (e) { }

    let username = savedUsername || 'User_' + Math.random().toString(36).substring(2, 6);
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

            // Detect Full Page Navigation
            try {
                if (sessionStorage.getItem('opensync_redirect')) {
                    console.log('[OpenSync] Loaded via sync redirect, adhering to room.');
                    // Clear the redirect flag after a delay to ensure it's processed
                    // but also cleared for future navigations
                    setTimeout(() => {
                        sessionStorage.removeItem('opensync_redirect');
                    }, 2000);
                    isNavigation = false;
                } else {
                    const storedUrl = sessionStorage.getItem('opensync_last_url');
                    // Check if content actually changed (not just params)
                    if (storedUrl && !isSameContent(storedUrl, window.location.href, currentPlatform)) {
                        console.log('[OpenSync] Detected content navigation from', storedUrl);
                        isNavigation = true;
                    }
                }
                sessionStorage.setItem('opensync_last_url', window.location.href);
            } catch (e) { }

            isInitialized = true;

            // Check for existing session and reconnect (tab-specific)
            // We use sessionStorage so only THIS specific tab reconnects on refresh.
            // New tabs will not inherit this (avoiding "all tabs playing" issue).
            if (isMainFrame) {
                try {
                    const sessionData = sessionStorage.getItem('opensync_room');
                    if (sessionData) {
                        const data = JSON.parse(sessionData);
                        console.log('[OpenSync] Found session token, reconnecting:', data.roomCode);

                        serverUrl = data.serverUrl || serverUrl;
                        username = data.username || username; // update local var

                        const connected = await connectToServer(serverUrl);
                        if (connected) {
                            console.log('[OpenSync] Rejoining room:', data.roomCode);
                            OpenSyncWebSocketClient.joinRoom(data.roomCode, username);

                            // Wait for room join confirmation before updating background state
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
                                sessionStorage.removeItem('opensync_room');
                                try {
                                    browser.runtime.sendMessage({ type: 'LEAVE_ROOM' }).catch(() => { });
                                } catch (e) { }
                            }

                            // If we just redirected (auto-followed), request sync immediately
                            if (sessionStorage.getItem('opensync_just_switched_url')) {
                                sessionStorage.removeItem('opensync_just_switched_url');
                                setTimeout(() => {
                                    console.log('[OpenSync] Requesting immediate sync after redirect');
                                    OpenSyncWebSocketClient.requestSync();
                                }, 1000);
                            }
                        } else {
                            // Connection failed - clear stale session data
                            console.log('[OpenSync] Failed to reconnect to server, clearing session');
                            sessionStorage.removeItem('opensync_room');
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

        lastLocalActionTime = Date.now();

        // Prevent redundant PLAY events
        if (lastPlayingState === true) return;
        lastPlayingState = true;

        console.log('[OpenSync] Sending PLAY to server at', state.currentTime.toFixed(2));
        OpenSyncWebSocketClient.sendPlay(state.currentTime);
    }

    function handleLocalPause(state) {
        if (!isConnected || !state) return;

        lastLocalActionTime = Date.now();

        // Prevent redundant PAUSE events
        if (lastPlayingState === false) return;
        lastPlayingState = false;

        console.log('[OpenSync] Sending PAUSE to server at', state.currentTime.toFixed(2));
        OpenSyncWebSocketClient.sendPause(state.currentTime);
    }

    function handleLocalSeek(state) {
        if (!isConnected || !state) return;

        lastLocalActionTime = Date.now();
        isLocallyBuffering = false; // Reset

        // Robustness: fall back to lastPlayingState to handle race conditions
        const effectiveIsPlaying = state.isPlaying || (lastPlayingState === true);

        console.log('[OpenSync] Sending SEEK ... isPlaying:', effectiveIsPlaying);
        OpenSyncWebSocketClient.sendSeek(state.currentTime, effectiveIsPlaying);
    }

    function handleLocalBuffer(state) {
        if (!isConnected) return;

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
                        // Navigation will handle its own reconnection logic
                        if (!sessionStorage.getItem('opensync_redirect')) {
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
                onForceSync: handleRemoteForceSync
            });

            return true;
        } catch (error) {
            console.error('[OpenSync] Failed to connect:', error);
            return false;
        }
    }

    // Room event handlers
    function handleRoomCreated(payload) {
        roomCode = payload.roomCode;
        isHost = true;
        participantCount = 1;

        console.log('[OpenSync] Room created:', roomCode);

        // Initialize content tracking
        lastKnownContentId = getContentIdFromUrl(window.location.href, currentPlatform);

        // Persist session to this tab (so we can reconnect after navigation)
        try {
            sessionStorage.setItem('opensync_room', JSON.stringify({
                roomCode: payload.roomCode,
                username: username,
                serverUrl: serverUrl
            }));
        } catch (e) {
            console.warn('[OpenSync] Failed to save session:', e);
        }

        // Send current URL to server so joining users can be redirected
        if (isConnected) {
            OpenSyncWebSocketClient.sendUrlChange(window.location.href);
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

    function handleRoomJoined(payload) {
        roomCode = payload.roomCode;
        isHost = false;
        participantCount = payload.participants || 2;
        
        // Set platform from room if available
        if (payload.platform && !currentPlatform) {
            currentPlatform = payload.platform;
            console.log('[OpenSync] Platform set from room:', currentPlatform);
        }

        console.log('[OpenSync] Joined room:', roomCode);

        // Persist session to this tab FIRST (before any redirect)
        try {
            sessionStorage.setItem('opensync_room', JSON.stringify({
                roomCode: payload.roomCode,
                username: username,
                serverUrl: serverUrl
            }));
        } catch (e) {
            console.warn('[OpenSync] Failed to save session:', e);
        }

        // Check if we need to redirect to the video URL
        // This enables joining from any tab
        if (payload.currentUrl && !isSameContent(payload.currentUrl, window.location.href, currentPlatform)) {
            console.log('[OpenSync] Joining from different page, redirecting to video:', payload.currentUrl);
            
            // Set redirect flags before navigation
            sessionStorage.setItem('opensync_redirect', 'true');
            sessionStorage.setItem('opensync_just_switched_url', 'true');
            
            // Update tracking
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
            OpenSyncOverlay.addSystemMessage('Joined the room!');
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
        sessionStorage.removeItem('opensync_room');

        if (isMainFrame) {
            OpenSyncOverlay.addSystemMessage('Error: ' + payload.message);
        }
    }

    // Remote video control handlers
    function handleRemoteVideoControl(type, payload) {
        // Ignore remote commands if user is actively interacting
        if (Date.now() - lastLocalActionTime < IGNORE_INCOMING_MS) {
            console.log(`[OpenSync] Ignoring remote ${type} (recent local action)`);
            return;
        }

        console.log('[OpenSync] Remote command received:', type, 'at', payload.currentTime?.toFixed(2));

        switch (type) {
            case 'PLAY':
                // Update local state tracker so we don't echo back
                lastPlayingState = true;
                // Only seek if we are significantly off (> 0.5s)
                const currentDiffPlay = Math.abs(OpenSyncVideoController.getState().currentTime - payload.currentTime);
                if (currentDiffPlay > 0.5) {
                    OpenSyncVideoController.seek(payload.currentTime);
                }
                OpenSyncVideoController.play();
                break;
            case 'PAUSE':
                // Update local state tracker so we don't echo back
                lastPlayingState = false;
                // Only seek if we are significantly off (> 0.5s)
                const currentDiffPause = Math.abs(OpenSyncVideoController.getState().currentTime - payload.currentTime);
                if (currentDiffPause > 0.5) {
                    OpenSyncVideoController.seek(payload.currentTime);
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

        OpenSyncVideoController.syncToState({
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
            playbackRate: payload.playbackRate
        });
    }

    function handleSyncRequest(payload) {
        // Only host responds to sync requests
        if (!isHost) return;

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
            // Set platform if provided
            if (message.platform) {
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

            // Re-detect video with platform
            if (currentPlatform) {
                OpenSyncVideoController.redetect(currentPlatform);
            }

            // Connect to server
            serverUrl = message.serverUrl || serverUrl;
            const connected = await connectToServer(serverUrl);

            if (!connected) {
                sendResponse({ success: false, error: 'Could not connect to server' });
                return;
            }

            // Create room with platform
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

        // Clear session storage to prevent auto-reconnect
        try {
            sessionStorage.removeItem('opensync_room');
            sessionStorage.removeItem('opensync_redirect');
            sessionStorage.removeItem('opensync_just_switched_url');
        } catch (e) { }

        sendResponse({ success: true });
    }

    // Handle remote Force Sync command
    function handleRemoteForceSync(payload) {
        console.log('[OpenSync] Received Force Sync command at', payload.currentTime?.toFixed(2));

        // Show message to user
        if (isMainFrame) {
            OpenSyncOverlay.addSystemMessage('Syncing to ' + payload.currentTime?.toFixed(1) + 's...');
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

    // URL Sync Logic
    function checkUrl() {
        // Skip if we just received a redirect (prevent echo)
        if (sessionStorage.getItem('opensync_redirect')) {
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
            console.log('[OpenSync] Content changed to:', currentContentId, '- broadcasting URL:', currentUrl);
            OpenSyncWebSocketClient.sendUrlChange(currentUrl);
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

        try {
            const newUrl = new URL(payload.url);
            const currentUrl = new URL(window.location.href);

            // Security: Check if same platform/origin for auto-redirect
            // Allow redirect if: same origin, OR same platform domain
            const isSameOrigin = newUrl.origin === currentUrl.origin;
            const isSamePlatform = isSamePlatformDomain(newUrl.hostname, currentUrl.hostname);

            if (isSameOrigin || isSamePlatform) {
                // Safe to auto-redirect - set flags to prevent echo
                console.log(`[OpenSync] Auto-redirecting to: ${payload.url}`);
                
                // Set redirect flag BEFORE navigating to prevent the new page from broadcasting back
                sessionStorage.setItem('opensync_redirect', 'true');
                sessionStorage.setItem('opensync_just_switched_url', 'true');
                
                // Update our tracking to match the new URL to prevent double-broadcast
                lastKnownUrl = payload.url;
                lastKnownContentId = getContentIdFromUrl(payload.url, currentPlatform);
                
                window.location.href = payload.url;
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
