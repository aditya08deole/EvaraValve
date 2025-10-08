/************************************************************************
 * EvaraTap Server v7.0 - Professional Refactor
 *
 * A robust Node.js backend for monitoring a Blynk IoT device.
 * Features intelligent polling, WebSocket-based real-time updates for
 * a web dashboard, and an API for sending commands to the device.
 *
 * @author Gemini AI (Refactored for Professional Structure)
 * @version 7.0
 ************************************************************************/

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

// --- UTILITIES (Simple Logger for Clarity) ---
const logger = {
    info: (message) => console.log(`[INFO] ${message}`),
    error: (message) => console.error(`\x1b[31m[ERROR] ${message}\x1b[0m`),
    success: (message) => console.log(`\x1b[32m[SUCCESS] ${message}\x1b[0m`),
    warn: (message) => console.log(`\x1b[33m[WARN] ${message}\x1b[0m`),
};

// --- CONFIGURATION ---
const CONFIG = {
    PORT: process.env.PORT || 10000,
    BLYNK_AUTH_TOKEN: process.env.BLYNK_AUTH_TOKEN || "1NJUV0rE2TjnZxbTb89-tA0XmwGwZGCn",
    BLYNK_API_BASE: 'https://blynk.cloud/external/api',
    POLLING_RATE_ONLINE_MS: 1500,     // 1.5 seconds when device is online
    POLLING_RATE_OFFLINE_MS: 15*60*1000,   // 15 min when device is offline
    POLLING_RATE_ACTIVE_CHECK_MS: 5000, // 5 seconds during manual reconnect attempt
    ACTIVE_CHECK_DURATION_MS: 30000,  // Window for active check (30 seconds)
    OFFLINE_GRACE_PERIOD_MS: 25000,    // Mark offline if no fresh data for 25 seconds
    API_TIMEOUT_MS: 4000,             // Timeout for Blynk API calls
    VIRTUAL_PINS_TO_POLL: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'],
};

// --- APPLICATION STATE ---
const state = {
    deviceDataCache: {},
    lastUptimeValue: -1,
    lastFreshDataTimestamp: 0,
    isDeviceOnline: false,
    isActivelyChecking: false,
    pollTimeoutId: null,
    activeCheckTimeoutId: null,
    forcePollCooldownUntil: 0,
};

