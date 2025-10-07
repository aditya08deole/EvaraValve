/**
 * EvaraTap Secure Backend for Blynk on Render - v2.0 with Smart Polling
 *
 * This server acts as a secure, real-time proxy between the public dashboard
 * and the Blynk API. It uses a WebSocket connection to push data updates
 * to clients efficiently.
 *
 * Architecture:
 * 1. Caching: A server-side cache (`deviceDataCache`) holds the latest device state.
 * 2. Smart Polling: The server now uses a dynamic polling rate. It polls quickly
 * when the ESP32 is online (Active Mode) and very slowly when it detects the
 * device is offline (Idle Mode) to conserve API message limits.
 * 3. Heartbeat Logic: The server checks the ESP32's uptime counter (V5) to
 * determine if the device is online or offline.
 * 4. WebSocket Broadcasting: When data changes, it's pushed to all connected clients.
 * 5. HTTP for Commands: State-changing actions are handled via a standard HTTP POST endpoint.
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

// --- MODIFIED: Smart Polling Rate Configuration ---
const POLLING_RATE_ACTIVE_MS = 5000;   // Poll every 5 seconds when device is ONLINE
const POLLING_RATE_IDLE_MS = 15*60000;    // Poll every  15 minutes when device is OFFLINE
const STALE_DATA_THRESHOLD_MS = 15000; // Consider data stale after 15 seconds of no uptime change

// Define all virtual pins your dashboard needs to monitor here.
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

// --- STATE MANAGEMENT & CACHE ---
let deviceDataCache = {};
let lastUptimeValue = -1;
let lastDataReceivedTimestamp = Date.now();
// --- NEW: State variable to track device status ---
let isDeviceOnline = true;

// --- VALIDATION ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1);
}

// --- EXPRESS CONFIGURATION ---
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// --- CORE LOGIC: BLYNK DATA POLLING (MODIFIED FOR SMART POLLING) ---
const pollBlynkData = async () => {
    try {
        const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
        const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;
        
        const blynkResponse = await fetch(url);
        if (!blynkResponse.ok) {
            throw new Error(`Blynk API responded with status: ${blynkResponse.status}`);
        }
        
        const newData = await blynkResponse.json();
        const currentUptime = newData.v5;

        // --- MODIFIED HEARTBEAT LOGIC ---
        if (currentUptime !== undefined && lastUptimeValue === currentUptime) {
            // Uptime has not changed. Check if the stale threshold has been passed.
            if (Date.now() - lastDataReceivedTimestamp > STALE_DATA_THRESHOLD_MS) {
                if (isDeviceOnline) {
                    console.warn('Stale data detected. ESP32 appears to be OFFLINE.');
                    console.log('Switching to Idle Mode (polling every 60 seconds).');
                    isDeviceOnline = false;
                }
                // We DO NOT broadcast stale data to clients.
            } else {
                 // Uptime is the same, but we are still within the grace period.
                 // Broadcast the data as it might be a temporary network lag.
                 broadcastDataUpdate(newData);
            }
        } else {
            // Uptime has changed, or this is the first poll. Data is fresh.
            if (!isDeviceOnline) {
                console.info('Fresh data detected! ESP32 is back ONLINE.');
                console.log('Switching to Active Mode (polling every 5 seconds).');
            }
            isDeviceOnline = true;
            lastUptimeValue = currentUptime;
            lastDataReceivedTimestamp = Date.now();
            broadcastDataUpdate(newData);
        }
    } catch (error) {
        console.error('Polling Error: Failed to fetch from Blynk API:', error.message);
        // If the API itself fails, we assume the device is offline to be safe.
        isDeviceOnline = false;
    } finally {
        // --- NEW: Self-adjusting timer loop ---
        // Schedule the next poll based on the current device status.
        const nextPollDelay = isDeviceOnline ? POLLING_RATE_ACTIVE_MS : POLLING_RATE_IDLE_MS;
        setTimeout(pollBlynkData, nextPollDelay);
    }
};

// --- API ENDPOINTS ---
app.post('/api/update-pin', async (req, res) => {
    // This function remains unchanged
    const { pin, value } = req.body;
    if (!pin || value === undefined) {
        return res.status(400).json({ error: 'Pin and value are required.' });
    }
    try {
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        const blynkResponse = await fetch(url);
        if (!blynkResponse.ok) {
            throw new Error(`Blynk API responded with status: ${blynkResponse.status}`);
        }
        res.status(200).json({ success: true, message: `Pin ${pin} updated.` });
    } catch (error) {
        console.error('Error updating Blynk pin:', error.message);
        res.status(500).json({ error: 'Failed to update pin.' });
    }
});

// --- SERVER BOILERPLATE ---
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// --- SERVER INITIALIZATION ---
const server = app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Server is running on port ${PORT}`);
    console.log(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // --- MODIFIED: Start the smart polling loop once ---
    pollBlynkData();
});

// --- WEBSOCKET SERVER LOGIC ---
const wss = new WebSocketServer({ server });

function broadcastDataUpdate(data) {
    // --- MODIFIED: Update cache before broadcasting ---
    deviceDataCache = data;
    const message = JSON.stringify({
        type: 'data-update',
        payload: deviceDataCache
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('✅ Client connected to WebSocket.');
    const initialStateMessage = JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache
    });
    ws.send(initialStateMessage);
    ws.on('close', () => console.log('❌ Client disconnected.'));
    ws.on('error', (error) => console.error('WebSocket client error:', error));
});
