// OpenSync WebSocket Client
// Handles real-time communication with sync server

const OpenSyncWebSocketClient = (function () {
    let ws = null;
    let serverUrl = 'ws://localhost:3000';
    let roomCode = null;
    let username = 'User';
    let isConnected = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let eventCallbacks = {};

    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_DELAY = 2000;

    // Initialize WebSocket connection
    function connect(url, callbacks = {}) {
        serverUrl = url || serverUrl;
        eventCallbacks = callbacks;

        return new Promise((resolve, reject) => {
            try {
                ws = new WebSocket(serverUrl);

                ws.onopen = () => {
                    console.log('[OpenSync] WebSocket connected');
                    isConnected = true;
                    reconnectAttempts = 0;

                    if (eventCallbacks.onConnect) {
                        eventCallbacks.onConnect();
                    }
                    resolve(true);
                };

                ws.onmessage = (event) => {
                    handleMessage(event.data);
                };

                ws.onclose = (event) => {
                    console.log('[OpenSync] WebSocket closed', event.code);
                    isConnected = false;

                    if (eventCallbacks.onDisconnect) {
                        eventCallbacks.onDisconnect();
                    }

                    // Attempt reconnection if we were in a room
                    if (roomCode && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        scheduleReconnect();
                    }
                };

                ws.onerror = (error) => {
                    console.error('[OpenSync] WebSocket error:', error);
                    if (eventCallbacks.onError) {
                        eventCallbacks.onError(error);
                    }
                    reject(error);
                };

                // Timeout for connection
                setTimeout(() => {
                    if (!isConnected) {
                        ws.close();
                        reject(new Error('Connection timeout'));
                    }
                }, 5000);

            } catch (error) {
                reject(error);
            }
        });
    }

    // Schedule reconnection attempt
    function scheduleReconnect() {
        if (reconnectTimer) return;

        reconnectAttempts++;
        console.log(`[OpenSync] Reconnecting... attempt ${reconnectAttempts}`);

        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            try {
                await connect(serverUrl, eventCallbacks);
                // Rejoin room after reconnecting
                if (roomCode) {
                    joinRoom(roomCode, username);
                }
            } catch (e) {
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    scheduleReconnect();
                }
            }
        }, RECONNECT_DELAY * reconnectAttempts);
    }

    // Handle incoming messages
    function handleMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('[OpenSync] Received:', message.type);

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
                    // Host should respond with current state
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

    // ... (existing create/join room) ...

    function sendUrlChange(url) {
        return send('URL_CHANGE', { roomCode, url });
    }

    // Send Force Sync command to all users
    function sendForceSync(currentTime) {
        return send('FORCE_SYNC', { roomCode, currentTime });
    }

    // Create a new room
    function createRoom(user, platform = null) {
        username = user || username;
        return send('CREATE_ROOM', { username, platform });
    }

    // Join an existing room
    function joinRoom(code, user) {
        roomCode = code;
        username = user || username;
        return send('JOIN_ROOM', { roomCode: code, username });
    }

    // Leave room
    function leaveRoom() {
        const result = send('LEAVE_ROOM', { roomCode });
        roomCode = null;
        return result;
    }

    // Send sync state
    function sendSync(state) {
        return send('SYNC', {
            roomCode,
            ...state
        });
    }

    // Send video control commands
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

    // Send chat message
    function sendChat(text) {
        return send('CHAT', {
            roomCode,
            username,
            text
        });
    }

    // Request sync from host
    function requestSync() {
        return send('SYNC_REQUEST', { roomCode });
    }

    // Disconnect
    function disconnect() {
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
        roomCode = null;
    }

    // Get connection status
    function getStatus() {
        return {
            isConnected,
            roomCode,
            username,
            serverUrl
        };
    }

    return {
        connect,
        disconnect,
        createRoom,
        joinRoom,
        leaveRoom,
        sendSync,
        sendPlay,
        sendPause,
        sendSeek,
        sendChat,
        sendUrlChange,
        sendForceSync,
        requestSync,
        getStatus
    };
})();

// Make available globally
window.OpenSyncWebSocketClient = OpenSyncWebSocketClient;