// --- BLYNK API SERVICE ---
const BlynkService = {
    /**
     * Fetches the latest data for all monitored virtual pins from the Blynk API.
     * @returns {Promise<object>} A promise that resolves with the pin data.
     */
    async pollPinData() {
        const pinParams = CONFIG.VIRTUAL_PINS_TO_POLL.map(pin => `pin=${pin}`).join('&');
        const url = `${CONFIG.BLYNK_API_BASE}/get?token=${CONFIG.BLYNK_AUTH_TOKEN}&${pinParams}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`Blynk API responded with status ${response.status}`);
            }
            return await response.json();
        } finally {
            clearTimeout(timeoutId);
        }
    },

    /**
     * Sends an update command to a specific virtual pin.
     * @param {string} pin The virtual pin to update (e.g., 'v1').
     * @param {string|number} value The value to set.
     */
    async updatePin(pin, value) {
        const url = `${CONFIG.BLYNK_API_BASE}/update?token=${CONFIG.BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        const response = await fetch(url, { timeout: 5000 });
        if (!response.ok) {
            throw new Error(`Blynk API returned status ${response.status} for update`);
        }
        logger.success(`Command sent: Set ${pin} to ${value}`);
    }
};

// --- WEBSOCKET MANAGER ---
let wss; // Will be initialized in main()
const WebSocketManager = {
    /**
     * Initializes the WebSocket server.
     * @param {object} server The HTTP server instance.
     */
    initialize(server) {
        wss = new WebSocketServer({ server });
        wss.on('connection', this.handleConnection);
        logger.success('WebSocket server initialized.');
    },

    /**
     * Handles new client connections, message listeners, and cleanup.
     * @param {WebSocket} ws The WebSocket instance for the connected client.
     * @param {object} req The initial HTTP request.
     */
    handleConnection(ws, req) {
        const clientIp = req.socket.remoteAddress;
        logger.info(`Client connected from ${clientIp}. Total clients: ${wss.clients.size}`);

        // Send the current state immediately on connection
        ws.send(JSON.stringify({
            type: 'initial-state',
            payload: state.deviceDataCache,
            isOnline: state.isDeviceOnline,
        }));

        ws.on('message', (message) => WebSocketManager.handleMessage(message));
        ws.on('close', () => logger.info(`Client disconnected from ${clientIp}. Total clients: ${wss.clients.size}`));
        ws.on('error', (err) => logger.error(`WebSocket error from ${clientIp}: ${err.message}`));
    },
    
    /**
     * Handles incoming messages from clients.
     * @param {string} message The raw message from the client.
     */
    handleMessage(message) {
        try {
            const data = JSON.parse(message);
            if (data.type === 'force-poll') {
                triggerActiveCheck();
            }
        } catch (e) {
            logger.warn(`Invalid WebSocket message received: ${message}`);
        }
    },
    
    /**
     * Broadcasts a message to all connected WebSocket clients.
     * @param {object} messageObject The data to be sent.
     */
    broadcast(messageObject) {
        if (!wss) return;
        const message = JSON.stringify(messageObject);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    }
};


// --- CORE POLLING LOGIC ---

/**
 * Determines the delay for the next polling cycle based on the current state.
 * @returns {number} The polling interval in milliseconds.
 */
function getNextPollRate() {
    if (state.isDeviceOnline) return CONFIG.POLLING_RATE_ONLINE_MS;
    if (state.isActivelyChecking) return CONFIG.POLLING_RATE_ACTIVE_CHECK_MS;
    return CONFIG.POLLING_RATE_OFFLINE_MS;
}

/**
 * The main polling loop that fetches data, updates state, and broadcasts to clients.
 */
async function runPollingCycle() {
    clearTimeout(state.pollTimeoutId);
    let isDataFresh = false;

    try {
        const newData = await BlynkService.pollPinData();
        const currentUptime = parseInt(newData.v5) || 0;

        // Uptime changed means the device is alive and sent new data
        if (currentUptime > 0 && currentUptime !== state.lastUptimeValue) {
            if (!state.isDeviceOnline) {
                logger.success(`Device came ONLINE. (Uptime: ${currentUptime}s)`);
                state.isDeviceOnline = true;
                state.isActivelyChecking = false; // Stop active checking once online
                clearTimeout(state.activeCheckTimeoutId);
            }
            state.lastFreshDataTimestamp = Date.now();
            state.lastUptimeValue = currentUptime;
            isDataFresh = true;
        } else {
            // If device was online but grace period has passed, mark it offline
            const timeSinceFreshData = Date.now() - state.lastFreshDataTimestamp;
            if (state.isDeviceOnline && timeSinceFreshData > CONFIG.OFFLINE_GRACE_PERIOD_MS) {
                logger.warn('Device went OFFLINE. (Grace period expired)');
                state.isDeviceOnline = false;
            }
        }
        
        state.deviceDataCache = newData;

    } catch (error) {
        logger.error(`Polling failed: ${error.message}.`);
        if (state.isDeviceOnline) {
            logger.warn('Marking device as OFFLINE due to polling error.');
            state.isDeviceOnline = false;
        }
    } finally {
        WebSocketManager.broadcast({
            type: 'data-update',
            payload: state.deviceDataCache,
            isOnline: state.isDeviceOnline,
            isFresh: isDataFresh && state.isDeviceOnline,
            timestamp: Date.now(),
        });
        
        state.pollTimeoutId = setTimeout(runPollingCycle, getNextPollRate());
    }
}

/**
 * Initiates a temporary period of faster polling to check for device reconnection.
 */
function triggerActiveCheck() {
    const now = Date.now();
    if (now < state.forcePollCooldownUntil) {
        logger.info('Force poll request ignored due to active cooldown.');
        return;
    }

    logger.info('User triggered active reconnect check...');
    state.forcePollCooldownUntil = now + CONFIG.ACTIVE_CHECK_DURATION_MS;
    state.isActivelyChecking = true;

    runPollingCycle(); // Trigger an immediate poll

    clearTimeout(state.activeCheckTimeoutId);
    state.activeCheckTimeoutId = setTimeout(() => {
        logger.info('Active check period finished.');
        state.isActivelyChecking = false;
    }, CONFIG.ACTIVE_CHECK_DURATION_MS);
}


// --- MAIN APPLICATION ---

/**
 * Initializes the Express server, routes, and starts the application.
 */
function main() {
    if (!CONFIG.BLYNK_AUTH_TOKEN || CONFIG.BLYNK_AUTH_TOKEN.includes("Your")) {
        logger.error('CRITICAL: BLYNK_AUTH_TOKEN is not set in environment variables.');
        process.exit(1);
    }
    
    const app = express();
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // --- Middleware & Static Files ---
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // --- API Routes ---
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
    
    app.post('/api/update-pin', async (req, res) => {
        const { pin, value } = req.body;
        if (!pin || value === undefined) {
            return res.status(400).json({ error: 'Pin and value are required.' });
        }
        try {
            await BlynkService.updatePin(pin, value);
            res.status(200).json({ success: true, message: `Pin ${pin} updated.` });
        } catch (error) {
            logger.error(`API command to pin ${pin} failed: ${error.message}`);
            res.status(500).json({ error: 'Failed to update pin via Blynk API.' });
        }
    });

    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            deviceOnline: state.isDeviceOnline,
            serverUptime: process.uptime(),
            websocketConnections: wss ? wss.clients.size : 0
        });
    });

    // --- Server Startup ---
    const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
        console.log('\n╔══════════════════════════════════════╗');
        console.log('║    EvaraTap Server v7.0 - Refactored   ║');
        console.log('╚══════════════════════════════════════╝');
        logger.info(`Server running at http://localhost:${CONFIG.PORT}`);
        logger.info(`Polling rates (Online/Offline/Check): ${CONFIG.POLLING_RATE_ONLINE_MS/1000}s / ${CONFIG.POLLING_RATE_OFFLINE_MS/1000}s / ${CONFIG.POLLING_RATE_ACTIVE_CHECK_MS/1000}s`);
        
        WebSocketManager.initialize(server);
        runPollingCycle(); // Start the main loop
    });

    // --- Graceful Shutdown ---
    process.on('SIGTERM', () => {
        logger.warn('SIGTERM received. Shutting down gracefully...');
        clearTimeout(state.pollTimeoutId);
        clearTimeout(state.activeCheckTimeoutId);
        server.close(() => {
            logger.success('Server closed.');
            process.exit(0);
        });
    });
}

// Run the application
main();
