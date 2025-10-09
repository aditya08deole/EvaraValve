/**
 * EvaraTap Secure Backend for Blynk on Render - v4.0
 *
 * ARCHITECTURAL REVISION:
 * 1. Removed all external MQTT dependencies for power control.
 * 2. Integrated power control via Blynk Virtual Pin V6.
 * 3. Replaced the "always-on" dual-mode polling with a more efficient,
 * on-demand, single-mode polling system. Polling is now only active
 * when initiated by a user and automatically stops on disconnect.
 * 4. Added a new endpoint to initiate the connection and polling sequence.
 * 5. Enhanced error handling and state management for a more robust system.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const PORT = process.env.PORT || 10000;

// --- IMPORTANT: SET THESE IN YOUR RENDER ENVIRONMENT VARIABLES ---
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// --- On-Demand Polling Configuration ---
const POLLING_RATE_MS = 2000;         // Poll every 5 seconds ONLY when active
const STALE_POLL_THRESHOLD = 6;       // Mark device offline after 3 consecutive stale polls (15 seconds)

// Define all virtual pins your dashboard needs to monitor
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v4', 'v5', 'v6'];
const UPTIME_PIN = 'v5';
const POWER_RELAY_PIN = 'v6';

// --- STATE MANAGEMENT ---
let deviceDataCache = {};
let lastUptimeValue = -1;
let consecutiveStalePolls = 0;
let isDeviceOnline = false;
let isPollingActive = false; // The master switch for the polling loop
let pollingTimeoutId = null; // To control the setTimeout loop

// --- VALIDATION ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1);
}
console.log('✅ Blynk Auth Token loaded:', BLYNK_AUTH_TOKEN.substring(0, 8) + '...');

// --- EXPRESS CONFIGURATION ---
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));


// --- BLYNK API HELPERS ---
/**
 * A centralized and robust function for making GET requests to the Blynk API.
 * @param {string} endpoint - The specific API endpoint (e.g., 'get', 'update').
 * @param {string} params - The query parameters for the request.
 * @returns {Promise<object|null>} The JSON response from Blynk or null on failure.
 */
async function callBlynkApi(endpoint, params) {
    const url = `${BLYNK_API_BASE}/${endpoint}?token=${BLYNK_AUTH_TOKEN}&${params}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`❌ Blynk API Error on ${endpoint} (${response.status}):`, errorText);
            return null;
        }
        // For 'update' calls, Blynk might return an empty body on success.
        if (response.headers.get('content-length') === '0') {
            return { success: true };
        }
        return response.json();
    } catch (error) {
        console.error(`❌ Network error calling Blynk API on ${endpoint}:`, error.message);
        return null;
    }
}

// --- CORE LOGIC: ON-DEMAND BLYNK DATA POLLING ---
const pollBlynkData = async () => {
    // This is the master gate. If polling is not active, do nothing.
    if (!isPollingActive) {
        console.log('Polling is inactive. Stopping.');
        return;
    }

    const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
    const newData = await callBlynkApi('get', pinParams);

    if (!newData) {
        // If the API call itself fails, treat it as a stale poll
        consecutiveStalePolls++;
    } else {
        const currentUptime = parseInt(newData[UPTIME_PIN]) || 0;

        // Heartbeat Logic: Check if uptime value has changed
        if (lastUptimeValue === currentUptime) {
            consecutiveStalePolls++;
        } else {
            // Fresh data detected! Device is online.
            if (!isDeviceOnline) {
                console.info('✅ Fresh data detected! ESP32 is ONLINE.');
            }
            isDeviceOnline = true;
            consecutiveStalePolls = 0;
            lastUptimeValue = currentUptime;
            broadcastDataUpdate(newData);
        }
    }

    // Check for disconnection condition
    if (consecutiveStalePolls >= STALE_POLL_THRESHOLD) {
        console.warn(`⚠️ Stale data detected for ${STALE_POLL_THRESHOLD} consecutive polls. ESP32 is now OFFLINE.`);
        isDeviceOnline = false;
        isPollingActive = false; // Stop the polling loop
        broadcastDataUpdate(deviceDataCache); // Broadcast last known state with offline status
        
        // Safety measure: Turn off the power relay when device disconnects
        console.log(`🔌 Safety shutdown: Turning off power relay (${POWER_RELAY_PIN}).`);
        await callBlynkApi('update', `${POWER_RELAY_PIN}=0`);
        return; // Explicitly stop the loop
    }

    // If we've reached here, polling is still active. Schedule the next run.
    pollingTimeoutId = setTimeout(pollBlynkData, POLLING_RATE_MS);
};

// --- API ENDPOINTS ---

// NEW: Endpoint to start the connection and polling sequence
app.post('/api/start-connection', async (req, res) => {
    if (isPollingActive) {
        return res.status(400).json({ message: 'A connection attempt is already in progress.' });
    }
    console.log('🔌 Received request to start connection. Powering on device...');
    
    const powerOnResult = await callBlynkApi('update', `${POWER_RELAY_PIN}=1`);
    
    if (!powerOnResult) {
        return res.status(500).json({ error: 'Failed to send power-on command to Blynk.' });
    }

    // Reset state and activate polling
    isPollingActive = true;
    isDeviceOnline = false; // Assume offline until first fresh data
    consecutiveStalePolls = 0;
    lastUptimeValue = -1;
    
    // Clear any previous stray timeouts and start the loop immediately
    if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
    pollBlynkData();
    
    res.status(202).json({ success: true, message: 'Connection sequence initiated.' });
});


// UPDATED: Endpoint for generic pin updates (including emergency stop)
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    
    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    console.log(`📤 Received command: Set ${pin} = ${value}`);

    // If this is an emergency stop command, also halt server-side polling
    if (pin === POWER_RELAY_PIN && parseInt(value) === 0) {
        console.log('🚨 EMERGENCY STOP received. Halting polling loop.');
        isPollingActive = false;
        isDeviceOnline = false;
        if (pollingTimeoutId) clearTimeout(pollingTimeoutId);
        broadcastDataUpdate(deviceDataCache); // Broadcast offline status immediately
    }

    const result = await callBlynkApi('update', `${pin}=${value}`);

    if (!result) {
        return res.status(500).json({ error: 'Failed to update pin via Blynk API.' });
    }
    
    res.status(200).json({ success: true, message: `Pin ${pin} updated successfully.` });
});


// --- SERVER & WEBSOCKET INITIALIZATION ---
const server = app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Server v4.0 is running on port ${PORT}`);
    console.log('   Waiting for client to initiate connection...');
});

const wss = new WebSocketServer({ server });

function broadcastDataUpdate(data) {
    deviceDataCache = data; // Update the cache with the latest data
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
        console.log(`📡 Broadcast to ${clientCount} client(s): v0=${data.v0}L, v1=${data.v1}LPM, v2=${data.v2}, v5=${data.v5}s`);
    }
}

wss.on('connection', (ws) => {
    console.log('✅ Client connected to WebSocket.');
    
    // Send the current state immediately on connection
    ws.send(JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        deviceOnline: isDeviceOnline,
        timestamp: Date.now()
    }));
    
    ws.on('close', () => console.log('❌ Client disconnected from WebSocket.'));
    ws.on('error', (error) => console.error('WebSocket client error:', error));
});
