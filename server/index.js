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
        isHost: false,
        currentUrl: null, // Track client's current URL to prevent video command relay during transitions
        isNavigating: false, // True when client just sent URL_CHANGE (in transition)
        isReady: true // Track if client's video is ready to play (for sync on URL change)
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
}, 60000); // Increased to 60s to prevent random disconnects

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
            handleLeaveRoom(clientData, true); // true = explicit leave (no grace period)
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

        case 'VIDEO_READY':
            handleVideoReady(clientData, payload);
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
    // Clear deletion timeout if it exists (room is active again)
    if (room.deleteTimeout) {
        clearTimeout(room.deleteTimeout);
        room.deleteTimeout = null;
        console.log(`[OpenSync Server] Room ${roomCode} deletion cancelled (user joined)`);
    }

    // Check if this user is reconnecting after a redirect/navigation (within grace period)
    let isReconnection = false;
    if (room.pendingDisconnects && room.pendingDisconnects.has(username)) {
        const pendingData = room.pendingDisconnects.get(username);
        clearTimeout(pendingData.timeout);
        room.pendingDisconnects.delete(username);
        isReconnection = true;
        console.log(`[OpenSync Server] ${username} reconnected within grace period (navigation)`);
        
        // Restore host status if they were the host
        if (pendingData.wasHost) {
            clientData.isHost = true;
            room.host = ws;
        }
    }

    // Cleanup existing sessions for this username (prevent duplicates on reload)
    for (const [existingWs, existingClient] of room.clients.entries()) {
        if (existingClient.username === username && existingWs !== ws) {
            console.log(`[OpenSync Server] Removing duplicate session for ${username}`);
            // Remove from room map but don't broadcast leave yet (we'll just replace)
            room.clients.delete(existingWs);
            // Close old socket
            if (existingWs.readyState === WebSocket.OPEN) {
                existingWs.close(); // This might trigger onClose -> handleLeave, so we need to be careful
            }
        }
    }

    clientData.roomCode = roomCode;
    clientData.username = username;
    if (!isReconnection) {
        clientData.isHost = false;
    }

    room.clients.set(ws, clientData);

    const participantCount = room.clients.size + (room.pendingDisconnects ? room.pendingDisconnects.size : 0);

    console.log(`[OpenSync Server] ${username} ${isReconnection ? 'reconnected to' : 'joined'} room ${roomCode} (${participantCount} participants)`);

    // Send confirmation to joiner
    sendToClient(ws, 'ROOM_JOINED', {
        roomCode: roomCode,
        participants: participantCount,
        currentUrl: room.currentUrl,
        platform: room.platform,
        isReconnection: isReconnection
    });

    // Only notify others if this is NOT a reconnection (to avoid leave/join spam during navigation)
    if (!isReconnection) {
        broadcastToRoom(roomCode, 'USER_JOINED', {
            username: username,
            participants: participantCount
        }, ws);
    }

    // Send current video state if available
    if (room.videoState) {
        sendToClient(ws, 'SYNC', room.videoState);
    }
}

