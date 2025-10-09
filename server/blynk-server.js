/**
 * EvaraTap Secure Backend - v3.2
 *
 * @description
 * This professionally structured Node.js server acts as a bridge for the EvaraTap
 * dashboard. It performs the following key functions:
 * 1.  Continuously polls the Blynk.cloud API for real-time device data.
 * 2.  Implements a heartbeat mechanism to detect if the device goes offline and
 * pauses polling to conserve resources.
 * 3.  Serves the static frontend dashboard application.
 * 4.  Utilizes a WebSocket server for instant, bidirectional communication with
 * connected clients, pushing data updates and online/offline status changes.
 * 5.  Provides secure API endpoints for controlling the device and resuming polling.
 * 6.  Includes graceful shutdown handling for production environments.
 *
 * @author      [Aditya Deole]
 * @version     3.2.0
 * @last-update 2025-10-09
 */

// --- MODULE IMPORTS ---
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

// --- CONFIGURATION ---
// Environment and Application settings.
const PORT = process.env.PORT || 10000;
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;

// Blynk API settings.
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v4', 'v5'];
const UPTIME_HEARTBEAT_PIN = 'v5'; // The pin used to check if the device is responsive.

// Polling and Offline Detection settings.
const POLLING_RATE_ACTIVE_MS = 2500; // Poll every 2.5 seconds when the device is online.
const OFFLINE_THRESHOLD_POLLS = 6; // Mark device as offline after 6 consecutive polls with no uptime change.

// WebSocket Message Types
const WS_MSG_TYPE = {
    DATA_UPDATE: 'data-update',
    DEVICE_OFFLINE: 'device-offline',
    INITIAL_STATE: 'initial-state'
};

// --- VALIDATION ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: The BLYNK_AUTH_TOKEN environment variable is not set. The server cannot start.');
    process.exit(1); // Exit with a failure code.
}

// --- UTILITIES ---
// A simple logger for consistent message formatting.
const log = {
    info: (message) => console.log(`[INFO] ${new Date().toISOString()}: ${message}`),
    warn: (message) => console.warn(`[WARN] ${new Date().toISOString()}: ${message}`),
    error: (message, error) => console.error(`[ERROR] ${new Date().toISOString()}: ${message}`, error || ''),
};

// Path resolution for ES Modules.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- STATE MANAGEMENT ---
// Centralized state object to manage the application's status.
const appState = {
    deviceDataCache: {},
    lastUptimeValue: -1,
    isDeviceOnline: false, // Start assuming offline until a successful poll confirms otherwise.
    consecutiveStalePolls: 0,
    pollingTimeoutId: null,
};


// --- EXPRESS SETUP ---
const app = express();
app.use(express.json()); // Middleware to parse JSON request bodies.
app.use(express.static(path.join(__dirname, '..', 'public'))); // Serve static files from the 'public' directory.


// --- CORE BLYNK POLLING LOGIC ---

/**
 * Polls the Blynk API for the latest data from configured virtual pins.
 * This function contains the core heartbeat logic to determine device connectivity.
 */
const pollBlynkData = async () => {
    clearTimeout(appState.pollingTimeoutId); // Ensure no duplicate polling loops are running.

    try {
        const pinParams = VIRTUAL_PINS_TO_POLL.map(pin => `${pin}`).join('&');
        const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;
        const blynkResponse = await fetch(url);

        if (!blynkResponse.ok) {
            throw new Error(`Blynk API responded with status ${blynkResponse.status}`);
        }

        const newData = await blynkResponse.json();
        const currentUptime = parseInt(newData[UPTIME_HEARTBEAT_PIN]) || 0;

        // --- Heartbeat Logic ---
        // If uptime is positive but hasn't changed since the last poll, it may be stale.
        if (currentUptime > 0 && appState.lastUptimeValue === currentUptime) {
            appState.consecutiveStalePolls++;

            if (appState.consecutiveStalePolls >= OFFLINE_THRESHOLD_POLLS && appState.isDeviceOnline) {
                log.warn(`Stale data detected for ${OFFLINE_THRESHOLD_POLLS} consecutive polls. Marking device as OFFLINE.`);
                appState.isDeviceOnline = false;
                broadcastOfflineState();
                return; // Stop polling until resumed.
            }
        } else {
            // Fresh data received, device is online.
            if (!appState.isDeviceOnline) {
                log.info('✅ Fresh data detected! Device is now ONLINE.');
            }
            appState.consecutiveStalePolls = 0;
            appState.isDeviceOnline = true;
            appState.lastUptimeValue = currentUptime;
            appState.deviceDataCache = newData;
            broadcastDataUpdate(newData);
        }
    } catch (error) {
        log.error('An error occurred during polling:', error.message);
        if (appState.isDeviceOnline) {
            appState.isDeviceOnline = false;
            broadcastOfflineState();
        }
        return; // Stop polling on error.
    }

    // Schedule the next poll only if the device is considered online.
    if (appState.isDeviceOnline) {
        appState.pollingTimeoutId = setTimeout(pollBlynkData, POLLING_RATE_ACTIVE_MS);
    }
};

