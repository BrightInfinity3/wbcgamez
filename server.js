const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3000;

// JSON body parsing for API
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, "public")));

// ---- SoloTerra Leaderboard API ----
// Use RAILWAY_VOLUME_MOUNT_PATH if a persistent volume is attached, otherwise fall back to ./data
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "soloterra")
  : path.join(__dirname, "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "soloterra-leaderboard.json");
const LEADERBOARD_MAX = 60;

// Ensure data directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readLeaderboard() {
  try {
    if (!fs.existsSync(LEADERBOARD_FILE)) return [];
    const raw = fs.readFileSync(LEADERBOARD_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to read leaderboard:", e.message);
    return [];
  }
}

function writeLeaderboard(board) {
  ensureDataDir();
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(board, null, 2), "utf8");
}

function sortLeaderboard(board) {
  // Score desc → moves asc → most recent first
  board.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.moves !== b.moves) return a.moves - b.moves;
    return b.timestamp - a.timestamp;
  });
  return board;
}

// GET /api/soloterra/leaderboard
app.get("/api/soloterra/leaderboard", (req, res) => {
  const board = readLeaderboard();
  res.json(sortLeaderboard(board).slice(0, LEADERBOARD_MAX));
});

// POST /api/soloterra/leaderboard
app.post("/api/soloterra/leaderboard", (req, res) => {
  const { name, score, moves } = req.body;

  // Validate
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "Name is required" });
  }
  if (typeof score !== "number" || score < 0 || score > 60) {
    return res.status(400).json({ error: "Invalid score" });
  }
  if (typeof moves !== "number" || moves < 1 || moves > 9999) {
    return res.status(400).json({ error: "Invalid moves" });
  }

  const board = readLeaderboard();
  board.push({
    name: name.trim().substring(0, 20),
    score: score,
    moves: moves,
    timestamp: Date.now()
  });

  const sorted = sortLeaderboard(board);
  // Keep top entries (with some buffer beyond display max)
  const trimmed = sorted.slice(0, LEADERBOARD_MAX * 2);
  writeLeaderboard(trimmed);

  res.json({ success: true, leaderboard: sorted.slice(0, LEADERBOARD_MAX) });
});

// DELETE /api/soloterra/leaderboard — wipe all entries
app.delete("/api/soloterra/leaderboard", (req, res) => {
  writeLeaderboard([]);
  res.json({ success: true, message: "Leaderboard wiped" });
});

// Fallback to index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Log data location on startup
ensureDataDir();
console.log(`Leaderboard data: ${LEADERBOARD_FILE}`);

app.listen(PORT, () => {
  console.log(`WBC Gamez running on port ${PORT}`);
});
