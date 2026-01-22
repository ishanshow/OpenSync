// OpenSync WebSocket Server
// Handles room management and video sync between clients

const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Room storage
const rooms = new Map();

// Create WebSocket server
const wss = new WebSocket.Server({ port: PORT });

console.log(`[OpenSync Server] Starting on port ${PORT}...`);

// Generate random room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // Make sure code is unique
    if (rooms.has(code)) {
        return generateRoomCode();
    }
    return code;
}

// Send message to a client
function sendToClient(ws, type, payload = {}) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: type,
            payload: payload,
            timestamp: Date.now()
        }));
    }
}

// Broadcast to all clients in a room except sender
function broadcastToRoom(roomCode, type, payload, excludeWs = null) {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.clients.forEach((client) => {
        if (client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
            sendToClient(client.ws, type, payload);
        }
    });
}

// Handle new connection
wss.on('connection', (ws) => {
    console.log('[OpenSync Server] New client connected');

    // Heartbeat setup
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    let clientData = {
        ws: ws,
        roomCode: null,
        username: null,
        isHost: false
    };

    // Handle messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, clientData, message);
        } catch (error) {
            console.error('[OpenSync Server] Failed to parse message:', error);
        }
    });

    // Handle disconnect
    ws.on('close', () => {
        console.log('[OpenSync Server] Client disconnected');
        handleDisconnect(clientData);
    });

    ws.on('error', (error) => {
        console.error('[OpenSync Server] WebSocket error:', error);
    });
});

// Heartbeat interval (30s)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('[OpenSync Server] Terminating inactive client');
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

// Handle incoming messages
function handleMessage(ws, clientData, message) {
    const { type, payload } = message;

    console.log('[OpenSync Server] Received:', type);

    switch (type) {
        case 'CREATE_ROOM':
            handleCreateRoom(ws, clientData, payload);
            break;

        case 'JOIN_ROOM':
            handleJoinRoom(ws, clientData, payload);
            break;

        case 'LEAVE_ROOM':
            handleLeaveRoom(clientData);
            break;

        case 'PLAY':
        case 'PAUSE':
        case 'SEEK':
        case 'BUFFER':
            handleVideoControl(clientData, type, payload);
            break;

        case 'SYNC':
            handleSync(clientData, payload);
            break;

        case 'SYNC_REQUEST':
            handleSyncRequest(clientData, payload);
            break;

        case 'CHAT':
            handleChat(clientData, payload);
            break;

        case 'URL_CHANGE':
            handleUrlChange(clientData, payload);
            break;

        case 'FORCE_SYNC':
            handleForceSync(clientData, payload);
            break;

        default:
            console.log('[OpenSync Server] Unknown message type:', type);
    }
}

// Create a new room
function handleCreateRoom(ws, clientData, payload) {
    const roomCode = generateRoomCode();
    const username = payload.username || 'Host';
    const platform = payload.platform || null;

    // Create room
    rooms.set(roomCode, {
        code: roomCode,
        host: ws,
        clients: new Map(),
        videoState: null,
        currentUrl: null,
        platform: platform,
        createdAt: Date.now()
    });

    // Add client to room as host
    clientData.roomCode = roomCode;
    clientData.username = username;
    clientData.isHost = true;

    const room = rooms.get(roomCode);
    room.clients.set(ws, clientData);

    console.log(`[OpenSync Server] Room ${roomCode} created by ${username} (platform: ${platform || 'generic'})`);

    // Send confirmation
    sendToClient(ws, 'ROOM_CREATED', {
        roomCode: roomCode,
        participants: 1,
        platform: platform
    });
}

// Join an existing room
function handleJoinRoom(ws, clientData, payload) {
    const roomCode = payload.roomCode?.toUpperCase();
    const username = payload.username || 'Guest';

    // Check if room exists
    const room = rooms.get(roomCode);
    if (!room) {
        sendToClient(ws, 'ROOM_ERROR', {
            message: 'Room not found'
        });
        return;
    }

    // Add client to room
    clientData.roomCode = roomCode;
    clientData.username = username;
    clientData.isHost = false;

    room.clients.set(ws, clientData);

    const participantCount = room.clients.size;

    console.log(`[OpenSync Server] ${username} joined room ${roomCode} (${participantCount} participants)`);

    // Send confirmation to joiner
    sendToClient(ws, 'ROOM_JOINED', {
        roomCode: roomCode,
        participants: participantCount,
        currentUrl: room.currentUrl,
        platform: room.platform
    });

    // Notify others in room
    broadcastToRoom(roomCode, 'USER_JOINED', {
        username: username,
        participants: participantCount
    }, ws);

    // Send current video state if available
    if (room.videoState) {
        sendToClient(ws, 'SYNC', room.videoState);
    }
}

