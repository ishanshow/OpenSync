// OpenSync Video Controller
// Handles video player detection and control

const OpenSyncVideoController = (function () {
    // Skip if already initialized in this frame
    if (window.OpenSyncVideoControllerInitialized) {
        return window.OpenSyncVideoController;
    }

    let videoElement = null;
    let isRemoteAction = false;
    let isBuffering = false;
    let expectedRemoteState = null; // 'playing', 'paused', or null (any)
    let remoteActionTimer = null;
    let eventCallbacks = {};
    let lastSeekTime = 0;
    let seekDebounceTimer = null;
    let retryCount = 0;
    let videoObserver = null;
    let currentPlatform = null; // Platform type: 'netflix', 'primevideo', 'hotstar'
    const SEEK_DEBOUNCE_MS = 300;
    const REMOTE_ACTION_WINDOW_MS = 1500; // Ignore local events for this long after remote command
    const SYNC_THRESHOLD = 2; // seconds difference to trigger resync
    const MAX_RETRIES = 30; // Try for up to 60 seconds
    const RETRY_INTERVAL = 2000;

    // Check if we're in the main frame or an iframe
    const isMainFrame = window === window.top;
    const frameInfo = isMainFrame ? 'main frame' : 'iframe';

    console.log(`[OpenSync] Video controller loading in ${frameInfo}`);

    // Find video element on the page, including inside Shadow DOM
    function findAllVideos(root) {
        let videos = [];
        if (root.querySelectorAll) {
            videos = Array.from(root.querySelectorAll('video'));
        }

        // Recursively check shadow roots
        const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of allElements) {
            if (el.shadowRoot) {
                videos = videos.concat(findAllVideos(el.shadowRoot));
            }
        }
        return videos;
    }

    function findVideoElement() {
        // If platform is set, use platform-specific finder
        if (currentPlatform && window.OpenSyncPlatformControllers) {
            const video = window.OpenSyncPlatformControllers.findVideoForPlatform(currentPlatform);
            if (video) {
                console.log(`[OpenSync] Found ${currentPlatform} video element in ${frameInfo}`);
                return video;
            }
        }

        // Fallback to generic detection
        // Find all videos including those in remote frames/shadow dom
        const videos = findAllVideos(document);

        for (const video of videos) {
            // Check if video has a source and is visible
            if (video.src || video.querySelector('source') || video.srcObject) {
                // Prefer videos that are actually visible and larger
                const rect = video.getBoundingClientRect();
                if (rect.width > 200 && rect.height > 100) {
                    console.log(`[OpenSync] Found video element in ${frameInfo} (${rect.width}x${rect.height})`);
                    return video;
                }
            }
        }

        // Return first video if any exist
        if (videos.length > 0) {
            console.log(`[OpenSync] Found video element in ${frameInfo} (fallback)`);
            return videos[0];
        }

        return null;
    }

    // Set up MutationObserver to detect dynamically added videos
    function setupVideoObserver(callbacks) {
        if (videoObserver) {
            videoObserver.disconnect();
        }

        videoObserver = new MutationObserver((mutations) => {
            // 1. Check if the current video was removed/detached
            if (videoElement && !videoElement.isConnected) {
                console.log('[OpenSync] Video element detached (SPA navigation?). Resetting...');
                removeEventListeners();
                videoElement = null;

                // Immediately look for a replacement that might already be there
                const fallback = findVideoElement();
                if (fallback) {
                    console.log('[OpenSync] Replacement video found immediately');
                    videoElement = fallback;
                    attachEventListeners();
                    notifyVideoFound();
                }
            }

            if (videoElement) return; // Still have a valid video

            // 2. Scan added nodes for new video
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const videos = findAllVideos(node);
                        for (const video of videos) {
                            const rect = video.getBoundingClientRect();
                            if (rect.width > 200 && rect.height > 100) {
                                console.log(`[OpenSync] Dynamic video found in ${frameInfo} (${rect.width}x${rect.height})`);
                                videoElement = video;
                                attachEventListeners();
                                notifyVideoFound();
                                return;
                            }
                        }
                    }
                }
            }


        });

        videoObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    }


    // Initialize video controller
    function init(callbacks = {}, platform = null) {
        eventCallbacks = callbacks;
        currentPlatform = platform;

        if (platform) {
            console.log(`[OpenSync] Initializing video controller for platform: ${platform}`);
            // Initialize platform-specific logic (e.g. inject bridge)
            if (window.OpenSyncPlatformControllers) {
                const config = window.OpenSyncPlatformControllers.getController(platform);
                if (config && config.init) {
                    config.init();
                }
            }
        }

        videoElement = findVideoElement();

        if (!videoElement) {
            console.log(`[OpenSync] No video element found in ${frameInfo}, will keep looking...`);

            // Set up observer for dynamically added videos
            if (document.body || document.documentElement) {
                setupVideoObserver(callbacks);
            }

            // Also retry periodically
            if (retryCount < MAX_RETRIES) {
                retryCount++;
                setTimeout(() => {
                    videoElement = findVideoElement();
                    if (videoElement) {
                        attachEventListeners();
                        notifyVideoFound();
                    }
                }, RETRY_INTERVAL);
            }
            return false;
        }

        attachEventListeners();
        notifyVideoFound();
        return true;
    }

    // Notify that video was found (for iframe communication)
    function notifyVideoFound() {
        console.log(`[OpenSync] Video ready in ${frameInfo}!`);

        // If we're in an iframe, notify the parent using cross-frame protocol
        if (!isMainFrame && window.parent) {
            try {
                const state = getState();
                window.parent.postMessage({
                    source: 'OPENSYNC_IFRAME',
                    type: 'VIDEO_FOUND',
                    frameId: window.location.href,
                    state: state
                }, '*');
                console.log('[OpenSync] Sent VIDEO_FOUND to parent frame');
            } catch (e) {
                console.warn('[OpenSync] Could not notify parent frame:', e);
            }
        }
    }

    // Send video event to parent frame (for cross-frame sync)
    function notifyParentOfEvent(eventType, state) {
        if (!isMainFrame && window.parent) {
            try {
                window.parent.postMessage({
                    source: 'OPENSYNC_IFRAME',
                    type: 'VIDEO_EVENT',
                    event: eventType,
                    state: state
                }, '*');
                console.log(`[OpenSync] Sent ${eventType} event to parent frame`);
            } catch (e) {
                // Cross-origin, that's fine
            }
        }
    }

    // Listen for control commands from parent frame (Global Mode)
    function setupParentMessageListener() {
        if (isMainFrame) return; // Only iframes listen for parent commands

        window.addEventListener('message', (event) => {
            // Only accept messages from parent
            if (event.source !== window.parent) return;
            if (event.data?.source !== 'OPENSYNC_MAIN') return;

            const { type, currentTime, isPlaying } = event.data;
            console.log(`[OpenSync] Received command from parent: ${type}`, currentTime);

            switch (type) {
                case 'PLAY':
                    if (currentTime !== undefined) {
                        const state = getState();
                        if (state && Math.abs(state.currentTime - currentTime) > 0.5) {
                            seek(currentTime);
                        }
                    }
                    play();
                    break;
                case 'PAUSE':
                    if (currentTime !== undefined) {
                        const state = getState();
                        if (state && Math.abs(state.currentTime - currentTime) > 0.5) {
                            seek(currentTime);
                        }
                    }
                    pause();
                    break;
                case 'SEEK':
                    seek(currentTime);
                    // Preserve play state after seek
                    if (isPlaying === true) {
                        setTimeout(() => play(), 300);
                    } else if (isPlaying === false) {
                        pause();
                    }
                    break;
                case 'GET_STATE':
                    const state = getState();
                    if (state) {
                        window.parent.postMessage({
                            source: 'OPENSYNC_IFRAME',
                            type: 'STATE_RESPONSE',
                            state: state
                        }, '*');
                    }
                    break;
                case 'SYNC':
                    if (event.data.state) {
                        syncToState(event.data.state);
                    }
                    break;
            }
        });

        console.log('[OpenSync] Parent message listener set up in iframe');
    }

    // Initialize parent listener for iframes
    if (!isMainFrame) {
        setupParentMessageListener();
    }

    // Re-detect video (useful when navigating)
    function redetect(platform = null) {
        if (videoElement) {
            removeEventListeners();
        }
        if (platform) {
            currentPlatform = platform;
        }
        retryCount = 0;
        return init(eventCallbacks, currentPlatform);
    }

    // Set platform (can be called to change platform after init)
    function setPlatform(platform) {
        currentPlatform = platform;
        console.log(`[OpenSync] Platform set to: ${platform}`);
        
        // Initialize platform-specific logic (e.g. inject bridge)
        if (platform && window.OpenSyncPlatformControllers) {
            const config = window.OpenSyncPlatformControllers.getController(platform);
            if (config && config.init) {
                console.log(`[OpenSync] Initializing ${platform} bridge...`);
                config.init();
            }
        }
    }

    // Get current platform
    function getPlatform() {
        return currentPlatform;
    }

    // Attach event listeners to video element
    function attachEventListeners() {
        if (!videoElement) return;

        videoElement.addEventListener('play', handlePlay);
        videoElement.addEventListener('pause', handlePause);
        videoElement.addEventListener('seeked', handleSeeked);
        videoElement.addEventListener('waiting', handleBuffering);
        videoElement.addEventListener('playing', handlePlaying);
        videoElement.addEventListener('timeupdate', handleTimeUpdate);

        console.log(`[OpenSync] Video event listeners attached in ${frameInfo}`);
    }

    // Remove event listeners
    function removeEventListeners() {
        if (!videoElement) return;

        videoElement.removeEventListener('play', handlePlay);
        videoElement.removeEventListener('pause', handlePause);
        videoElement.removeEventListener('seeked', handleSeeked);
        videoElement.removeEventListener('waiting', handleBuffering);
        videoElement.removeEventListener('playing', handlePlaying);
        videoElement.removeEventListener('timeupdate', handleTimeUpdate);
    }

    // Event handlers
    function handlePlay() {
        if (isRemoteAction) {
            // If we explicitly expected a PAUSE but got a PLAY, treat it as user action override
            if (expectedRemoteState === 'paused') {
                console.log('[OpenSync] Allowing PLAY (override: expected paused)');
            } else {
                console.log('[OpenSync] Ignoring PLAY (remote action)');
                return;
            }
        }

        console.log(`[OpenSync] Local PLAY at ${videoElement.currentTime.toFixed(2)}s in ${frameInfo}`);
        const state = getState();
        
        // Notify parent frame (for Global Mode cross-frame sync)
        if (!isMainFrame) {
            notifyParentOfEvent('play', state);
        }
        
        if (eventCallbacks.onPlay) {
            eventCallbacks.onPlay(state);
        }
    }

    function handlePause() {
        if (isRemoteAction) {
            // If we explicitly expected a PLAY but got a PAUSE, treat it as user action override
            if (expectedRemoteState === 'playing') {
                console.log('[OpenSync] Allowing PAUSE (override: expected playing)');
            } else {
                console.log('[OpenSync] Ignoring PAUSE (remote action)');
                return;
            }
        }

        console.log(`[OpenSync] Local PAUSE at ${videoElement.currentTime.toFixed(2)}s in ${frameInfo}`);
        const state = getState();
        
        // Notify parent frame (for Global Mode cross-frame sync)
        if (!isMainFrame) {
            notifyParentOfEvent('pause', state);
        }
        
        if (eventCallbacks.onPause) {
            eventCallbacks.onPause(state);
        }
    }

    function handleSeeked() {
        if (isRemoteAction) {
            console.log('[OpenSync] Ignoring SEEK (remote action)');
            return;
        }

        // Capture state IMMEDIATELY to preserve intent
        const cursorTime = videoElement.currentTime;
        const wasPlaying = !videoElement.paused;

        // Debounce seek events
        clearTimeout(seekDebounceTimer);

        seekDebounceTimer = setTimeout(() => {
            if (Math.abs(cursorTime - lastSeekTime) > 0.5) {
                lastSeekTime = cursorTime;
                console.log(`[OpenSync] Local SEEK to ${cursorTime.toFixed(2)}s in ${frameInfo} (isPlaying: ${wasPlaying})`);
                
                // Manually construct state with captured isPlaying
                const state = getState();
                if (state) {
                    state.isPlaying = wasPlaying; // Override with captured truth
                    
                    // Notify parent frame (for Global Mode cross-frame sync)
                    if (!isMainFrame) {
                        notifyParentOfEvent('seek', state);
                    }
                    
                    if (eventCallbacks.onSeek) {
                        eventCallbacks.onSeek(state);
                    }
                }
            }
        }, SEEK_DEBOUNCE_MS);
    }

    function handleBuffering() {
        isBuffering = true;

        // If we are buffering during a remote action, pause the timer so we don't expire
        // and think the subsequent 'playing' event is a local user action.
        if (isRemoteAction) {
            console.log('[OpenSync] Buffering during remote action - pausing lock timer');
            if (remoteActionTimer) clearTimeout(remoteActionTimer);
            remoteActionTimer = null;
        }

        if (eventCallbacks.onBuffer) {
            eventCallbacks.onBuffer(getState());
        }
    }

    function handlePlaying() {
        if (isBuffering) {
            isBuffering = false;

            // If we were buffering during a remote action, resume the timer now
            if (isRemoteAction) {
                console.log('[OpenSync] Buffering finished - resuming lock timer');
                // Restart timer to ensure we cover the transition
                setRemoteAction(expectedRemoteState);
                return; // Do NOT emit onPlaying
            }
        }

        if (eventCallbacks.onPlaying) {
            eventCallbacks.onPlaying(getState());
        }
    }

    // Periodic time update for continuous sync
    let lastReportedTime = 0;
    function handleTimeUpdate() {
        if (!videoElement) return;

        // Only report significant time changes (every 5 seconds)
        const currentTime = Math.floor(videoElement.currentTime / 5) * 5;
        if (currentTime !== lastReportedTime && !videoElement.paused) {
            lastReportedTime = currentTime;
            // Could be used for periodic sync verification
        }
    }

    // Get current video state
    function getState() {
        // First, try to refresh video element reference for platforms that may swap videos
        if (currentPlatform && (currentPlatform === 'primevideo' || currentPlatform === 'hotstar' || currentPlatform === 'netflix')) {
            const freshVideo = findVideoElement();
            if (freshVideo && freshVideo !== videoElement) {
                console.log('[OpenSync] Video element changed, updating reference');
                if (videoElement) removeEventListeners();
                videoElement = freshVideo;
                attachEventListeners();
            }
        }

        if (!videoElement) return null;

        // Verify the video element is still connected to DOM
        if (!videoElement.isConnected) {
            console.warn('[OpenSync] Video element is detached, trying to find new one');
            const freshVideo = findVideoElement();
            if (freshVideo) {
                videoElement = freshVideo;
                attachEventListeners();
            } else {
                return null;
            }
        }

        // For Prime Video and Hotstar, double-check we have the main video
        // by looking for a video with significant duration and currentTime
        if (currentPlatform === 'primevideo' || currentPlatform === 'hotstar') {
            const allVideos = document.querySelectorAll('video');
            for (const v of allVideos) {
                // Find a video that's actually playing content (not ads/previews)
                if (v.duration > 60 && v.currentTime > 0 && v.src) {
                    if (v !== videoElement) {
                        console.log('[OpenSync] Found better video element (duration:', v.duration, 'currentTime:', v.currentTime, ')');
                        if (videoElement) removeEventListeners();
                        videoElement = v;
                        attachEventListeners();
                    }
                    break;
                }
            }
        }

        const state = {
            currentTime: videoElement.currentTime,
            duration: videoElement.duration,
            isPlaying: !videoElement.paused,
            playbackRate: videoElement.playbackRate,
            buffered: getBufferedRange(),
            volume: videoElement.volume,
            muted: videoElement.muted
        };

        console.log('[OpenSync] getState:', state.currentTime.toFixed(2), 'playing:', state.isPlaying, 'duration:', state.duration?.toFixed(0));
        
        return state;
    }

    // Get buffered range
    function getBufferedRange() {
        if (!videoElement || !videoElement.buffered.length) return 0;
        return videoElement.buffered.end(videoElement.buffered.length - 1);
    }

    // Control functions (for remote commands)
    function setRemoteAction(expectedState = null) {
        isRemoteAction = true;
        expectedRemoteState = expectedState;
        if (remoteActionTimer) clearTimeout(remoteActionTimer);
        remoteActionTimer = setTimeout(() => {
            // Verify state before releasing lock
            if (expectedRemoteState === 'playing' && videoElement.paused) {
                console.log('[OpenSync] Remote action watchdog: Video failed to play! Forcing retry...');
                videoElement.play().catch(e => console.warn('[OpenSync] Watchdog retry failed:', e));
            } else if (expectedRemoteState === 'paused' && !videoElement.paused) {
                console.log('[OpenSync] Remote action watchdog: Video failed to pause! Forcing retry...');
                videoElement.pause();
            }

            isRemoteAction = false;
            expectedRemoteState = null;
            remoteActionTimer = null;
        }, REMOTE_ACTION_WINDOW_MS);
    }

    function play() {
        // Check for platform override
        if (currentPlatform && window.OpenSyncPlatformControllers) {
            const config = window.OpenSyncPlatformControllers.getController(currentPlatform);
            if (config && config.controls && config.controls.play) {
                setRemoteAction('playing');
                console.log(`[OpenSync] Remote PLAY using ${currentPlatform} controller`);
                config.controls.play();
                return true;
            }
        }

        if (!videoElement) {
            console.warn('[OpenSync] Cannot play: no video element');
            return false;
        }
        setRemoteAction('playing');
        console.log(`[OpenSync] Remote PLAY command in ${frameInfo}`);
        videoElement.play().catch((e) => {
            console.error('[OpenSync] Play failed:', e);
            // If play fails, we might not get events, but timeout will clear flag
        });
        return true;
    }

    function pause() {
        // Check for platform override
        if (currentPlatform && window.OpenSyncPlatformControllers) {
            const config = window.OpenSyncPlatformControllers.getController(currentPlatform);
            if (config && config.controls && config.controls.pause) {
                setRemoteAction('paused');
                console.log(`[OpenSync] Remote PAUSE using ${currentPlatform} controller`);
                config.controls.pause();
                return true;
            }
        }

        if (!videoElement) {
            console.warn('[OpenSync] Cannot pause: no video element');
            return false;
        }
        setRemoteAction('paused');
        console.log(`[OpenSync] Remote PAUSE command in ${frameInfo}`);
        videoElement.pause();
        return true;
    }

    function seek(time) {
        // Check for platform override
        if (currentPlatform && window.OpenSyncPlatformControllers) {
            const config = window.OpenSyncPlatformControllers.getController(currentPlatform);
            if (config && config.controls && config.controls.seek) {
                setRemoteAction();
                lastSeekTime = time;
                console.log(`[OpenSync] Remote SEEK to ${time.toFixed(2)}s using ${currentPlatform} controller`);
                config.controls.seek(time);
                return true;
            }
        }

        if (!videoElement) {
            console.warn('[OpenSync] Cannot seek: no video element');
            return false;
        }
        setRemoteAction();
        lastSeekTime = time;
        console.log(`[OpenSync] Remote SEEK to ${time.toFixed(2)}s in ${frameInfo}`);
        videoElement.currentTime = time;
        return true;
    }

    function setPlaybackRate(rate) {
        if (!videoElement) return false;
        videoElement.playbackRate = rate;
        return true;
    }

    // Sync to a remote state
    function syncToState(remoteState) {
        if (!videoElement || !remoteState) {
            console.warn('[OpenSync] Cannot sync: no video element or state');
            return false;
        }

        const localState = getState();
        if (!localState) return false;

        console.log(`[OpenSync] Syncing to remote state: time=${remoteState.currentTime?.toFixed(2)}s, playing=${remoteState.isPlaying}`);

        // Check if we need to sync time
        const timeDiff = Math.abs(localState.currentTime - remoteState.currentTime);

        if (timeDiff > SYNC_THRESHOLD) {
            seek(remoteState.currentTime);
        }

        // Sync play/pause state
        if (remoteState.isPlaying && videoElement.paused) {
            play();
        } else if (!remoteState.isPlaying && !videoElement.paused) {
            pause();
        }

        // Sync playback rate
        if (remoteState.playbackRate && remoteState.playbackRate !== videoElement.playbackRate) {
            setPlaybackRate(remoteState.playbackRate);
        }

        return true;
    }

    // Check if video is available
    function isAvailable() {
        return videoElement !== null;
    }

    // Cleanup
    function destroy() {
        removeEventListeners();
        if (videoObserver) {
            videoObserver.disconnect();
            videoObserver = null;
        }
        videoElement = null;
        eventCallbacks = {};
    }

    // Mark as initialized
    window.OpenSyncVideoControllerInitialized = true;

    const controller = {
        init,
        redetect,
        getState,
        play,
        pause,
        seek,
        setPlaybackRate,
        syncToState,
        isAvailable,
        destroy,
        setPlatform,
        getPlatform
    };

    return controller;
})();

// Make available globally
window.OpenSyncVideoController = OpenSyncVideoController;