// Leave room
function handleLeaveRoom(clientData, isExplicitLeave = false) {
    const { roomCode, username, ws } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Check if this client is still in the room (might have been replaced by reconnection)
    const clientInRoom = room.clients.get(ws);
    if (!clientInRoom) {
        // This client was already removed (likely replaced by a reconnecting session)
        // Don't add to pendingDisconnects or broadcast leave
        console.log(`[OpenSync Server] Client ${username} already removed from room (likely reconnected)`);
        clientData.roomCode = null;
        clientData.username = null;
        clientData.isHost = false;
        return;
    }

    // Remove client from active clients
    room.clients.delete(ws);
    
    // Check if a client with the same username is already in the room (reconnected)
    // If so, this is the old session being cleaned up - don't add to pendingDisconnects
    let hasReconnected = false;
    for (const [existingWs, existingClient] of room.clients.entries()) {
        if (existingClient.username === username) {
            hasReconnected = true;
            console.log(`[OpenSync Server] ${username} already reconnected, not adding to pendingDisconnects`);
            break;
        }
    }
    
    if (hasReconnected) {
        // Client already reconnected, just clean up
        clientData.roomCode = null;
        clientData.username = null;
        clientData.isHost = false;
        return;
    }

    // If this is NOT an explicit leave (i.e., disconnect due to navigation/refresh),
    // add the user to pending disconnects with a grace period
    // This allows them to reconnect without triggering leave/join messages
    const RECONNECT_GRACE_PERIOD = 30 * 1000; // 30 seconds grace period for navigation
    
    if (!isExplicitLeave && username) {
        // Initialize pendingDisconnects map if needed
        if (!room.pendingDisconnects) {
            room.pendingDisconnects = new Map();
        }
        
        // Clear any existing pending disconnect for this user
        if (room.pendingDisconnects.has(username)) {
            clearTimeout(room.pendingDisconnects.get(username).timeout);
        }
        
        console.log(`[OpenSync Server] ${username} disconnected from room ${roomCode} (grace period: ${RECONNECT_GRACE_PERIOD/1000}s)`);
        
        // Add to pending disconnects with a timeout
        const timeoutId = setTimeout(() => {
            // Grace period expired - now actually remove the user
            if (room.pendingDisconnects && room.pendingDisconnects.has(username)) {
                room.pendingDisconnects.delete(username);
                
                const effectiveParticipants = room.clients.size + (room.pendingDisconnects ? room.pendingDisconnects.size : 0);
                
                console.log(`[OpenSync Server] ${username} grace period expired, removed from room ${roomCode} (${effectiveParticipants} remaining)`);
                
                // Notify remaining clients
                if (room.clients.size > 0) {
                    broadcastToRoom(roomCode, 'USER_LEFT', {
                        username: username,
                        participants: effectiveParticipants
                    });
                }
                
                // If the disconnected user was host, assign new host
                if (clientData.isHost && room.clients.size > 0) {
                    const newHost = room.clients.values().next().value;
                    newHost.isHost = true;
                    room.host = newHost.ws;
                    console.log(`[OpenSync Server] New host assigned: ${newHost.username}`);
                }
                
                // Check if room should be deleted
                if (room.clients.size === 0 && room.pendingDisconnects.size === 0) {
                    console.log(`[OpenSync Server] Room ${roomCode} is empty. Scheduling deletion in 2 minutes...`);
                    if (room.deleteTimeout) clearTimeout(room.deleteTimeout);
                    
                    room.deleteTimeout = setTimeout(() => {
                        if (rooms.has(roomCode)) {
                            const r = rooms.get(roomCode);
                            if (r.clients.size === 0 && (!r.pendingDisconnects || r.pendingDisconnects.size === 0)) {
                                rooms.delete(roomCode);
                                console.log(`[OpenSync Server] Room ${roomCode} deleted (expired grace period)`);
                            }
                        }
                    }, 2 * 60 * 1000); // 2 minutes
                }
            }
        }, RECONNECT_GRACE_PERIOD);
        
        room.pendingDisconnects.set(username, {
            timeout: timeoutId,
            wasHost: clientData.isHost,
            disconnectedAt: Date.now()
        });
        
    } else {
        // Explicit leave - immediately remove without grace period
        const participantCount = room.clients.size + (room.pendingDisconnects ? room.pendingDisconnects.size : 0);
        
        console.log(`[OpenSync Server] ${username} explicitly left room ${roomCode} (${participantCount} remaining)`);
        
        // Clear from pending disconnects if present
        if (room.pendingDisconnects && room.pendingDisconnects.has(username)) {
            clearTimeout(room.pendingDisconnects.get(username).timeout);
            room.pendingDisconnects.delete(username);
        }

        // If room is empty, set a timeout to delete it
        if (participantCount === 0) {
            console.log(`[OpenSync Server] Room ${roomCode} is empty. Scheduling deletion in 2 minutes...`);
            if (room.deleteTimeout) clearTimeout(room.deleteTimeout);

            room.deleteTimeout = setTimeout(() => {
                if (rooms.has(roomCode)) {
                    const r = rooms.get(roomCode);
                    if (r.clients.size === 0 && (!r.pendingDisconnects || r.pendingDisconnects.size === 0)) {
                        rooms.delete(roomCode);
                        console.log(`[OpenSync Server] Room ${roomCode} deleted (expired grace period)`);
                    }
                }
            }, 2 * 60 * 1000); // 2 minutes
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

    // Ignore video commands from clients who are navigating (changing videos)
    // This prevents stale video events from old video being relayed
    if (clientData.isNavigating) {
        console.log(`[OpenSync Server] Ignoring ${type} from ${username} (client is navigating)`);
        return;
    }

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

    // Only broadcast to clients on the same URL (or clients without URL tracking)
    // This prevents video commands from being relayed during URL transitions
    const senderUrl = clientData.currentUrl || room.currentUrl;
    
    room.clients.forEach((client) => {
        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
            // Skip clients who are navigating
            if (client.isNavigating) {
                console.log(`[OpenSync Server] Skipping ${type} to ${client.username} (navigating)`);
                return;
            }
            
            // Check if client is on the same URL (or URL unknown)
            const clientUrl = client.currentUrl || room.currentUrl;
            if (senderUrl && clientUrl && senderUrl !== clientUrl) {
                console.log(`[OpenSync Server] Skipping ${type} to ${client.username} (different URL)`);
                return;
            }
            
            sendToClient(client.ws, type, {
                currentTime: payload.currentTime,
                isPlaying: isPlaying,
                isBuffering: payload.isBuffering,
                username: username
            });
        }
    });
}

// Handle sync state updates
function handleSync(clientData, payload) {
    const { roomCode, ws, username } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;
    
    // Ignore sync from clients who are navigating
    if (clientData.isNavigating) {
        console.log(`[OpenSync Server] Ignoring SYNC from ${username} (client is navigating)`);
        return;
    }

    // Update room's video state
    room.videoState = {
        currentTime: payload.currentTime,
        isPlaying: payload.isPlaying,
        playbackRate: payload.playbackRate || 1,
        lastUpdated: Date.now()
    };

    // Only broadcast to clients on the same URL
    const senderUrl = clientData.currentUrl || room.currentUrl;
    
    room.clients.forEach((client) => {
        if (client.ws !== ws && client.ws.readyState === WebSocket.OPEN) {
            // Skip clients who are navigating
            if (client.isNavigating) {
                return;
            }
            
            // Check if client is on the same URL
            const clientUrl = client.currentUrl || room.currentUrl;
            if (senderUrl && clientUrl && senderUrl !== clientUrl) {
                return;
            }
            
            sendToClient(client.ws, 'SYNC', room.videoState);
        }
    });
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
    
    // Mark client as navigating - their video events should be ignored temporarily
    clientData.isNavigating = true;
    clientData.currentUrl = payload.url;
    
    // Clear navigating flag after a delay (allow time for video transition)
    setTimeout(() => {
        clientData.isNavigating = false;
    }, 3000);
    
    room.currentUrl = payload.url;
    
    // Mark ALL clients as NOT ready - they need to load the new video
    // This triggers the "wait for all ready" sync mechanism
    room.clients.forEach((client) => {
        client.isReady = false;
    });
    
    // Store the sync time from the URL changer (they know where they are in the video)
    room.pendingSyncTime = payload.currentTime || 0;
    room.pendingSyncUser = username;
    
    console.log(`[OpenSync Server] All clients marked not ready, pending sync at ${room.pendingSyncTime}s`);

    // Broadcast to all other clients (they need to redirect/load)
    broadcastToRoom(roomCode, 'URL_CHANGE', {
        url: payload.url,
        username: username,
        syncTime: room.pendingSyncTime // Include sync time so they know where to seek
    }, ws);
}

// Handle client reporting video is ready to play
function handleVideoReady(clientData, payload) {
    const { roomCode, username, ws } = clientData;

    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    // Mark this client as ready
    clientData.isReady = true;
    clientData.currentUrl = room.currentUrl; // Ensure URL is synced
    
    console.log(`[OpenSync Server] ${username} video is ready`);
    
    // Check if ALL clients are now ready
    let allReady = true;
    let readyCount = 0;
    let totalCount = 0;
    
    room.clients.forEach((client) => {
        totalCount++;
        if (client.isReady) {
            readyCount++;
        } else {
            allReady = false;
        }
    });
    
    console.log(`[OpenSync Server] Ready status: ${readyCount}/${totalCount}`);
    
    if (allReady && totalCount > 0) {
        // All clients are ready! Send ALL_READY to sync and play
        const syncTime = room.pendingSyncTime || 0;
        
        console.log(`[OpenSync Server] All ${totalCount} clients ready! Broadcasting ALL_READY at ${syncTime}s`);
        
        // Broadcast to ALL clients (including sender)
        room.clients.forEach((client) => {
            sendToClient(client.ws, 'ALL_READY', {
                currentTime: syncTime,
                participants: totalCount
            });
        });
        
        // Clear pending sync
        room.pendingSyncTime = null;
        room.pendingSyncUser = null;
    } else {
        // Notify all clients of loading progress
        room.clients.forEach((client) => {
            sendToClient(client.ws, 'WAITING_FOR_OTHERS', {
                ready: readyCount,
                total: totalCount
            });
        });
    }
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
