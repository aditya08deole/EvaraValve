import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

// ===================================================================================
// --- CONFIGURATION & CONSTANTS ---
// ===================================================================================

const app = express();
const PORT = process.env.PORT || 10000;

// --- IMPORTANT: SET THIS IN YOUR RENDER/HOSTING ENVIRONMENT VARIABLES ---
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// --- Polling and Offline Detection Configuration ---
// The system detects an offline device in STALE_POLL_THRESHOLD * POLLING_RATE_MS.
// Current configuration: 4 polls * 2000ms = 8 seconds.
const POLLING_RATE_MS = 2000;      // Poll every 2 seconds ONLY when a client is active.
const STALE_POLL_THRESHOLD = 10;         // Mark device offline after 4 consecutive stale polls.
const COMMAND_CONFIRM_DELAY_MS = 2000; // Wait 750ms before checking if a command was successful.


// --- VIRTUAL PIN DEFINITIONS ---
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v4', 'v5', 'v6'];
const UPTIME_PIN = 'v5';            // Device heartbeat pin (e.g., seconds since boot).
const POWER_RELAY_PIN = 'v6';       // Pin controlling the main power to the ESP32 system.

// ===================================================================================
// --- STATE MANAGEMENT ---
// ===================================================================================

/** @type {Object<string, any>} - Caches the last known data from Blynk. */
let deviceDataCache = {};
/** @type {number} - The last received uptime value to detect if the device is responsive. */
let lastUptimeValue = -1;
/** @type {number} - Counter for consecutive polls without a change in uptime. */
let consecutiveStalePolls = 0;
/** @type {boolean} - Master flag indicating if the device is considered online. */
let isDeviceOnline = false;
/** @type {boolean} - The master switch for the polling loop. Active only when a connection is initiated. */
let isPollingActive = false;
/** @type {NodeJS.Timeout|null} - Holds the ID of the `setTimeout` for the polling loop to allow cancellation. */
let pollingTimeoutId = null;

// ===================================================================================
// --- STARTUP VALIDATION ---
// ===================================================================================

if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1);
}
console.log(`[INFO] Blynk Auth Token loaded: ${BLYNK_AUTH_TOKEN.substring(0, 8)}...`);