// Leave room
function handleLeaveRoom(clientData) {
    const { roomCode, username, ws } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Remove client from room
    room.clients.delete(ws);

    const participantCount = room.clients.size;

    console.log(`[OpenSync Server] ${username} left room ${roomCode} (${participantCount} remaining)`);

    // If room is empty, delete it
    if (participantCount === 0) {
        rooms.delete(roomCode);
        console.log(`[OpenSync Server] Room ${roomCode} deleted (empty)`);
    } else {
        // Notify remaining clients
        broadcastToRoom(roomCode, 'USER_LEFT', {
            username: username,
            participants: participantCount
        });

        // If host left, assign new host
        if (clientData.isHost && room.clients.size > 0) {
            const newHost = room.clients.values().next().value;
            newHost.isHost = true;
            room.host = newHost.ws;
            console.log(`[OpenSync Server] New host assigned: ${newHost.username}`);
        }
    }

    // Clear client data
    clientData.roomCode = null;
    clientData.username = null;
    clientData.isHost = false;
}

// Handle video control commands
function handleVideoControl(clientData, type, payload) {
    const { roomCode, username, ws } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    console.log(`[OpenSync Server] ${type} from ${username} at ${payload.currentTime}${payload.isPlaying !== undefined ? ` (isPlaying: ${payload.isPlaying})` : ''}`);

    // Update room's video state
    // For SEEK, preserve isPlaying from payload; for PLAY/PAUSE, derive from command type
    // For BUFFER, if buffering=true, treat as pause
    let isPlaying;
    if (type === 'SEEK') {
        isPlaying = payload.isPlaying;
    } else if (type === 'BUFFER') {
        // If buffering, we are not playing
        isPlaying = !payload.isBuffering;
    } else {
        isPlaying = type === 'PLAY';
    }

    room.videoState = {
        currentTime: payload.currentTime,
        isPlaying: isPlaying,
        lastUpdated: Date.now()
    };

    // Broadcast to all other clients - include isPlaying for SEEK, isBuffering for BUFFER
    broadcastToRoom(roomCode, type, {
        currentTime: payload.currentTime,
        isPlaying: isPlaying,
        isBuffering: payload.isBuffering,
        username: username
    }, ws);
}

// Handle sync state updates
function handleSync(clientData, payload) {
    const { roomCode, ws } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Update room's video state
    room.videoState = {
        currentTime: payload.currentTime,
        isPlaying: payload.isPlaying,
        playbackRate: payload.playbackRate || 1,
        lastUpdated: Date.now()
    };

    // Broadcast to all other clients
    broadcastToRoom(roomCode, 'SYNC', room.videoState, ws);
}

// Handle sync requests (from newly joined clients)
function handleSyncRequest(clientData, payload) {
    const { roomCode } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Ask host to send current state
    if (room.host && room.host.readyState === WebSocket.OPEN) {
        sendToClient(room.host, 'SYNC_REQUEST', {
            requestedBy: clientData.username
        });
    }
}

// Handle chat messages
function handleChat(clientData, payload) {
    const { roomCode, username, ws } = clientData;

    if (!roomCode) return;

    console.log(`[OpenSync Server] Chat from ${username}: ${payload.text}`);

    // Broadcast to all other clients
    broadcastToRoom(roomCode, 'CHAT', {
        username: payload.username || username,
        text: payload.text
    }, ws);
}

// Handle URL changes
function handleUrlChange(clientData, payload) {
    const { roomCode, username, ws } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    console.log(`[OpenSync Server] URL changed to ${payload.url} by ${username}`);
    room.currentUrl = payload.url;

    // Broadcast to all other clients
    broadcastToRoom(roomCode, 'URL_CHANGE', {
        url: payload.url,
        username: username
    }, ws);
}

// Handle Force Sync
function handleForceSync(clientData, payload) {
    const { roomCode, username } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    console.log(`[OpenSync Server] FORCE SYNC triggered by ${username} at ${payload.currentTime}s`);

    // Broadcast FORCE_SYNC to ALL clients (including sender, for confirmation/feedback)
    room.clients.forEach((client) => {
        if (client.ws.readyState === WebSocket.OPEN) {
            sendToClient(client.ws, 'FORCE_SYNC', {
                currentTime: payload.currentTime,
                username: username
            });
        }
    });

    // Also update server state
    room.videoState = {
        currentTime: payload.currentTime,
        isPlaying: true, // Force sync implies playing after sync
        lastUpdated: Date.now()
    };
}

// Handle client disconnect
function handleDisconnect(clientData) {
    handleLeaveRoom(clientData);
}

// Cleanup stale rooms periodically
setInterval(() => {
    const staleThreshold = 4 * 60 * 60 * 1000; // 4 hours
    const now = Date.now();

    rooms.forEach((room, code) => {
        if (now - room.createdAt > staleThreshold && room.clients.size === 0) {
            rooms.delete(code);
            console.log(`[OpenSync Server] Cleaned up stale room ${code}`);
        }
    });
}, 60 * 60 * 1000); // Every hour

// Log server ready
wss.on('listening', () => {
    console.log(`[OpenSync Server] Ready and listening on port ${PORT}`);
    console.log(`[OpenSync Server] WebSocket URL: ws://localhost:${PORT}`);
});

// Handle server errors
wss.on('error', (error) => {
    console.error('[OpenSync Server] Server error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[OpenSync Server] Shutting down...');
    wss.close(() => {
        console.log('[OpenSync Server] Server closed');
        process.exit(0);
    });
});
