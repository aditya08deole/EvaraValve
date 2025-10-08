/**
 * EvaraTap Server v3.0 - Smart Polling with Reliable Offline Detection
 * 
 * IMPROVEMENTS:
 * - Smart polling: 5s when online, 15min when offline
 * - Dual offline detection: uptime + timestamp
 * - Grace period before marking offline
 * - Proper state management
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const PORT = process.env.PORT || 10000;

const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// Smart Polling Configuration
const POLLING_RATE_ONLINE = 1000;        // 1 seconds when device is online
const POLLING_RATE_OFFLINE = 60 * 1000;  // 1 minutes when device is offline
const STALE_UPTIME_GRACE_POLLS = 5;      // Allow 5 stale polls before marking offline
const STALE_TIMESTAMP_THRESHOLD = 20000;  // 20 seconds since last fresh data

// Virtual pins to monitor
const VIRTUAL_PINS_TO_POLL = ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

// State management
let deviceDataCache = {};
let lastUptimeValue = -1;
let lastFreshDataTimestamp = Date.now();
let isDeviceOnline = false;  // Start pessimistic
let consecutiveStalePolls = 0;
let currentPollingRate = POLLING_RATE_ONLINE;

// Validation
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL: BLYNK_AUTH_TOKEN not set');
    process.exit(1);
}

console.log('✅ Token loaded:', BLYNK_AUTH_TOKEN.substring(0, 8) + '...');

// Express configuration
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// IMPROVED: Smart polling with dual offline detection
const pollBlynkData = async () => {
    try {
        const pinParams = VIRTUAL_PINS_TO_POLL.join('&');
        const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;
        
        const blynkResponse = await fetch(url, { timeout: 8000 });
        
        if (!blynkResponse.ok) {
            const errorText = await blynkResponse.text();
            throw new Error(`Blynk API Error ${blynkResponse.status}: ${errorText}`);
        }
        
        const newData = await blynkResponse.json();
        const currentUptime = parseInt(newData.v5) || 0;
        const now = Date.now();

        // DUAL DETECTION: Check both uptime change AND timestamp freshness
        const uptimeChanged = (currentUptime !== lastUptimeValue) && (currentUptime > 0);
        const timeSinceLastFresh = now - lastFreshDataTimestamp;
        
        if (uptimeChanged) {
            // Fresh data detected - device is definitely online
            consecutiveStalePolls = 0;
            lastUptimeValue = currentUptime;
            lastFreshDataTimestamp = now;
            
            if (!isDeviceOnline) {
                console.log('\n✅ DEVICE BACK ONLINE');
                console.log(`   Uptime changed: ${lastUptimeValue} → ${currentUptime}`);
                console.log(`   Switching to FAST polling (${POLLING_RATE_ONLINE/1000}s)\n`);
                isDeviceOnline = true;
                currentPollingRate = POLLING_RATE_ONLINE;
            }
            
            broadcastDataUpdate(newData, true);
            
        } else {
            // Uptime hasn't changed - check grace period
            consecutiveStalePolls++;
            
            // Still broadcast data during grace period
            if (consecutiveStalePolls <= STALE_UPTIME_GRACE_POLLS) {
                console.log(`⏳ Stale poll ${consecutiveStalePolls}/${STALE_UPTIME_GRACE_POLLS} (grace period)`);
                broadcastDataUpdate(newData, false);
            } else {
                // Grace period expired AND timestamp is old - mark offline
                if (timeSinceLastFresh > STALE_TIMESTAMP_THRESHOLD) {
                    if (isDeviceOnline) {
                        console.log('\n❌ DEVICE OFFLINE');
                        console.log(`   Reason: No uptime change for ${consecutiveStalePolls} polls`);
                        console.log(`   Last fresh data: ${Math.floor(timeSinceLastFresh/1000)}s ago`);
                        console.log(`   Switching to SLOW polling (${POLLING_RATE_OFFLINE/60000}min)\n`);
                        isDeviceOnline = false;
                        currentPollingRate = POLLING_RATE_OFFLINE;
                    }
                    // Don't broadcast stale data when offline
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Poll Error:', error.message);
        if (isDeviceOnline) {
            console.log('⚠️  Marking device offline due to error');
            isDeviceOnline = false;
            currentPollingRate = POLLING_RATE_OFFLINE;
        }
    } finally {
        // Smart scheduling based on current state
        setTimeout(pollBlynkData, currentPollingRate);
    }
};

function broadcastDataUpdate(data, isFresh) {
    deviceDataCache = data;
    const message = JSON.stringify({
        type: 'data-update',
        payload: deviceDataCache,
        timestamp: Date.now(),
        isOnline: isDeviceOnline,
        isFresh: isFresh
    });

    let clientCount = 0;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            clientCount++;
        }
    });
    
    if (clientCount > 0 && isFresh) {
        console.log(`📡 Broadcast: v0=${data.v0}L, v1=${data.v1}LPM, v2=${data.v2}, v5=${data.v5}s → ${clientCount} client(s)`);
    }
}

// API endpoint for commands
app.post('/api/update-pin', async (req, res) => {
    const { pin, value } = req.body;
    
    console.log(`📤 Command: ${pin} = ${value}`);
    
    if (!pin || value === undefined) {
        return res.status(400).json({ 
            error: 'Pin and value required',
            received: { pin, value }
        });
    }

    try {
        const url = `${BLYNK_API_BASE}/update?token=${BLYNK_AUTH_TOKEN}&${pin}=${value}`;
        const blynkResponse = await fetch(url, { method: 'GET' });
        const responseText = await blynkResponse.text();
        
        if (!blynkResponse.ok) {
            throw new Error(`Blynk Error ${blynkResponse.status}: ${responseText}`);
        }
        
        console.log(`✅ Command sent: ${responseText}`);
        res.status(200).json({ 
            success: true, 
            message: `Pin ${pin} updated to ${value}`,
            blynkResponse: responseText
        });
        
    } catch (error) {
        console.error('❌ Command failed:', error.message);
        res.status(500).json({ 
            error: 'Failed to update pin',
            details: error.message
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        deviceOnline: isDeviceOnline,
        lastUptime: lastUptimeValue,
        pollingRate: currentPollingRate === POLLING_RATE_ONLINE ? '5s' : '15min',
        consecutiveStalePolls: consecutiveStalePolls,
        timeSinceLastFresh: Math.floor((Date.now() - lastFreshDataTimestamp) / 1000) + 's'
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Debug endpoint
app.get('/api/debug', (req, res) => {
    res.json({
        deviceOnline: isDeviceOnline,
        lastUptime: lastUptimeValue,
        cache: deviceDataCache,
        lastFreshData: new Date(lastFreshDataTimestamp).toISOString(),
        consecutiveStalePolls: consecutiveStalePolls,
        currentPollingRate: currentPollingRate === POLLING_RATE_ONLINE ? '5 seconds' : '15 minutes',
        connectedClients: wss.clients.size,
        timeSinceLastFresh: Math.floor((Date.now() - lastFreshDataTimestamp) / 1000) + ' seconds'
    });
});

// Server initialization
const server = app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║   EvaraTap Server v3.0 - Smart Polling        ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📍 Access: http://localhost:${PORT}`);
    console.log(`⚡ Online polling: ${POLLING_RATE_ONLINE/1000}s`);
    console.log(`🐢 Offline polling: ${POLLING_RATE_OFFLINE/60000}min`);
    console.log(`🛡️  Grace period: ${STALE_UPTIME_GRACE_POLLS} stale polls\n`);
    
    pollBlynkData();
});

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`✅ Client connected: ${clientIP}`);
    
    // Send initial state with online status
    const initialMessage = JSON.stringify({
        type: 'initial-state',
        payload: deviceDataCache,
        timestamp: Date.now(),
        isOnline: isDeviceOnline
    });
    ws.send(initialMessage);
    
    ws.on('close', () => {
        console.log(`❌ Client disconnected: ${clientIP}`);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\nSIGTERM received, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
