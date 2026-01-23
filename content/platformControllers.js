// OpenSync Platform Controllers
// Platform-specific video detection and control logic for Netflix, Prime Video, and Hotstar

const OpenSyncPlatformControllers = (function () {
    'use strict';

    // Platform configurations with selectors and quirks
    const platforms = {
        netflix: {
            name: 'Netflix',
            hostnames: ['netflix.com', 'www.netflix.com'],
            videoSelectors: [
                '.watch-video--player-view video',
                'video.VideoPlayer',
                '.NFPlayer video',
                'video[src*="nflxvideo"]',
                'video'
            ],
            // Netflix uses shadow DOM in some cases
            useShadowDOM: true,
            // Netflix quirks: may need to wait for video to be "active"
            quirks: {
                waitForReady: true,
                minDuration: 30 // Only consider videos longer than 30s
            },
            // Netflix Bridge Control
            controls: {
                play: () => sendBridgeCommand('PLAY'),
                pause: () => sendBridgeCommand('PAUSE'),
                seek: (time) => sendBridgeCommand('SEEK', { time })
            },
            init: () => {
                injectInlineScript(`
                    // OpenSync Netflix Player Bridge (Inline)
                    try {
                        console.log('[OpenSync Bridge] Initializing Netflix Player Bridge...');
                        function getNetflixPlayer() {
                            try {
                                const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
                                const sessionId = videoPlayer?.getAllPlayerSessionIds()[0];
                                return videoPlayer?.getVideoPlayerBySessionId(sessionId);
                            } catch (e) { return null; }
                        }
                        
                        window.addEventListener('message', function(event) {
                            if (event.source !== window || event.data.source !== 'OPENSYNC_CONTENT') return;
                            const player = getNetflixPlayer();
                            if (!player) return;
                            
                            const { type, payload } = event.data;
                            try {
                                switch (type) {
                                    case 'SEEK': player.seek(payload.time * 1000); break;
                                    case 'PLAY': player.play(); break;
                                    case 'PAUSE': player.pause(); break;
                                }
                            } catch (e) { console.error('[OpenSync Bridge] Error:', e); }
                        });
                        console.log('[OpenSync Bridge] Ready');
                        window.postMessage({ source: 'OPENSYNC_BRIDGE', type: 'READY' }, '*');
                    } catch(e) { console.error('[OpenSync Bridge] Init failed:', e); }
                `);
            }
        },

        primevideo: {
            name: 'Prime Video',
            hostnames: ['primevideo.com', 'www.primevideo.com', 'amazon.com', 'www.amazon.com'],
            videoSelectors: [
                '.webPlayerSDKContainer video',
                '#dv-web-player video',
                '.rendererContainer video',
                '.atvwebplayersdk-overlays-container ~ div video',
                '[data-testid="webPlayer"] video',
                '.atvwebplayersdk-player-container video',
                '.webPlayerUIContainer video',
                'video[src*="primevideo"]',
                'video[src*="amazon"]',
                'video[src*="aiv-cdn"]',
                'video'
            ],
            useShadowDOM: true,
            quirks: {
                waitForReady: true,
                checkVisibility: true
            },
            // Prime Video Bridge Control
            controls: {
                play: () => sendBridgeCommand('PLAY'),
                pause: () => sendBridgeCommand('PAUSE'),
                seek: (time) => sendBridgeCommand('SEEK', { time })
            },
            init: () => {
                injectInlineScript(`
                    // OpenSync Prime Video Player Bridge (Inline)
                    try {
                        console.log('[OpenSync Bridge] Initializing Prime Video Player Bridge...');
                        
                        function getMainVideoElement() {
                            // Find the main content video (not ads/previews)
                            // Priority: video with longest duration and has been playing
                            const allVideos = document.querySelectorAll('video');
                            let bestVideo = null;
                            let bestScore = 0;
                            
                            for (const v of allVideos) {
                                // Calculate a score based on:
                                // - Has a source
                                // - Duration (longer = more likely to be main content)
                                // - Size on screen
                                // - Is visible
                                let score = 0;
                                
                                if (v.src || v.srcObject) score += 10;
                                if (v.duration > 60) score += 30;  // Likely main content
                                if (v.duration > 300) score += 20; // Even more likely (5+ mins)
                                if (v.currentTime > 0) score += 10; // Has been played
                                
                                const rect = v.getBoundingClientRect();
                                if (rect.width > 400 && rect.height > 200) score += 20; // Large video
                                if (rect.width > 800) score += 10; // Very large
                                
                                // Check if visible
                                if (rect.top < window.innerHeight && rect.bottom > 0) score += 5;
                                
                                if (score > bestScore) {
                                    bestScore = score;
                                    bestVideo = v;
                                }
                            }
                            
                            if (bestVideo) {
                                console.log('[OpenSync Bridge] Selected video with score', bestScore, 
                                    'duration:', bestVideo.duration?.toFixed(0), 
                                    'currentTime:', bestVideo.currentTime?.toFixed(2));
                            }
                            
                            return bestVideo || document.querySelector('video');
                        }
                        
                        window.addEventListener('message', function(event) {
                            if (event.source !== window || event.data.source !== 'OPENSYNC_CONTENT') return;
                            
                            const { type, payload } = event.data;
                            const video = getMainVideoElement();
                            
                            if (!video) {
                                console.warn('[OpenSync Bridge] No video element found');
                                return;
                            }
                            
                            try {
                                switch (type) {
                                    case 'SEEK':
                                        console.log('[OpenSync Bridge] Seeking to', payload.time, '(from', video.currentTime.toFixed(2), ')');
                                        video.currentTime = payload.time;
                                        break;
                                    case 'PLAY':
                                        console.log('[OpenSync Bridge] Playing at', video.currentTime.toFixed(2));
                                        video.play().catch(e => console.warn('[OpenSync Bridge] Play failed:', e));
                                        break;
                                    case 'PAUSE':
                                        console.log('[OpenSync Bridge] Pausing at', video.currentTime.toFixed(2));
                                        video.pause();
                                        break;
                                    case 'GET_STATE':
                                        // Return current state for sync verification
                                        window.postMessage({
                                            source: 'OPENSYNC_BRIDGE',
                                            type: 'STATE',
                                            payload: {
                                                currentTime: video.currentTime,
                                                duration: video.duration,
                                                paused: video.paused
                                            }
                                        }, '*');
                                        break;
                                }
                            } catch (e) { 
                                console.error('[OpenSync Bridge] Command error:', e); 
                            }
                        });
                        
                        console.log('[OpenSync Bridge] Prime Video Bridge Ready');
                        window.postMessage({ source: 'OPENSYNC_BRIDGE', type: 'READY', platform: 'primevideo' }, '*');
                    } catch(e) { 
                        console.error('[OpenSync Bridge] Prime Video Init failed:', e); 
                    }
                `);
            }
        },

        youtube: {
            name: 'YouTube',
            hostnames: ['youtube.com', 'www.youtube.com', 'youtu.be'],
            videoSelectors: [
                'video.html5-main-video',
                'video'
            ],
            useShadowDOM: false,
            quirks: {
                waitForReady: true,
                minDuration: 5 // Skip very short clips/ads if possible
            }
        },

        hotstar: {
            name: 'Disney+ Hotstar',
            hostnames: ['hotstar.com', 'www.hotstar.com'],
            videoSelectors: [
                '.player-base video',
                '.shaka-video-container video',
                '.bmpui-ui-videocontainer video',
                '#bitmovinplayer-video-player video',
                '.bmpui-container video',
                '.player-container video',
                'video[src]',
                'video'
            ],
            useShadowDOM: false,
            quirks: {
                waitForReady: true,
                checkVisibility: true
            },
            // Hotstar Bridge Control
            controls: {
                play: () => sendBridgeCommand('PLAY'),
                pause: () => sendBridgeCommand('PAUSE'),
                seek: (time) => sendBridgeCommand('SEEK', { time })
            },
            init: () => {
                injectInlineScript(`
                    // OpenSync Hotstar Player Bridge (Inline)
                    try {
                        console.log('[OpenSync Bridge] Initializing Hotstar Player Bridge...');
                        
                        function getMainVideoElement() {
                            // Find the main content video (not ads/previews)
                            const allVideos = document.querySelectorAll('video');
                            let bestVideo = null;
                            let bestScore = 0;
                            
                            for (const v of allVideos) {
                                let score = 0;
                                
                                if (v.src || v.srcObject) score += 10;
                                if (v.duration > 60) score += 30;
                                if (v.duration > 300) score += 20;
                                if (v.currentTime > 0) score += 10;
                                
                                const rect = v.getBoundingClientRect();
                                if (rect.width > 400 && rect.height > 200) score += 20;
                                if (rect.width > 800) score += 10;
                                if (rect.top < window.innerHeight && rect.bottom > 0) score += 5;
                                
                                if (score > bestScore) {
                                    bestScore = score;
                                    bestVideo = v;
                                }
                            }
                            
                            if (bestVideo) {
                                console.log('[OpenSync Bridge] Selected video with score', bestScore,
                                    'duration:', bestVideo.duration?.toFixed(0),
                                    'currentTime:', bestVideo.currentTime?.toFixed(2));
                            }
                            
                            return bestVideo || document.querySelector('video');
                        }
                        
                        // Try to get Bitmovin player API if available
                        function getBitmovinPlayer() {
                            try {
                                if (window.bitmovin && window.bitmovin.player) {
                                    const players = window.bitmovin.player.Player.getPlayers();
                                    if (players && players.length > 0) {
                                        return players[0];
                                    }
                                }
                            } catch (e) {}
                            return null;
                        }
                        
                        window.addEventListener('message', function(event) {
                            if (event.source !== window || event.data.source !== 'OPENSYNC_CONTENT') return;
                            
                            const { type, payload } = event.data;
                            const video = getMainVideoElement();
                            const bitmovinPlayer = getBitmovinPlayer();
                            
                            if (!video && !bitmovinPlayer) {
                                console.warn('[OpenSync Bridge] No video/player found');
                                return;
                            }
                            
                            try {
                                switch (type) {
                                    case 'SEEK':
                                        console.log('[OpenSync Bridge] Seeking to', payload.time, '(from', video?.currentTime?.toFixed(2), ')');
                                        if (bitmovinPlayer) {
                                            bitmovinPlayer.seek(payload.time);
                                        } else if (video) {
                                            video.currentTime = payload.time;
                                        }
                                        break;
                                    case 'PLAY':
                                        console.log('[OpenSync Bridge] Playing at', video?.currentTime?.toFixed(2));
                                        if (bitmovinPlayer) {
                                            bitmovinPlayer.play();
                                        } else if (video) {
                                            video.play().catch(e => console.warn('[OpenSync Bridge] Play failed:', e));
                                        }
                                        break;
                                    case 'PAUSE':
                                        console.log('[OpenSync Bridge] Pausing at', video?.currentTime?.toFixed(2));
                                        if (bitmovinPlayer) {
                                            bitmovinPlayer.pause();
                                        } else if (video) {
                                            video.pause();
                                        }
                                        break;
                                    case 'GET_STATE':
                                        const v = video || (bitmovinPlayer ? { 
                                            currentTime: bitmovinPlayer.getCurrentTime(), 
                                            duration: bitmovinPlayer.getDuration(),
                                            paused: bitmovinPlayer.isPaused()
                                        } : null);
                                        if (v) {
                                            window.postMessage({
                                                source: 'OPENSYNC_BRIDGE',
                                                type: 'STATE',
                                                payload: {
                                                    currentTime: v.currentTime,
                                                    duration: v.duration,
                                                    paused: v.paused
                                                }
                                            }, '*');
                                        }
                                        break;
                                }
                            } catch (e) { 
                                console.error('[OpenSync Bridge] Command error:', e); 
                            }
                        });
                        
                        console.log('[OpenSync Bridge] Hotstar Bridge Ready');
                        window.postMessage({ source: 'OPENSYNC_BRIDGE', type: 'READY', platform: 'hotstar' }, '*');
                    } catch(e) { 
                        console.error('[OpenSync Bridge] Hotstar Init failed:', e); 
                    }
                `);
            }
        }
    };

    // Find video using platform-specific selectors
    function findVideoForPlatform(platform) {
        const config = platforms[platform];
        if (!config) {
            console.warn('[OpenSync] Unknown platform:', platform);
            return findGenericVideo();
        }

        console.log(`[OpenSync] Finding video for ${config.name}...`);

        let bestVideo = null;
        let bestScore = 0;
        let bestSelector = null;

        // Try each selector and score all matching videos
        for (const selector of config.videoSelectors) {
            // First try regular DOM
            let videos = Array.from(document.querySelectorAll(selector));

            // Also search in shadow DOMs if enabled
            if (config.useShadowDOM) {
                videos = [...videos, ...findVideosInShadowDOM(selector)];
            }

            for (const video of videos) {
                const score = scoreVideo(video, config.quirks);
                if (score > bestScore) {
                    bestScore = score;
                    bestVideo = video;
                    bestSelector = selector;
                }
            }
        }

        if (bestVideo) {
            console.log(`[OpenSync] Found ${config.name} video with selector: ${bestSelector}, score: ${bestScore}, duration: ${bestVideo.duration?.toFixed(0)}, currentTime: ${bestVideo.currentTime?.toFixed(2)}`);
            return bestVideo;
        }

        console.log(`[OpenSync] No valid video found for ${config.name}, falling back to generic`);
        return findGenericVideo();
    }

    // Search for videos inside shadow DOMs
    function findVideosInShadowDOM(selector) {
        const videos = [];
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
            if (el.shadowRoot) {
                try {
                    const shadowVideos = el.shadowRoot.querySelectorAll(selector);
                    videos.push(...shadowVideos);

                    // Recursive shadow root search
                    const nestedElements = el.shadowRoot.querySelectorAll('*');
                    for (const nested of nestedElements) {
                        if (nested.shadowRoot) {
                            const nestedVideos = nested.shadowRoot.querySelectorAll(selector);
                            videos.push(...nestedVideos);
                        }
                    }
                } catch (e) {
                    // Access denied to shadow root
                }
            }
        }

        return videos;
    }

    // Calculate a score for how likely this video is the main content
    function scoreVideo(video, quirks = {}) {
        if (!video) return -1;

        let score = 0;

        // Check if video has a source
        if (video.src || video.srcObject) {
            score += 10;
        } else if (video.querySelector && video.querySelector('source')) {
            score += 5;
        } else {
            return -1; // No source, not valid
        }

        // Check visibility
        try {
            const rect = video.getBoundingClientRect();
            if (rect.width > 400 && rect.height > 200) score += 20;
            if (rect.width > 800) score += 10;
            if (rect.top < window.innerHeight && rect.bottom > 0) score += 5;
            
            // Penalize very small videos (likely ads/previews)
            if (rect.width < 200 || rect.height < 100) {
                if (quirks.checkVisibility) return -1;
                score -= 20;
            }
        } catch (e) {}

        // Check duration - main content is usually longer
        if (video.duration && !isNaN(video.duration)) {
            if (video.duration > 300) score += 30;  // 5+ minutes
            else if (video.duration > 60) score += 20;  // 1+ minute
            else if (video.duration < 30 && quirks.minDuration > video.duration) {
                return -1; // Too short
            }
        }

        // Video that has been played is likely the one user cares about
        if (video.currentTime > 0) score += 15;
        
        // Check if video is ready
        if (quirks.waitForReady && video.readyState < 1) {
            score -= 10;
        }

        return score;
    }

    // Validate if video element is suitable for sync (wrapper for backwards compat)
    function isValidVideo(video, quirks = {}) {
        return scoreVideo(video, quirks) > 0;
    }

    // Generic video finder (fallback)
    function findGenericVideo() {
        const videos = document.querySelectorAll('video');
        let bestVideo = null;
        let bestScore = 0;

        for (const video of videos) {
            const score = scoreVideo(video, { checkVisibility: true });
            if (score > bestScore) {
                bestScore = score;
                bestVideo = video;
            }
        }

        if (bestVideo) {
            console.log(`[OpenSync] Found generic video, score: ${bestScore}, duration: ${bestVideo.duration?.toFixed(0)}, currentTime: ${bestVideo.currentTime?.toFixed(2)}`);
            return bestVideo;
        }

        return videos[0] || null;
    }

    // Detect platform from current URL
    function detectPlatform() {
        const hostname = window.location.hostname.toLowerCase();

        for (const [key, config] of Object.entries(platforms)) {
            if (config.hostnames.some(h => hostname.includes(h.replace('www.', '')))) {
                console.log(`[OpenSync] Auto-detected platform: ${config.name}`);
                return key;
            }
        }

        return null;
    }

    // Get platform config
    function getPlatformConfig(platform) {
        return platforms[platform] || null;
    }

    // Get platform display name
    function getPlatformName(platform) {
        return platforms[platform]?.name || 'Unknown';
    }

    // Check if current site matches selected platform
    function isOnCorrectPlatform(platform) {
        const config = platforms[platform];
        if (!config) return true; // Unknown platform, allow

        const hostname = window.location.hostname.toLowerCase();
        return config.hostnames.some(h => hostname.includes(h.replace('www.', '')));
    }

    return {
        findVideoForPlatform,
        detectPlatform,
        getPlatformConfig,
        getPlatformName,
        isOnCorrectPlatform,
        getController,
        platforms
    };

    // --- Helpers for Bridge Communication ---

    // Get controller for platform
    function getController(platform) {
        return platforms[platform];
    }

    // Inject a script into the page context (Inline fallback for Firefox)
    function injectInlineScript(code) {
        const script = document.createElement('script');
        script.textContent = code;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
        console.log(`[OpenSync] Injected inline bridge`);
    }

    // Inject a script into the page context (File based - kept for reference)
    function injectScript(path) {
        try {
            const script = document.createElement('script');
            script.src = browser.runtime.getURL(path);
            script.onload = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
            console.log(`[OpenSync] Injected ${path}`);
        } catch (e) {
            console.error('[OpenSync] Injection failed:', e);
        }
    }

    // Send command to the page-level bridge
    function sendBridgeCommand(type, payload = {}) {
        window.postMessage({
            source: 'OPENSYNC_CONTENT',
            type,
            payload
        }, '*');
    }
})();

// Make available globally
window.OpenSyncPlatformControllers = OpenSyncPlatformControllers;
