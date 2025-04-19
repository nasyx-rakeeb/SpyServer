// downloadsManager.js

const express = require("express");
const path = require("path");
const fs = require("fs");
const archiver = require("archiver");

const router = express.Router();
const downloadsDir = path.join(__dirname, "public", "downloads");

// Helper to format file/folder stats
function getDirectoryContents(targetPath) {
  const items = [];
  const files = fs.readdirSync(targetPath);

  files.forEach(name => {
    const fullPath = path.join(targetPath, name);
    const stats = fs.statSync(fullPath);

    items.push({
      name,
      type: stats.isDirectory() ? "directory" : "file",
      size: stats.size,
      lastModified: stats.mtime,
      path: path.relative(downloadsDir, fullPath)
    });
  });

  return items;
}

// List contents of downloads directory (or subdir)
router.get("/downloads-explorer", (req, res) => {
  const relPath = req.query.path || "";
  const targetPath = path.join(downloadsDir, relPath);

  if (!targetPath.startsWith(downloadsDir)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: "Path does not exist" });
    }

    const items = getDirectoryContents(targetPath);
    res.json({ path: relPath, items });
  } catch (err) {
    console.error("Error reading directory:", err);
    res.status(500).json({ error: "Failed to read directory" });
  }
});

// Serve file previews (image/audio/video only)
router.get("/preview", (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).send("Missing path");

  const absPath = path.join(downloadsDir, relPath);
  if (!absPath.startsWith(downloadsDir) || !fs.existsSync(absPath)) {
    return res.status(403).send("Invalid or missing file");
  }

  const ext = path.extname(absPath).toLowerCase();
  const mediaTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg"
  };

  if (!mediaTypes[ext]) {
    return res.status(415).send("Unsupported preview type");
  }

  res.setHeader("Content-Type", mediaTypes[ext]);
  fs.createReadStream(absPath).pipe(res);
});

// Download single file
router.get("/downloadFile", (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).send("Missing path");

  const absPath = path.join(downloadsDir, relPath);
  if (!absPath.startsWith(downloadsDir) || !fs.existsSync(absPath)) {
    return res.status(403).send("Invalid path");
  }

  res.download(absPath);
});

// Delete file or folder
router.delete("/downloads-delete", express.json(), (req, res) => {
  const { path: relPath } = req.body;
  if (!relPath) return res.status(400).json({ error: "Missing path" });

  const absPath = path.join(downloadsDir, relPath);

  if (!absPath.startsWith(downloadsDir)) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: "Not found" });
    }

    const stats = fs.statSync(absPath);
    if (stats.isDirectory()) {
      fs.rmSync(absPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(absPath);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

module.exports = router;
