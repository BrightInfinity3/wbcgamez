/* ============================================================
   SoloTerra - Save/Load System
   localStorage persistence for solitaire game state
   ============================================================ */

var SaveSystem = (function () {
  'use strict';

  var SAVE_KEY = 'soloterra_game_save';
  var PREFS_KEY = 'soloterra_suit_prefs';

  function saveGame() {
    try {
      var data = {
        version: 1,
        gameState: Game.serialize(),
        timestamp: Date.now()
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Save failed:', e);
    }
  }

  function loadGame() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data.version !== 1) return null;
      return data;
    } catch (e) {
      console.warn('Load failed:', e);
      return null;
    }
  }

  function hasSave() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      return data && data.version === 1 && data.gameState && !data.gameState.gameOver;
    } catch (e) {
      return false;
    }
  }

  function clearSave() {
    localStorage.removeItem(SAVE_KEY);
  }

  function getSaveTimestamp() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data.timestamp || null;
    } catch (e) {
      return null;
    }
  }

  function timeAgo(timestamp) {
    if (!timestamp) return '';
    var diff = Date.now() - timestamp;
    var minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  function saveSuitPrefs(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (e) {
      console.warn('Suit prefs save failed:', e);
    }
  }

  function loadSuitPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // ---- Leaderboard ----
  var LEADERBOARD_KEY = 'soloterra_leaderboard';
  var LEADERBOARD_MAX = 60;

  function getLeaderboard() {
    try {
      var raw = localStorage.getItem(LEADERBOARD_KEY);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }

  function addLeaderboardEntry(name, score, moves) {
    var board = getLeaderboard();
    board.push({
      name: name,
      score: score,
      moves: moves,
      timestamp: Date.now()
    });
    // Sort: score desc, then moves asc, then most recent first
    board.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.moves !== b.moves) return a.moves - b.moves;
      return b.timestamp - a.timestamp;
    });
    // Keep all entries but display only top 60
    localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(board));
    return board;
  }

  return {
    saveGame: saveGame,
    loadGame: loadGame,
    hasSave: hasSave,
    clearSave: clearSave,
    getSaveTimestamp: getSaveTimestamp,
    timeAgo: timeAgo,
    saveSuitPrefs: saveSuitPrefs,
    loadSuitPrefs: loadSuitPrefs,
    getLeaderboard: getLeaderboard,
    addLeaderboardEntry: addLeaderboardEntry,
    LEADERBOARD_MAX: LEADERBOARD_MAX
  };
})();