// --- API ENDPOINTS ---

/**
 * @api {post} /api/update-pin Update a virtual pin on the Blynk device.
 * @body {string} pin The virtual pin to update (e.g., "v1").
 * @body {any} value The value to write to the pin.
 */
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Both "pin" and "value" fields are required.' });
    }

    try {
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        const blynkResponse = await fetch(url);
        if (!blynkResponse.ok) {
            throw new Error(`Blynk API returned status ${blynkResponse.status}`);
        }
        log.info(`✅ Command sent successfully: ${pin}=${value}`);
        res.status(200).json({ success: true, message: `Pin ${pin} updated.` });
    } catch (error) {
        log.error(`Failed to update Blynk pin ${pin}:`, error.message);
        res.status(500).json({ error: 'An internal error occurred while updating the pin.' });
    }
});

/**
 * @api {post} /api/resume-polling Manually triggers the server to resume polling for device data.
 */
app.post('/api/resume-polling', (req, res) => {
    log.info('🔄 Received API request to resume polling...');
    if (!appState.isDeviceOnline) {
        // Reset state to ensure a fresh start.
        appState.consecutiveStalePolls = 0;
        appState.lastUptimeValue = -1;
        pollBlynkData(); // Trigger an immediate poll.
    }
    res.status(200).json({ success: true, message: "Polling resumption initiated." });
});

/**
 * @api {get} /health Provides a simple health check of the server.
 */
app.get('/health', (req, res) => res.status(200).json({
    status: 'healthy',
    deviceOnline: appState.isDeviceOnline,
    timestamp: new Date().toISOString(),
}));

/**
 * @api {get} / Serves the main frontend application.
 */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- SERVER & WEBSOCKET SETUP ---
const server = app.listen(PORT, () => {
    log.info(`🚀 EvaraTap Blynk Server v3.2 is running on http://localhost:${PORT}`);
    pollBlynkData(); // Start the initial polling cycle.
});

const wss = new WebSocketServer({ server });

/**
 * Broadcasts a JSON message to all connected WebSocket clients.
 * @param {object} messageObject The object to stringify and send.
 */
function broadcast(messageObject) {
    const message = JSON.stringify(messageObject);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

/**
 * Broadcasts a device data update to all clients.
 * @param {object} data The latest data from the Blynk device.
 */
function broadcastDataUpdate(data) {
    log.info(`📡 Broadcasting data update to ${wss.clients.size} clients.`);
    broadcast({
        type: WS_MSG_TYPE.DATA_UPDATE,
        payload: data,
        deviceOnline: true,
        timestamp: Date.now()
    });
}

/**
 * Broadcasts the device offline status to all clients.
 */
function broadcastOfflineState() {
    log.warn(`🔌 Broadcasting OFFLINE state to ${wss.clients.size} clients.`);
    broadcast({
        type: WS_MSG_TYPE.DEVICE_OFFLINE,
        payload: {},
        deviceOnline: false,
        timestamp: Date.now()
    });
}

// Handle new WebSocket connections.
wss.on('connection', (ws) => {
    log.info(`✅ Client connected via WebSocket. Total clients: ${wss.clients.size}`);

    // Immediately send the current state to the newly connected client.
    const initialState = {
        type: appState.isDeviceOnline ? WS_MSG_TYPE.INITIAL_STATE : WS_MSG_TYPE.DEVICE_OFFLINE,
        payload: appState.isDeviceOnline ? appState.deviceDataCache : {},
        deviceOnline: appState.isDeviceOnline,
        timestamp: Date.now()
    };
    ws.send(JSON.stringify(initialState));

    ws.on('close', () => {
        log.info(`❌ Client disconnected. Total clients: ${wss.clients.size}`);
    });

    ws.on('error', (error) => {
        log.error('A WebSocket error occurred:', error);
    });
});


// --- GRACEFUL SHUTDOWN ---

/**
 * Handles server shutdown signals to ensure connections are closed gracefully.
 */
const gracefulShutdown = () => {
    log.info('SIGINT/SIGTERM received. Initiating graceful shutdown...');

    // Stop accepting new connections
    server.close(() => {
        log.info('HTTP server has closed.');
        // Close all existing WebSocket connections
        wss.close(() => {
            log.info('WebSocket server has closed.');
            process.exit(0);
        });
    });

    // Force shutdown after a timeout if graceful shutdown fails.
    setTimeout(() => {
        log.error('Could not close connections in time, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10-second timeout
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
