const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();
const PORT = process.env.PORT || 3000;

// ---- Crash hardening for Railway ----
// Railway sends a "deployment crashed" notification any time the
// container's main process exits with non-zero. Two unrelated
// problems were causing those notifications on this app:
//
//  1. The previous deployment's container is replaced by Railway
//     during a release. The OLD container receives SIGTERM and
//     exits ~immediately because Node's default SIGTERM handler
//     is process.exit(143). Railway then logs "Deploy crashed"
//     for the retiring container even though the swap was clean.
//     We add an explicit SIGTERM handler that closes the HTTP
//     server gracefully and exits with code 0 — so Railway sees
//     a clean shutdown instead of a crash.
//
//  2. An unhandled exception inside one of the async leaderboard
//     handlers (e.g. fs.writeFileSync throwing on a flaky volume
//     mount) propagated up and killed the process. We install
//     `process.on('uncaughtException'/'unhandledRejection')`
//     handlers that log and CONTINUE rather than crash. This is
//     intentional — for a static-asset + tiny-API server,
//     persistent error spam is preferable to repeated restarts
//     and a noisy notification stream.
process.on("uncaughtException", (err) => {
  console.error("[wbcgamez] uncaughtException:", err && err.stack || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[wbcgamez] unhandledRejection:", reason);
});

// JSON body parsing for API
app.use(express.json());

// Lightweight health endpoint for Railway's healthcheck. Returns
// 200 OK in <1ms regardless of leaderboard state. Without this,
// the platform's default healthcheck path (/) returns the SPA
// index.html which is fine HTTP-wise but is many KB and incurs
// a disk read each tick.
app.get("/health", (req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// ---- Password-protected routes (beta/testing games) ----
// (No protected paths right now — /30 is public as of v89 now that the
// online multiplayer runs through the Ladybug Gamez WebSocket hub.)
const BETA_PASSWORD = process.env.BETA_PASSWORD || "test123";
const BETA_PATHS = [];

app.use((req, res, next) => {
  const isProtected = BETA_PATHS.some(p => req.path === p || req.path.startsWith(p + "/"));
  if (!isProtected) return next();
  const auth = req.headers.authorization;
  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic") {
      const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
      if (pass === BETA_PASSWORD) return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Beta Access"');
  res.status(401).send("Password required");
});

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
  try {
    ensureDataDir();
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(board, null, 2), "utf8");
    return true;
  } catch (e) {
    // Volume mount may fail intermittently — log and signal
    // failure to the caller instead of throwing all the way up
    // to the Express stack (which would 500 the request and
    // potentially kill the process if uncaught upstream).
    console.warn("Failed to write leaderboard:", e.message);
    return false;
  }
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
  const ok = writeLeaderboard(trimmed);
  if (!ok) {
    return res.status(503).json({ error: "Leaderboard storage unavailable" });
  }
  res.json({ success: true, leaderboard: sorted.slice(0, LEADERBOARD_MAX) });
});

// DELETE /api/soloterra/leaderboard — wipe all entries
app.delete("/api/soloterra/leaderboard", (req, res) => {
  const ok = writeLeaderboard([]);
  if (!ok) {
    return res.status(503).json({ error: "Leaderboard storage unavailable" });
  }
  res.json({ success: true, message: "Leaderboard wiped" });
});

// Fallback to index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Log data location on startup
ensureDataDir();
console.log(`Leaderboard data: ${LEADERBOARD_FILE}`);

const httpServer = app.listen(PORT, () => {
  console.log(`WBC Gamez running on port ${PORT}`);
});

// Graceful shutdown. Railway sends SIGTERM to the retiring
// container during a deploy; we close the HTTP server cleanly
// and exit 0 so the platform doesn't log the rotation as a
// crash. 5s grace before force-exit so any in-flight request
// has a chance to drain.
function gracefulShutdown(signal) {
  console.log(`[wbcgamez] received ${signal}, shutting down`);
  httpServer.close(() => {
    console.log("[wbcgamez] HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => {
    console.warn("[wbcgamez] force exit after 5s grace period");
    process.exit(0);
  }, 5000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
