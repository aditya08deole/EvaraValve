/**
 * EvaraTap Secure Backend for Blynk on Render
 *
 * This server acts as a secure proxy between the public dashboard
 * and the Blynk API. The BLYNK_AUTH_TOKEN is kept secure on the server
 * and is never exposed to the client-side browser.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch'; // node-fetch is needed for making API requests in Node.js

const app = express();
const PORT = process.env.PORT || 10000;

// --- IMPORTANT: SET THESE IN YOUR RENDER ENVIRONMENT VARIABLES ---
const BLYNK_AUTH_TOKEN = process.env.BLYNK_AUTH_TOKEN;
const BLYNK_API_BASE = 'https://blynk.cloud/external/api';

// --- VALIDATION ---
if (!BLYNK_AUTH_TOKEN) {
    console.error('❌ CRITICAL ERROR: BLYNK_AUTH_TOKEN is not set in the environment variables.');
    process.exit(1); // Stop the server if the token is missing
}

// --- EXPRESS CONFIGURATION ---
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// --- API ENDPOINTS ---

// Endpoint for the dashboard to get data from multiple Blynk pins
app.get('/api/get-pins', async (req, res) => {
    // req.query.pins should be a string like "v0,v1,v2"
    if (!req.query.pins) {
        return res.status(400).json({ error: 'Pins query parameter is required.' });
    }
    const pins = req.query.pins.split(',');
    const pinParams = pins.join('&');

    try {
        const url = `${BLYNK_API_BASE}/get?token=${BLYNK_AUTH_TOKEN}&${pinParams}`;
        const blynkResponse = await fetch(url);

        if (!blynkResponse.ok) {
            throw new Error(`Blynk API responded with status: ${blynkResponse.status}`);
        }
        
        const data = await blynkResponse.json();
        res.status(200).json(data);

    } catch (error) {
        console.error('Error fetching from Blynk API:', error.message);
        res.status(500).json({ error: 'Failed to fetch data from Blynk.' });
    }
});

// Endpoint for the dashboard to update a Blynk pin value
app.post('/api/update-pin', async (req, res) => {
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

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});

// Serve the main dashboard page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 EvaraTap Blynk Server is running on port ${PORT}`);
    console.log(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
});
