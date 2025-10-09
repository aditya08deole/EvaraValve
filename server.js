/**
 * EvaraTap Secure Backend for Blynk on Render - v2.1 FIXED
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
const POLLING_RATE_ACTIVE_MS = 5000;      // Poll every 5 seconds when device is ONLINE
const POLLING_RATE_IDLE_MS = 15*60000;       // Poll every 15*60 seconds when device is OFFLINE
const STALE_DATA_THRESHOLD_MS = 15000;    // Consider data stale after 15 seconds of no uptime change

// Define all virtual pins your dashboard needs to monitor
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

// --- STATE MANAGEMENT & CACHE ---
let deviceDataCache = {};
let lastUptimeValue = -1;
let lastDataReceivedTimestamp = Date.now();
let isDeviceOnline = true;
let consecutiveStalePolls = 0; // NEW: Track how many polls returned stale data

// --- VALIDATION ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1);
}

console.log('✅ Blynk Auth Token loaded:', BLYNK_AUTH_TOKEN.substring(0, 8) + '...');

// --- EXPRESS CONFIGURATION ---
app.use(express.json());

// CORS headers for cross-origin requests
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

// --- CORE LOGIC: BLYNK DATA POLLING (IMPROVED) ---
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

        // IMPROVED HEARTBEAT LOGIC
        if (currentUptime !== undefined && lastUptimeValue === currentUptime) {
            consecutiveStalePolls++;
            
            // Only mark offline after 3 consecutive stale polls
            if (consecutiveStalePolls >= 3) {
                if (isDeviceOnline) {
                    console.warn('⚠️  Stale data detected. ESP32 appears to be OFFLINE.');
                    console.log('🐌 Switching to Idle Mode (polling every 60 seconds).');
                    isDeviceOnline = false;
                }
                // Don't broadcast stale data
            } else {
                // Still within grace period, broadcast the data
                broadcastDataUpdate(newData);
            }
        } else {
            // Uptime has changed - device is definitely online
            consecutiveStalePolls = 0;
            
            if (!isDeviceOnline) {
                console.info('✅ Fresh data detected! ESP32 is back ONLINE.');
                console.log('🚀 Switching to Active Mode (polling every 5 seconds).');
            }
            
            isDeviceOnline = true;
            lastUptimeValue = currentUptime;
            lastDataReceivedTimestamp = Date.now();
            broadcastDataUpdate(newData);
        }
    } catch (error) {
        console.error('❌ Polling Error:', error.message);
        isDeviceOnline = false;
    } finally {
        const nextPollDelay = isDeviceOnline ? POLLING_RATE_ACTIVE_MS : POLLING_RATE_IDLE_MS;
        setTimeout(pollBlynkData, nextPollDelay);
    }
};

// --- FIXED: API ENDPOINT FOR UPDATING PINS ---
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    
    console.log(`📤 Received command: ${pin} = ${value}`);
    
    if (!pin || value === undefined) {
        console.error('❌ Invalid request: missing pin or value');
        return res.status(400).json({ 
            error: 'Pin and value are required.',
            received: { pin, value }
        });
    }

    try {
        // FIXED: Correct Blynk API format
        // The update endpoint expects: /update?token=XXX&pin=value
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        
        console.log(`🔗 Calling Blynk API: ${url.replace(BLYNK_AUTH_TOKEN, 'TOKEN_HIDDEN')}`);
        
        const blynkResponse = await fetch(url, {
            method: 'GET',  // Blynk's REST API uses GET for updates
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const responseText = await blynkResponse.text();
        
        if (!blynkResponse.ok) {
            console.error(`❌ Blynk API Error ${blynkResponse.status}:`, responseText);
            throw new Error(`Blynk API Error ${blynkResponse.status}: ${responseText}`);
        }
        
        console.log(`✅ Blynk API Response:`, responseText);
        
        res.status(200).json({ 
            success: true, 
            message: `Pin ${pin} updated to ${value}`,
            blynkResponse: responseText
        });
        
    } catch (error) {
        console.error('❌ Error updating Blynk pin:', error.message);
        res.status(500).json({ 
            error: 'Failed to update pin',
            details: error.message,
            pin: pin,
            value: value
        });
    }
});

// --- HEALTH CHECK ENDPOINT ---
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        deviceOnline: isDeviceOnline,
        lastUptime: lastUptimeValue,
        cacheKeys: Object.keys(deviceDataCache)
    });
});

// --- ROOT ENDPOINT ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- DEBUG ENDPOINT (helpful for troubleshooting) ---
app.get('/api/debug', (req, res) => {
    res.json({
        deviceOnline: isDeviceOnline,
        lastUptime: lastUptimeValue,
        cache: deviceDataCache,
        lastDataReceived: new Date(lastDataReceivedTimestamp).toISOString(),
        consecutiveStalePolls: consecutiveStalePolls,
        connectedClients: wss.clients.size
    });
});

// --- SERVER INITIALIZATION ---
const server = app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Server v2.1 is running on port ${PORT}`);
    console.log(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📍 Access at: http://localhost:${PORT}`);
    
    // Start the smart polling loop
    pollBlynkData();
});

// --- WEBSOCKET SERVER LOGIC ---
const wss = new WebSocketServer({ server });

function broadcastDataUpdate(data) {
    deviceDataCache = data;
    const message = JSON.stringify({
        type: 'data-update',
        payload: deviceDataCache,
        timestamp: Date.now()
    });

    let clientCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            clientCount++;
        }
    });
    
    if (clientCount > 0) {
        console.log(`📡 Broadcast to ${clientCount} client(s): v0=${data.v0}L, v1=${data.v1}LPM, v2=${data.v2}, v5=${data.v5}s`);
    }
}

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`✅ Client connected from ${clientIP}`);
    
    // Send initial state immediately
    const initialStateMessage = JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        timestamp: Date.now()
    });
    ws.send(initialStateMessage);
    
    ws.on('close', () => {
        console.log(`❌ Client disconnected from ${clientIP}`);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket client error:', error);
    });
});

// --- GRACEFUL SHUTDOWN ---
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
