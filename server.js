/**
 * EvaraTap Secure Backend for Blynk on Render - v2.2 with Idle Poll Timer
 *
 * FEATURES ADDED:
 * 1. Broadcasts system status (online/offline) to clients via WebSocket.
 * 2. When offline, sends the POLLING_RATE_IDLE_MS to the client to enable a countdown timer.
 *
 * FIXES APPLIED:
 * 1. Corrected Blynk API update endpoint call format
 * 2. Added proper error logging with response text
 * 3. Improved heartbeat detection logic
 * 4. Added CORS headers for cross-origin support
 * 5. Better error handling and status reporting
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

// --- Smart Polling Configuration ---
const POLLING_RATE_ACTIVE_MS = 1500;     // Poll every 1.5 seconds when device is ONLINE
const POLLING_RATE_IDLE_MS = 1.5 * 60000;   // Poll every 1.5 minutes when device is OFFLINE
const STALE_DATA_THRESHOLD_MS = 15000;    // Consider data stale after 15 seconds of no uptime change

// Define all virtual pins your dashboard needs to monitor
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

// --- STATE MANAGEMENT & CACHE ---
let deviceDataCache = {};
let lastUptimeValue = -1;
let lastDataReceivedTimestamp = Date.now();
let isDeviceOnline = false; // Start as offline until first successful poll
let consecutiveStalePolls = 0;

// --- VALIDATION ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1);
}
console.log('✅ Blynk Auth Token loaded:', BLYNK_AUTH_TOKEN.substring(0, 8) + '...');

// --- EXPRESS CONFIGURATION ---
app.use(express.json());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));


// --- NEW: Function to update and broadcast device status ---
function setDeviceOnlineStatus(newStatus) {
    if (isDeviceOnline !== newStatus) {
        isDeviceOnline = newStatus;
        console.log(`System Status Change: Device is now ${isDeviceOnline ? 'ONLINE' : 'OFFLINE'}. Broadcasting to clients.`);
        broadcastSystemStatus();
    }
}

// --- CORE LOGIC: BLYNK DATA POLLING ---
const pollBlynkData = async () => {
    try {
        const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
        const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;
        
        const blynkResponse = await fetch(url);
        
        if (!blynkResponse.ok) {
            const errorText = await blynkResponse.text();
            throw new Error(`Blynk API Error ${blynkResponse.status}: ${errorText}`);
        }
        
        const newData = await blynkResponse.json();
        const currentUptime = parseInt(newData.v5) || 0;

        if (currentUptime !== undefined && lastUptimeValue === currentUptime) {
            consecutiveStalePolls++;
            
            if (consecutiveStalePolls >= 3) {
                if (isDeviceOnline) {
                    console.warn('⚠️  Stale data detected. ESP32 appears to be OFFLINE.');
                    console.log(`🐌 Switching to Idle Mode (polling every ${POLLING_RATE_IDLE_MS / 1000} seconds).`);
                    setDeviceOnlineStatus(false);
                }
            } else {
                broadcastDataUpdate(newData);
            }
        } else {
            consecutiveStalePolls = 0;
            
            if (!isDeviceOnline) {
                console.info('✅ Fresh data detected! ESP32 is back ONLINE.');
                console.log(`🚀 Switching to Active Mode (polling every ${POLLING_RATE_ACTIVE_MS / 1000} seconds).`);
            }
            
            setDeviceOnlineStatus(true);
            lastUptimeValue = currentUptime;
            lastDataReceivedTimestamp = Date.now();
            broadcastDataUpdate(newData);
        }
    } catch (error) {
        console.error('❌ Polling Error:', error.message);
        if (isDeviceOnline) {
            setDeviceOnlineStatus(false); // Set to offline on error
        }
    } finally {
        const nextPollDelay = isDeviceOnline ? POLLING_RATE_ACTIVE_MS : POLLING_RATE_IDLE_MS;
        setTimeout(pollBlynkData, nextPollDelay);
    }
};

// --- API ENDPOINT FOR UPDATING PINS ---
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    console.log(`📤 Received command: ${pin} = ${value}`);
    
    if (!pin || value === undefined) {
        console.error('❌ Invalid request: missing pin or value');
        return res.status(400).json({ error: 'Pin and value are required.' });
    }

    try {
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        console.log(`🔗 Calling Blynk API: ${url.replace(BLYNK_AUTH_TOKEN, 'TOKEN_HIDDEN')}`);
        
        const blynkResponse = await fetch(url, { method: 'GET' });
        const responseText = await blynkResponse.text();
        
        if (!blynkResponse.ok) {
            console.error(`❌ Blynk API Error ${blynkResponse.status}:`, responseText);
            throw new Error(`Blynk API Error ${blynkResponse.status}: ${responseText}`);
        }
        
        console.log(`✅ Blynk API Response:`, responseText);
        res.status(200).json({ success: true, message: `Pin ${pin} updated to ${value}` });
        
    } catch (error) {
        console.error('❌ Error updating Blynk pin:', error.message);
        res.status(500).json({ error: 'Failed to update pin', details: error.message });
    }
});

// --- HEALTH & DEBUG ENDPOINTS ---
app.get('/health', (req, res) => res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/debug', (req, res) => res.json({
    deviceOnline: isDeviceOnline, lastUptime: lastUptimeValue, cache: deviceDataCache,
    lastDataReceived: new Date(lastDataReceivedTimestamp).toISOString(),
    consecutiveStalePolls: consecutiveStalePolls, connectedClients: wss.clients.size
}));

// --- SERVER INITIALIZATION ---
const server = app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Server v2.2 is running on port ${PORT}`);
    pollBlynkData();
});

// --- WEBSOCKET SERVER LOGIC ---
const wss = new WebSocketServer({ server });

function broadcastToClients(message) {
    let clientCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            clientCount++;
        }
    });
    return clientCount;
}

function broadcastDataUpdate(data) {
    deviceDataCache = data;
    const message = JSON.stringify({
        type: 'data-update', payload: deviceDataCache, timestamp: Date.now()
    });
    const clientCount = broadcastToClients(message);
    if (clientCount > 0) {
        console.log(`📡 Data Broadcast to ${clientCount} client(s): v0=${data.v0}, v1=${data.v1}, v5=${data.v5}`);
    }
}

// --- NEW: Function to broadcast the system's online/offline status ---
function broadcastSystemStatus() {
    const payload = { online: isDeviceOnline };
    if (!isDeviceOnline) {
        payload.idlePollRate = POLLING_RATE_IDLE_MS; // Send the timer duration
    }
    const message = JSON.stringify({ type: 'system-status', payload: payload });
    const clientCount = broadcastToClients(message);
    if (clientCount > 0) {
        console.log(`🚦 Status Broadcast to ${clientCount} client(s): online=${isDeviceOnline}`);
    }
}

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`✅ Client connected from ${clientIP}`);
    
    // Send initial state immediately
    ws.send(JSON.stringify({
        type: 'initial-state', payload: deviceDataCache, timestamp: Date.now()
    }));

    // --- NEW: Send current system status immediately on connection ---
    const statusPayload = { online: isDeviceOnline };
    if (!isDeviceOnline) {
        statusPayload.idlePollRate = POLLING_RATE_IDLE_MS;
    }
    ws.send(JSON.stringify({ type: 'system-status', payload: statusPayload }));
    
    ws.on('close', () => console.log(`❌ Client disconnected from ${clientIP}`));
    ws.on('error', (error) => console.error('WebSocket client error:', error));
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
