// OpenSync WebSocket Client
// Handles real-time communication with sync server

const OpenSyncWebSocketClient = (function () {
    let ws = null;
    let serverUrl = (typeof OpenSyncProtocol !== 'undefined' && OpenSyncProtocol.DEFAULT_SERVER_URL) || 'wss://opensync.onrender.com';
    let roomCode = null;
    let username = 'User';
    let isConnected = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let eventCallbacks = {};
    let intentionalDisconnect = false;
    let isReconnecting = false;
    let keepaliveInterval = null;

    const MAX_RECONNECT_ATTEMPTS = 10;
    const RECONNECT_DELAY = 2000;
    const WS_CONNECT_TIMEOUT = 15000;
    const KEEPALIVE_INTERVAL = 30000;

    const WAKE_MAX_ATTEMPTS = 40;
    const WAKE_POLL_INTERVAL = 5000;

    function getHttpUrl() {
        return serverUrl
            .replace(/^wss:\/\//, 'https://')
            .replace(/^ws:\/\//, 'http://');
    }

    function startKeepalive() {
        stopKeepalive();
        keepaliveInterval = setInterval(() => {
            if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
                send('PING', {});
            }
        }, KEEPALIVE_INTERVAL);
    }

    function stopKeepalive() {
        if (keepaliveInterval) {
            clearInterval(keepaliveInterval);
            keepaliveInterval = null;
        }
    }

    function wakeServer(onStatus) {
        const healthUrl = getHttpUrl() + '/health';
        let attempt = 0;

        return new Promise((resolve, reject) => {
            function poll() {
                attempt++;
                if (onStatus) onStatus('waking', attempt);
                console.log(`[OpenSync] Wake ping ${attempt}/${WAKE_MAX_ATTEMPTS}: ${healthUrl}`);

                fetch(healthUrl)
                    .then(res => {
                        if (res.ok) {
                            console.log('[OpenSync] Server is awake');
                            if (onStatus) onStatus('ready', attempt);
                            resolve(true);
                        } else {
                            throw new Error('Non-OK status: ' + res.status);
                        }
                    })
                    .catch(err => {
                        console.log(`[OpenSync] Wake ping failed (${attempt}/${WAKE_MAX_ATTEMPTS}):`, err.message);
                        if (attempt >= WAKE_MAX_ATTEMPTS) {
                            if (onStatus) onStatus('failed', attempt);
                            reject(new Error('Server did not wake after ' + WAKE_MAX_ATTEMPTS + ' attempts'));
                        } else {
                            setTimeout(poll, WAKE_POLL_INTERVAL);
                        }
                    });
            }
            poll();
        });
    }

    function connect(url, callbacks = {}) {
        serverUrl = url || serverUrl;
        eventCallbacks = callbacks;
        if (!isReconnecting) {
            intentionalDisconnect = false;
        }

        return new Promise((resolve, reject) => {
            try {
                ws = new WebSocket(serverUrl);

                ws.onopen = () => {
                    console.log('[OpenSync] WebSocket connected');
                    isConnected = true;
                    reconnectAttempts = 0;

                    startKeepalive();

                    const wasReconnecting = isReconnecting;
                    isReconnecting = false;

                    if (eventCallbacks.onConnect) {
                        eventCallbacks.onConnect();
                    }
                    if (wasReconnecting && eventCallbacks.onReconnected) {
                        eventCallbacks.onReconnected();
                    }
                    resolve(true);
                };

                ws.onmessage = (event) => {
                    handleMessage(event.data);
                };

                ws.onclose = (event) => {
                    console.log('[OpenSync] WebSocket closed', event.code);
                    isConnected = false;
                    stopKeepalive();

                    // During reconnection attempts, close events come from failed
                    // reconnect sockets -- handled by scheduleReconnect's catch block
                    if (isReconnecting || intentionalDisconnect) {
                        return;
                    }

                    if (roomCode && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        isReconnecting = true;
                        if (eventCallbacks.onReconnecting) {
                            eventCallbacks.onReconnecting(1);
                        }
                        scheduleReconnect();
                    } else {
                        if (eventCallbacks.onDisconnect) {
                            eventCallbacks.onDisconnect();
                        }
                    }
                };

                ws.onerror = (error) => {
                    console.error('[OpenSync] WebSocket error:', error);
                    if (!isReconnecting && eventCallbacks.onError) {
                        eventCallbacks.onError(error);
                    }
                    reject(error);
                };

                setTimeout(() => {
                    if (!isConnected) {
                        ws.close();
                        reject(new Error('Connection timeout'));
                    }
                }, WS_CONNECT_TIMEOUT);

            } catch (error) {
                reject(error);
            }
        });
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;

        reconnectAttempts++;
        const delay = Math.min(RECONNECT_DELAY * reconnectAttempts, 15000);
        console.log(`[OpenSync] Reconnecting in ${delay}ms... attempt ${reconnectAttempts}`);

        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
                await connect(serverUrl, eventCallbacks);
                if (roomCode) {
                    joinRoom(roomCode, username);
                }
            } catch (e) {
                console.log(`[OpenSync] Reconnect attempt ${reconnectAttempts} failed`);
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    if (eventCallbacks.onReconnecting) {
                        eventCallbacks.onReconnecting(reconnectAttempts + 1);
                    }
                    scheduleReconnect();
                } else {
                    isReconnecting = false;
                    if (eventCallbacks.onReconnectFailed) {
                        eventCallbacks.onReconnectFailed();
                    }
                }
            }
        }, delay);
    }

    // Handle incoming messages
    function handleMessage(data) {
        try {
            const message = JSON.parse(data);
            if (message.type !== 'PONG') {
                console.log('[OpenSync] Received:', message.type);
            }

            switch (message.type) {
                case 'ROOM_CREATED':
                    roomCode = message.payload.roomCode;
                    if (eventCallbacks.onRoomCreated) {
                        eventCallbacks.onRoomCreated(message.payload);
                    }
                    break;

                case 'ROOM_JOINED':
                    roomCode = message.payload.roomCode;
                    if (eventCallbacks.onRoomJoined) {
                        eventCallbacks.onRoomJoined(message.payload);
                    }
                    break;

                case 'ROOM_ERROR':
                    if (eventCallbacks.onRoomError) {
                        eventCallbacks.onRoomError(message.payload);
                    }
                    break;

                case 'SYNC':
                    if (eventCallbacks.onSync) {
                        eventCallbacks.onSync(message.payload);
                    }
                    break;

                case 'PLAY':
                case 'PAUSE':
                case 'SEEK':
                case 'BUFFER':
                    if (eventCallbacks.onVideoControl) {
                        eventCallbacks.onVideoControl(message.type, message.payload);
                    }
                    break;

                case 'CHAT':
                    if (eventCallbacks.onChat) {
                        eventCallbacks.onChat(message.payload);
                    }
                    break;

                case 'USER_JOINED':
                    if (eventCallbacks.onUserJoined) {
                        eventCallbacks.onUserJoined(message.payload);
                    }
                    break;

                case 'USER_LEFT':
                    if (eventCallbacks.onUserLeft) {
                        eventCallbacks.onUserLeft(message.payload);
                    }
                    break;

                case 'ROOM_STATE':
                    if (eventCallbacks.onRoomState) {
                        eventCallbacks.onRoomState(message.payload);
                    }
                    break;

                case 'SYNC_REQUEST':
                    if (eventCallbacks.onSyncRequest) {
                        eventCallbacks.onSyncRequest(message.payload);
                    }
                    break;

                case 'URL_CHANGE':
                    if (eventCallbacks.onUrlChange) {
                        eventCallbacks.onUrlChange(message.payload);
                    }
                    break;

                case 'FORCE_SYNC':
                    if (eventCallbacks.onForceSync) {
                        eventCallbacks.onForceSync(message.payload);
                    }
                    break;

                case 'ALL_READY':
                    if (eventCallbacks.onAllReady) {
                        eventCallbacks.onAllReady(message.payload);
                    }
                    break;

                case 'WAITING_FOR_OTHERS':
                    if (eventCallbacks.onWaitingForOthers) {
                        eventCallbacks.onWaitingForOthers(message.payload);
                    }
                    break;

                case 'PONG':
                    break;

                default:
                    console.log('[OpenSync] Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('[OpenSync] Failed to parse message:', error);
        }
    }

    // Send message
    function send(type, payload = {}) {
        if (!isConnected || !ws) {
            console.warn('[OpenSync] Cannot send, not connected');
            return false;
        }

        const message = {
            type: type,
            payload: payload,
            timestamp: Date.now()
        };

        ws.send(JSON.stringify(message));
        return true;
    }

    function sendUrlChange(url, currentTime = 0) {
        return send('URL_CHANGE', { roomCode, url, currentTime });
    }

    function sendVideoReady() {
        return send('VIDEO_READY', { roomCode });
    }

    function sendForceSync(currentTime) {
        return send('FORCE_SYNC', { roomCode, currentTime });
    }

    function createRoom(user, platform = null) {
        username = user || username;
        return send('CREATE_ROOM', { username, platform });
    }

    function joinRoom(code, user) {
        roomCode = code;
        username = user || username;
        return send('JOIN_ROOM', { roomCode: code, username });
    }

    function leaveRoom() {
        const result = send('LEAVE_ROOM', { roomCode });
        roomCode = null;
        return result;
    }

    function sendSync(state) {
        return send('SYNC', {
            roomCode,
            ...state
        });
    }

    function sendPlay(currentTime) {
        return send('PLAY', { roomCode, currentTime });
    }

    function sendPause(currentTime) {
        return send('PAUSE', { roomCode, currentTime });
    }

    function sendSeek(currentTime, isPlaying) {
        return send('SEEK', { roomCode, currentTime, isPlaying });
    }

    function sendBuffer(currentTime, isBuffering) {
        return send('BUFFER', { roomCode, currentTime, isBuffering });
    }

    function sendChat(text) {
        return send('CHAT', {
            roomCode,
            username,
            text
        });
    }

    function requestSync() {
        return send('SYNC_REQUEST', { roomCode });
    }

    function disconnect() {
        intentionalDisconnect = true;
        isReconnecting = false;
        roomCode = null;

        stopKeepalive();

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        if (ws) {
            leaveRoom();
            ws.close();
            ws = null;
        }

        isConnected = false;
    }

    function getStatus() {
        return {
            isConnected,
            roomCode,
            username,
            serverUrl
        };
    }

    return {
        wakeServer,
        connect,
        disconnect,
        createRoom,
        joinRoom,
        leaveRoom,
        sendSync,
        sendPlay,
        sendPause,
        sendSeek,
        sendBuffer,
        sendChat,
        sendUrlChange,
        sendVideoReady,
        sendForceSync,
        requestSync,
        getStatus
    };
})();

// Make available globally
window.OpenSyncWebSocketClient = OpenSyncWebSocketClient;