// ===================================================================================
// --- EXPRESS & WEBSOCKET SETUP ---
// ===================================================================================

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Server v5.0 is running on port ${PORT}`);
    console.log('[INFO] Waiting for client to initiate connection...');
});

const wss = new WebSocketServer({ server });

// ===================================================================================
// --- BLYNK API HELPER ---
// ===================================================================================

/**
 * A centralized and robust function for making GET requests to the Blynk API.
 * @param {string} endpoint - The specific API endpoint (e.g., 'get', 'update').
 * @param {string} params - The query parameters for the request (e.g., 'v1&v2' or 'v6=1').
 * @returns {Promise<object|null>} The JSON response from Blynk or null on failure.
 */
async function callBlynkApi(endpoint, params) {
    const url = `${BLYNK_API_BASE}/${endpoint}?token=${BLYNK_AUTH_TOKEN}&${params}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[API-ERROR] Blynk API Error on ${endpoint} (${response.status}):`, errorText);
            return null;
        }
        // For 'update' calls, Blynk returns an empty body on success. Handle this gracefully.
        if (response.headers.get('content-length') === '0') {
            return { success: true };
        }
        return response.json();
    } catch (error) {
        console.error(`[API-ERROR] Network error calling Blynk API on ${endpoint}:`, error.message);
        return null;
    }
}

// ===================================================================================
// --- CORE POLLING LOGIC ---
// ===================================================================================

/**
 * Polls Blynk for the latest data, checks device status, and broadcasts updates.
 * This function schedules its next run via setTimeout, creating a controlled loop.
 */
const pollBlynkData = async () => {
    // This is the master gate. If polling is flagged as inactive, terminate the loop.
    if (!isPollingActive) {
        console.log('[POLL] Polling is inactive. Stopping loop.');
        return;
    }

    const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
    const newData = await callBlynkApi('get', pinParams);

    if (!newData) {
        // If the API call itself fails, treat it as a stale poll.
        consecutiveStalePolls++;
    } else {
        const currentUptime = parseInt(newData[UPTIME_PIN]) || 0;

        // --- Heartbeat Logic: Check if the device's uptime value has changed ---
        if (lastUptimeValue === currentUptime && isDeviceOnline) {
            // Only count as stale if we were previously online. This prevents false positives during startup.
            consecutiveStalePolls++;
            console.log(`[POLL-WARN] Stale data detected. Uptime ${currentUptime}s unchanged. Stale count: ${consecutiveStalePolls}/${STALE_POLL_THRESHOLD}`);
        } else {
            // Fresh data detected! Reset counter and mark device as online.
            if (!isDeviceOnline) {
                console.info('✅ [STATUS] Fresh data detected! ESP32 is now ONLINE.');
            }
            isDeviceOnline = true;
            consecutiveStalePolls = 0;
            lastUptimeValue = currentUptime;
            deviceDataCache = newData; // Update cache only on fresh data
            broadcastDataUpdate();
        }
    }

    // --- Offline Condition Check ---
    if (consecutiveStalePolls >= STALE_POLL_THRESHOLD) {
        console.warn(`🚨 [STATUS] OFFLINE: Stale data threshold reached (${STALE_POLL_THRESHOLD} polls).`);
        isDeviceOnline = false;
        isPollingActive = false; // Stop the polling loop to conserve resources.
        broadcastDataUpdate(); // Broadcast final state with offline status.

        // --- SAFETY SHUTDOWN ---
        console.log(`[SAFETY] Triggering safety shutdown: Turning off power relay (${POWER_RELAY_PIN}).`);
        await callBlynkApi('update', `${POWER_RELAY_PIN}=0`);
        return; // Explicitly stop the loop here.
    }

    // If we've reached here, polling is still active. Schedule the next run.
    pollingTimeoutId = setTimeout(pollBlynkData, POLLING_RATE_MS);
};

// ===================================================================================
// --- API ENDPOINTS ---
// ===================================================================================

/**
 * @api {post} /api/start-connection
 * @description Powers on the device and initiates the server-side polling loop.
 */
app.post('/api/start-connection', async (req, res) => {
    if (isPollingActive) {
        return res.status(400).json({ message: 'A connection is already active.' });
    }
    console.log('[API] Received request to start connection. Powering on device...');

    const powerOnResult = await callBlynkApi('update', `${POWER_RELAY_PIN}=1`);

    if (!powerOnResult) {
        return res.status(500).json({ error: 'Failed to send power-on command to Blynk.' });
    }

    // Reset state variables and activate polling
    isPollingActive = true;
    isDeviceOnline = false; // Assume offline until the first fresh data is received.
    consecutiveStalePolls = 0;
    lastUptimeValue = -1;

    // Clear any previous stray timeouts and start the loop immediately.
    if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
    pollBlynkData();

    res.status(202).json({ success: true, message: 'Connection sequence initiated.' });
});

/**
 * @api {post} /api/update-pin
 * @description A reliable endpoint to update a pin's value with command confirmation.
 */
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;

    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    console.log(`[CMD] Received command: Set ${pin} = ${value}`);

    // --- Special Handling for Emergency Stop ---
    if (pin === POWER_RELAY_PIN && parseInt(value) === 0) {
        console.log('[CMD] EMERGENCY STOP received. Halting polling loop.');
        isPollingActive = false;
        isDeviceOnline = false;
        if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
        broadcastDataUpdate(); // Broadcast offline status immediately.
    }

    // --- Step 1: Send the update command ---
    const updateResult = await callBlynkApi('update', `${pin}=${value}`);
    if (!updateResult) {
        console.error(`[CMD-FAIL] Initial Blynk API call failed for ${pin}=${value}`);
        return res.status(500).json({ success: false, error: 'Failed to send command to Blynk API.' });
    }
    console.log(`[CMD-SENT] Command ${pin}=${value} sent to Blynk Cloud. Awaiting confirmation...`);

    // --- Step 2: Implement Read-After-Write for command confirmation ---
    try {
        // Wait a brief moment for the command to propagate.
        await new Promise(resolve => setTimeout(resolve, COMMAND_CONFIRM_DELAY_MS));

        const confirmationData = await callBlynkApi('get', pin);

        // Use '==' for loose comparison as Blynk may return numbers as strings (e.g., '1' vs 1).
        if (confirmationData && confirmationData[pin] == value) {
            console.log(`[CMD-CONFIRM] ✅ SUCCESS: Confirmed ${pin} is now ${value}.`);
            
            // If polling is active, trigger an immediate poll to refresh all UI data instantly.
            if (isPollingActive) {
                if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
                pollBlynkData();
            }
            
            return res.status(200).json({ success: true, message: `Command confirmed: ${pin} set to ${value}.` });
        } else {
            console.warn(`[CMD-FAIL] ⚠️ CONFIRMATION FAILED for ${pin}. Expected ${value}, got ${confirmationData ? confirmationData[pin] : 'n/a'}.`);
            return res.status(500).json({
                success: false,
                error: 'Command sent, but confirmation failed. The device may be offline or slow to respond.'
            });
        }
    } catch (error) {
        console.error(`[CMD-FAIL] Error during command confirmation check for ${pin}:`, error);
        return res.status(500).json({
            success: false,
            error: 'An unexpected error occurred during command confirmation.'
        });
    }
});

// ===================================================================================
// --- WEBSOCKET BROADCAST LOGIC ---
// ===================================================================================

/**
 * Broadcasts the current device state to all connected WebSocket clients.
 */
function broadcastDataUpdate() {
    const message = JSON.stringify({
        type: isDeviceOnline ? 'data-update' : 'device-offline',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        timestamp: Date.now()
    });

    let clientCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            clientCount++;
        }
    });

    if (clientCount > 0 && isDeviceOnline) {
        const { v0, v1, v2, v5 } = deviceDataCache;
        console.log(`[WSS] 📡 Broadcast to ${clientCount} client(s): v0=${v0}L, v1=${v1}LPM, v2=${v2}, v5=${v5}s`);
    } else if (clientCount > 0 && !isDeviceOnline) {
        console.log(`[WSS] 📡 Broadcast 'device-offline' to ${clientCount} client(s).`);
    }
}

wss.on('connection', (ws) => {
    console.log('[WSS] ✅ Client connected to WebSocket.');

    // Send the current state immediately upon connection to sync the new client.
    ws.send(JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        timestamp: Date.now()
    }));

    ws.on('close', () => console.log('[WSS] ❌ Client disconnected from WebSocket.'));
    ws.on('error', (error) => console.error('[WSS-ERROR] WebSocket client error:', error));
});
