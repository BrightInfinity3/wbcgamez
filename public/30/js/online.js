/* ============================================================
   30 - Online Multiplayer Module
   Lobby management, game sync, host/guest coordination
   ============================================================ */

var Online = (function () {
  'use strict';

  // ---- Constants ----
  var SEAT_FILL_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
  var NUM_SEATS = 8;

  // Nickname arrays matching ui.js — pick randomly
  var NICKNAMES = {
    bear:['Bruno','Grizzly','Kodiak'], cat:['Shadow','Mittens','Whiskers'],
    owl:['Hoot','Sage','Luna'], penguin:['Waddles','Tux','Frost'],
    raccoon:['Bandit','Rascal','Stripe'], frog:['Ribbit','Lily','Marsh'],
    dog:['Buddy','Rex','Scout'], panda:['Bamboo','Oreo','Patches'],
    monkey:['Coco','Chip','Mango'], deer:['Dasher','Fawn','Buck'],
    hedgehog:['Spike','Bramble','Thistle'], shark:['Finn','Jaws','Reef'],
    octopus:['Inky','Coral','Squid'], hamster:['Nibbles','Peanut','Biscuit'],
    parrot:['Polly','Stella','Rio'], turtle:['Shelly','Mossy','Tank'],
    goat:['Billy','Cliffs','Bleat'], spider:['Webster','Silk','Fang'],
    ladybug:['Dotty','Pepper','Ruby'], bee:['Buzz','Abby','Nectar'],
    crocodile:['Snappy','Chomp','Marsh'], dolphin:['Splash','Snowflake','Echo'],
    rabbit:['Clover','Hopper','Thumper'], dodo:['Doodle','Pebble','Waddle']
  };
  function pickNickname(animal) {
    var arr = NICKNAMES[animal];
    return arr ? arr[Math.floor(Math.random() * arr.length)] : animal;
  }

  // ---- State ----
  var active = false;        // online mode active?
  var _isHost = false;
  var myDeviceId = '';       // PeerJS peer ID
  var myUsername = '';
  var gamePhase = 'lobby';   // 'lobby' | 'playing' | 'results'

  // Lobby state (host is authoritative, guests receive copies)
  var lobbyState = {
    roomCode: '',
    seats: [],              // 8 seats: { occupied, animal, name, isHuman, isAI, deviceId }
    devices: {},            // peerId -> { username, playerCount, isHost }
  };

  // Pending join requests (host only)
  var pendingRequests = [];  // [{ peerId, username, playerCount }]

  // ---- Initialize ----
  function initLobbyState() {
    lobbyState.seats = [];
    for (var i = 0; i < NUM_SEATS; i++) {
      lobbyState.seats.push({
        occupied: false,
        animal: null,
        name: '',
        isHuman: false,
        isAI: false,
        deviceId: null
      });
    }
    lobbyState.devices = {};
    pendingRequests = [];
  }

  // ---- Get next N available seats in fill order ----
  function getNextSeats(count) {
    var seats = [];
    for (var i = 0; i < SEAT_FILL_ORDER.length && seats.length < count; i++) {
      if (!lobbyState.seats[SEAT_FILL_ORDER[i]].occupied) {
        seats.push(SEAT_FILL_ORDER[i]);
      }
    }
    return seats;
  }

  // ---- Count total players ----
  function totalPlayerCount() {
    var count = 0;
    for (var i = 0; i < NUM_SEATS; i++) {
      if (lobbyState.seats[i].occupied) count++;
    }
    return count;
  }

  // ---- Count human players from a device ----
  function devicePlayerCount(deviceId) {
    var count = 0;
    for (var i = 0; i < NUM_SEATS; i++) {
      if (lobbyState.seats[i].deviceId === deviceId) count++;
    }
    return count;
  }

  // ---- Get seat indices owned by a device ----
  function deviceSeatIndices(deviceId) {
    var seats = [];
    for (var i = 0; i < NUM_SEATS; i++) {
      if (lobbyState.seats[i].deviceId === deviceId) seats.push(i);
    }
    return seats;
  }

  // ---- Assign players to seats ----
  function assignPlayersToSeats(deviceId, username, count) {
    var seats = getNextSeats(count);
    var animals = SpriteEngine.getAnimalList();
    var usedAnimals = lobbyState.seats
      .filter(function (s) { return s.occupied && s.animal; })
      .map(function (s) { return s.animal; });

    for (var i = 0; i < seats.length; i++) {
      var seatIdx = seats[i];
      // Pick unused animal
      var available = animals.filter(function (a) { return usedAnimals.indexOf(a) === -1; });
      if (available.length === 0) available = animals;
      var animal = available[Math.floor(Math.random() * available.length)];
      usedAnimals.push(animal);

      lobbyState.seats[seatIdx] = {
        occupied: true,
        animal: animal,
        name: pickNickname(animal),
        isHuman: true,
        isAI: false,
        deviceId: deviceId
      };
    }
    return seats;
  }

  // ---- Remove all players from a device ----
  function removeDevicePlayers(deviceId) {
    for (var i = 0; i < NUM_SEATS; i++) {
      if (lobbyState.seats[i].deviceId === deviceId) {
        lobbyState.seats[i] = {
          occupied: false, animal: null, name: '',
          isHuman: false, isAI: false, deviceId: null
        };
      }
    }
    delete lobbyState.devices[deviceId];
  }

  // ======== HOST FUNCTIONS ========

  function hostGame(username, playerCount) {
    active = true;
    _isHost = true;
    gamePhase = 'lobby';
    initLobbyState();

    return Network.createRoom().then(function (code) {
      lobbyState.roomCode = code;
      myDeviceId = Network.getMyPeerId();
      myUsername = username;

      lobbyState.devices[myDeviceId] = {
        username: username,
        playerCount: playerCount,
        isHost: true
      };

      assignPlayersToSeats(myDeviceId, username, playerCount);

      // Set up network handlers
      Network.onConnect(function (peerId) {
        // New connection — wait for join_request message
      });

      Network.onMessage(handleHostMessage);
      Network.onDisconnect(handleGuestDisconnect);

      // Reconnection handler — guest came back during grace period
      Network.onReconnect(function (peerId) {
        console.log('[Online] Guest reconnected:', peerId);
        // They're still in our lobby/game state — just re-sync them
        if (gamePhase === 'lobby') {
          Network.send(peerId, { type: 'lobby_state', data: lobbyState });
        } else if (gamePhase === 'playing') {
          // Re-sync full game state
          Network.send(peerId, {
            type: 'game_state_sync',
            data: { gameState: Game.serialize() }
          });
        }
      });

      return code;
    });
  }

  function handleHostMessage(fromPeerId, message) {
    switch (message.type) {
      case 'join_request':
        handleJoinRequest(fromPeerId, message.data);
        break;
      case 'change_name':
        handleRemoteChangeName(fromPeerId, message.data);
        break;
      case 'change_animal':
        handleRemoteChangeAnimal(fromPeerId, message.data);
        break;
      case 'swap_seat':
        handleRemoteSwapSeat(fromPeerId, message.data);
        break;
      case 'player_action':
        handleRemoteAction(message.data);
        break;
      case 'leave':
        handleGuestLeave(fromPeerId);
        break;
      case 'rejoin':
        handleGuestRejoin(fromPeerId, message.data);
        break;
    }
  }

  function handleGuestRejoin(peerId, data) {
    console.log('[Online] Guest rejoin:', data.username);
    // Guest reconnected — update their connection mapping
    // Their seats still exist from before, just re-map deviceId if peer changed
    var oldDeviceId = data.deviceId;
    if (oldDeviceId !== peerId && lobbyState.devices[oldDeviceId]) {
      // Peer ID changed — remap
      lobbyState.devices[peerId] = lobbyState.devices[oldDeviceId];
      delete lobbyState.devices[oldDeviceId];
      for (var i = 0; i < NUM_SEATS; i++) {
        if (lobbyState.seats[i].deviceId === oldDeviceId) {
          lobbyState.seats[i].deviceId = peerId;
        }
      }
    }

    // Re-sync state
    if (gamePhase === 'lobby') {
      Network.send(peerId, { type: 'lobby_state', data: lobbyState });
      renderOnlineLobby();
    } else if (gamePhase === 'playing') {
      Network.send(peerId, {
        type: 'game_state_sync',
        data: { gameState: Game.serialize() }
      });
    }
  }

  function handleJoinRequest(peerId, data) {
    var totalAfter = totalPlayerCount() + data.playerCount;
    if (totalAfter > 8) {
      Network.send(peerId, {
        type: 'join_response',
        data: { approved: false, reason: 'Too many players (max 8). Only ' + (8 - totalPlayerCount()) + ' slots available.' }
      });
      return;
    }
    // Add to pending — show popup to host
    pendingRequests.push({
      peerId: peerId,
      username: data.username,
      playerCount: data.playerCount
    });
    renderJoinRequests();
  }

  function approveGuest(peerId) {
    var request = null;
    for (var i = 0; i < pendingRequests.length; i++) {
      if (pendingRequests[i].peerId === peerId) {
        request = pendingRequests.splice(i, 1)[0];
        break;
      }
    }
    if (!request) return;

    // Check still enough room
    if (totalPlayerCount() + request.playerCount > 8) {
      Network.send(peerId, {
        type: 'join_response',
        data: { approved: false, reason: 'Not enough seats available anymore.' }
      });
      renderJoinRequests();
      return;
    }

    // Defensive: make sure we haven't already assigned seats for this peer.
    // If they somehow re-sent a join_request while already approved, don't
    // double-assign or wipe their existing seats — just re-send the current
    // state so they can catch up.
    if (lobbyState.devices[peerId]) {
      console.warn('[Online] approveGuest: peer already registered, re-syncing:', peerId);
      Network.send(peerId, {
        type: 'join_response',
        data: { approved: true, deviceId: peerId }
      });
      broadcastLobbyState();
      renderJoinRequests();
      return;
    }

    console.log('[Online] Approving guest:', request.username, 'peerId:', peerId, 'players:', request.playerCount);
    console.log('[Online] Lobby BEFORE approve:', totalPlayerCount(), 'players');

    // Register device
    lobbyState.devices[peerId] = {
      username: request.username,
      playerCount: request.playerCount,
      isHost: false
    };

    // Assign seats
    var assigned = assignPlayersToSeats(peerId, request.username, request.playerCount);
    console.log('[Online] Assigned', request.username, 'to seats:', assigned);
    console.log('[Online] Lobby AFTER approve:', totalPlayerCount(), 'players');

    // Notify guest
    Network.send(peerId, {
      type: 'join_response',
      data: { approved: true, deviceId: peerId }
    });

    // Broadcast updated lobby
    broadcastLobbyState();
    renderOnlineLobby();
    renderJoinRequests();
  }

  function denyGuest(peerId) {
    for (var i = 0; i < pendingRequests.length; i++) {
      if (pendingRequests[i].peerId === peerId) {
        pendingRequests.splice(i, 1);
        break;
      }
    }
    Network.send(peerId, {
      type: 'join_response',
      data: { approved: false, reason: 'Host denied your request.' }
    });
    renderJoinRequests();
  }

  function handleRemoteChangeName(fromPeerId, data) {
    var seat = lobbyState.seats[data.seatIndex];
    if (seat && seat.deviceId === fromPeerId) {
      seat.name = data.name;
      broadcastLobbyState();
      renderOnlineLobby();
    }
  }

  function handleRemoteChangeAnimal(fromPeerId, data) {
    var seat = lobbyState.seats[data.seatIndex];
    if (!seat || seat.deviceId !== fromPeerId) return;
    // Check animal not taken
    var taken = lobbyState.seats.some(function (s, idx) {
      return s.occupied && s.animal === data.animal && idx !== data.seatIndex;
    });
    if (taken) return;
    seat.animal = data.animal;
    broadcastLobbyState();
    renderOnlineLobby();
  }

  function handleRemoteSwapSeat(fromPeerId, data) {
    // Guest can only move their own player to an open seat
    var fromSeat = lobbyState.seats[data.fromSeat];
    if (!fromSeat || fromSeat.deviceId !== fromPeerId) return;
    var toSeat = lobbyState.seats[data.toSeat];
    if (toSeat.occupied) return; // guests can't swap with occupied seats
    // Move
    lobbyState.seats[data.toSeat] = fromSeat;
    lobbyState.seats[data.fromSeat] = {
      occupied: false, animal: null, name: '',
      isHuman: false, isAI: false, deviceId: null
    };
    broadcastLobbyState();
    renderOnlineLobby();
  }

  function handleRemoteAction(data) {
    // Process a game action from a guest's player
    if (typeof onActionCallback === 'function') {
      onActionCallback(data);
    }
  }

  function handleGuestDisconnect(peerId) {
    if (gamePhase === 'lobby') {
      // Just remove their players
      removeDevicePlayers(peerId);
      // Remove pending request if any
      pendingRequests = pendingRequests.filter(function (r) { return r.peerId !== peerId; });
      broadcastLobbyState();
      renderOnlineLobby();
      renderJoinRequests();
    } else {
      // During game or results — disband
      var device = lobbyState.devices[peerId];
      var username = device ? device.username : 'A player';
      disbandRoom(username + ' has left the game. Please create a new room to continue playing.');
    }
  }

  function handleGuestLeave(peerId) {
    handleGuestDisconnect(peerId);
  }

  // ---- Host: Add AI to a seat ----
  function addAI(seatIdx) {
    if (!_isHost || lobbyState.seats[seatIdx].occupied) return;
    var animals = SpriteEngine.getAnimalList();
    var usedAnimals = lobbyState.seats
      .filter(function (s) { return s.occupied && s.animal; })
      .map(function (s) { return s.animal; });
    var available = animals.filter(function (a) { return usedAnimals.indexOf(a) === -1; });
    if (available.length === 0) available = animals;
    var animal = available[Math.floor(Math.random() * available.length)];

    lobbyState.seats[seatIdx] = {
      occupied: true,
      animal: animal,
      name: pickNickname(animal),
      isHuman: false,
      isAI: true,
      deviceId: null
    };
    broadcastLobbyState();
    renderOnlineLobby();
  }

  // ---- Host: Remove a player/AI from a seat ----
  function removeFromSeat(seatIdx) {
    if (!_isHost) return;
    var seat = lobbyState.seats[seatIdx];
    if (!seat.occupied) return;
    // If it's a human from a device, remove that player
    if (seat.deviceId) {
      var dev = lobbyState.devices[seat.deviceId];
      if (dev) dev.playerCount--;
    }
    lobbyState.seats[seatIdx] = {
      occupied: false, animal: null, name: '',
      isHuman: false, isAI: false, deviceId: null
    };
    broadcastLobbyState();
    renderOnlineLobby();
  }

  // ---- Host: Swap two seats ----
  function swapSeats(seatA, seatB) {
    if (!_isHost) return;
    var temp = lobbyState.seats[seatA];
    lobbyState.seats[seatA] = lobbyState.seats[seatB];
    lobbyState.seats[seatB] = temp;
    broadcastLobbyState();
    renderOnlineLobby();
  }

  // ---- Host: Start the game ----
  function startOnlineGame() {
    if (!_isHost) return;
    var count = totalPlayerCount();
    if (count < 2) return;

    gamePhase = 'playing';

    // Build player list from lobby seats
    var players = [];
    var dealerIdx = 0;
    var id = 0;
    for (var i = 0; i < NUM_SEATS; i++) {
      var seat = lobbyState.seats[i];
      if (!seat.occupied) continue;
      var p = Game.createPlayer(id, i, seat.animal, seat.name, seat.isHuman, false);
      // Store deviceId mapping for later
      p.deviceId = seat.deviceId;
      p.isAI = seat.isAI;
      players.push(p);
      id++;
    }

    Game.setupGame(players, 0);

    // Broadcast game start with player list
    Network.broadcast({
      type: 'game_starting',
      data: {
        players: players,
        lobbyState: lobbyState
      }
    });

    // Trigger the UI to begin the round
    if (typeof onGameStartCallback === 'function') {
      onGameStartCallback(players);
    }
  }

  // ---- Host: Broadcast lobby state to all guests ----
  // Deep-clones lobbyState before sending so the object that reaches the
  // PeerJS JSON serializer is immutable relative to our own state. Without
  // this, a subsequent host-side mutation (e.g. another guest joining
  // mid-serialization) could in theory race with the serializer. Also
  // helpful for diagnosing races — we log the seat occupants on each
  // broadcast so the host console shows exactly what each guest receives.
  function broadcastLobbyState() {
    var snapshot = JSON.parse(JSON.stringify(lobbyState));
    if (typeof console !== 'undefined' && console.log) {
      var occ = snapshot.seats.map(function (s, i) {
        return s.occupied ? (i + ':' + (s.isAI ? 'AI' : (s.deviceId || '?').slice(-4)) + '/' + s.name) : null;
      }).filter(Boolean);
      console.log('[Online] Broadcasting lobby state — seats:', occ.join(', '));
    }
    Network.broadcast({
      type: 'lobby_state',
      data: snapshot
    });
  }

  // ---- Disband room ----
  function disbandRoom(message) {
    Network.broadcast({
      type: 'room_disbanded',
      data: { message: message }
    });
    cleanup();
    showDisbandMessage(message);
  }

  // ======== GUEST FUNCTIONS ========

  function joinGame(code, username, playerCount) {
    active = true;
    _isHost = false;
    myUsername = username;
    gamePhase = 'lobby';

    return Network.joinRoom(code).then(function () {
      myDeviceId = Network.getMyPeerId();

      // Set up message handler
      Network.onMessage(handleGuestMessage);
      Network.onDisconnect(function () {
        // Host disconnected — after grace period expired in network layer
        showDisbandMessage('Lost connection to host. Please create a new room to continue playing.');
        cleanup();
      });

      // Reconnection handler — guest reconnected to host after brief disconnect
      Network.onReconnect(function () {
        console.log('[Online] Guest reconnected to host, re-announcing...');
        // Re-send join request so host knows we're back
        Network.send('host', {
          type: 'rejoin',
          data: {
            username: myUsername,
            deviceId: myDeviceId,
            playerCount: playerCount
          }
        });
      });

      // Send join request
      Network.send('host', {
        type: 'join_request',
        data: {
          username: username,
          playerCount: playerCount
        }
      });
    });
  }

  function handleGuestMessage(fromId, message) {
    switch (message.type) {
      case 'join_response':
        handleJoinResponse(message.data);
        break;
      case 'lobby_state':
        lobbyState = message.data;
        renderOnlineLobby();
        break;
      case 'game_starting':
        handleGameStarting(message.data);
        break;
      case 'game_action':
        handleGameAction(message.data);
        break;
      case 'game_state_sync':
        handleGameStateSync(message.data);
        break;
      case 'room_disbanded':
        showDisbandMessage(message.data.message);
        cleanup();
        break;
    }
  }

  var joinResponseCallback = null;

  function handleJoinResponse(data) {
    if (data.approved) {
      myDeviceId = data.deviceId || Network.getMyPeerId();
      if (joinResponseCallback) joinResponseCallback(true, null);
    } else {
      if (joinResponseCallback) joinResponseCallback(false, data.reason);
    }
  }

  function onJoinResponse(callback) {
    joinResponseCallback = callback;
  }

  function handleGameStarting(data) {
    gamePhase = 'playing';
    // Rebuild game state from host's data
    var players = data.players;
    Game.setupGame(players, 0);
    lobbyState = data.lobbyState;

    if (typeof onGameStartCallback === 'function') {
      onGameStartCallback(players);
    }
  }

  function handleGameAction(data) {
    // Host sent a game action to replay (draw/stay/deal/etc.)
    if (typeof onGameActionCallback === 'function') {
      onGameActionCallback(data);
    }
  }

  function handleGameStateSync(data) {
    if (typeof onGameStateSyncCallback === 'function') {
      onGameStateSyncCallback(data);
    }
  }

  // ---- Guest: Send action to host ----
  function sendAction(playerId, action) {
    Network.send('host', {
      type: 'player_action',
      data: { playerId: playerId, action: action }
    });
  }

  // ---- Guest: Change own player's name ----
  function sendChangeName(seatIndex, name) {
    if (_isHost) {
      lobbyState.seats[seatIndex].name = name;
      broadcastLobbyState();
      renderOnlineLobby();
    } else {
      Network.send('host', {
        type: 'change_name',
        data: { seatIndex: seatIndex, name: name }
      });
    }
  }

  // ---- Guest: Change own player's animal ----
  function sendChangeAnimal(seatIndex, animal) {
    if (_isHost) {
      var taken = lobbyState.seats.some(function (s, idx) {
        return s.occupied && s.animal === animal && idx !== seatIndex;
      });
      if (taken) return;
      lobbyState.seats[seatIndex].animal = animal;
      broadcastLobbyState();
      renderOnlineLobby();
    } else {
      Network.send('host', {
        type: 'change_animal',
        data: { seatIndex: seatIndex, animal: animal }
      });
    }
  }

  // ---- Guest: Move own player to open seat ----
  function sendSwapSeat(fromSeat, toSeat) {
    if (_isHost) {
      swapSeats(fromSeat, toSeat);
    } else {
      Network.send('host', {
        type: 'swap_seat',
        data: { fromSeat: fromSeat, toSeat: toSeat }
      });
    }
  }

  // ---- Leave room ----
  function leaveRoom() {
    if (_isHost) {
      if (gamePhase === 'lobby') {
        disbandRoom(myUsername + ' has left the game. Please create a new room to continue playing.');
      } else {
        disbandRoom(myUsername + ' has left the game. Please create a new room to continue playing.');
      }
    } else {
      Network.send('host', { type: 'leave', data: {} });
      cleanup();
    }
  }

  // ======== RENDERING (delegates to UI) ========

  var renderLobbyCallback = null;
  function onRenderLobby(cb) { renderLobbyCallback = cb; }

  function renderOnlineLobby() {
    // Update room info
    var codeEl = document.getElementById('online-room-code');
    if (codeEl) codeEl.textContent = lobbyState.roomCode;

    var countEl = document.getElementById('online-player-count');
    if (countEl) countEl.textContent = totalPlayerCount() + '/8 Players';

    // Deal button (host only)
    var dealBtn = document.getElementById('btn-online-deal');
    if (dealBtn) {
      dealBtn.style.display = _isHost ? '' : 'none';
      dealBtn.disabled = totalPlayerCount() < 2;
    }

    // Delegate seat rendering to UI
    if (typeof renderLobbyCallback === 'function') {
      renderLobbyCallback();
    }
  }

  function renderJoinRequests() {
    var container = document.getElementById('join-requests');
    if (!container) return;

    if (pendingRequests.length === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'flex';
    var list = container.querySelector('.join-request-list');
    if (!list) return;
    list.innerHTML = '';

    for (var i = 0; i < pendingRequests.length; i++) {
      var req = pendingRequests[i];
      var el = document.createElement('div');
      el.className = 'join-request-item';

      var info = document.createElement('div');
      info.className = 'join-request-info';
      info.innerHTML = '<strong>' + req.username + '</strong> wants to join with <strong>' + req.playerCount + '</strong> player' + (req.playerCount > 1 ? 's' : '');
      el.appendChild(info);

      var slotsLeft = 8 - totalPlayerCount();
      if (req.playerCount > slotsLeft) {
        var warning = document.createElement('div');
        warning.className = 'join-request-warning';
        warning.textContent = 'Not enough slots (' + slotsLeft + ' available)';
        el.appendChild(warning);
      }

      var buttons = document.createElement('div');
      buttons.className = 'join-request-buttons';

      var approveBtn = document.createElement('button');
      approveBtn.className = 'btn btn-gold btn-sm';
      approveBtn.textContent = 'Allow';
      approveBtn.disabled = req.playerCount > slotsLeft;
      approveBtn.addEventListener('click', (function (peerId) {
        return function () { approveGuest(peerId); };
      })(req.peerId));
      buttons.appendChild(approveBtn);

      var denyBtn = document.createElement('button');
      denyBtn.className = 'btn btn-outline btn-sm';
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', (function (peerId) {
        return function () { denyGuest(peerId); };
      })(req.peerId));
      buttons.appendChild(denyBtn);

      el.appendChild(buttons);
      list.appendChild(el);
    }
  }

  function showDisbandMessage(message) {
    var overlay = document.getElementById('disband-overlay');
    if (overlay) {
      overlay.querySelector('.disband-message').textContent = message;
      overlay.style.display = 'flex';
    }
  }

  // ======== CALLBACKS ========

  var onGameStartCallback = null;
  var onActionCallback = null;
  var onGameActionCallback = null;
  var onGameStateSyncCallback = null;

  function onGameStart(cb) { onGameStartCallback = cb; }
  function onAction(cb) { onActionCallback = cb; }
  function onGameAction(cb) { onGameActionCallback = cb; }
  function onGameStateSync(cb) { onGameStateSyncCallback = cb; }

  // ======== HOST: Game Flow Helpers ========

  // Host broadcasts an action for guests to replay
  function broadcastGameAction(data) {
    Network.broadcast({ type: 'game_action', data: data });
  }

  // Host broadcasts full game state sync
  function broadcastGameStateSync(data) {
    Network.broadcast({ type: 'game_state_sync', data: data });
  }

  // Host sets phase
  function setGamePhase(phase) {
    gamePhase = phase;
  }

  // ======== CLEANUP ========

  function cleanup() {
    Network.disconnect();
    active = false;
    _isHost = false;
    myDeviceId = '';
    myUsername = '';
    gamePhase = 'lobby';
    initLobbyState();
    pendingRequests = [];
    joinResponseCallback = null;
    onGameStartCallback = null;
    onActionCallback = null;
    onGameActionCallback = null;
    onGameStateSyncCallback = null;
    renderLobbyCallback = null;
  }

  // ======== ACCESSORS ========

  function isActive() { return active; }
  function isHost() { return _isHost; }
  function getMyDeviceId() { return myDeviceId; }
  function getMyUsername() { return myUsername; }
  function getLobbyState() { return lobbyState; }
  function getGamePhase() { return gamePhase; }

  // Check if a player ID belongs to this device
  function isMyPlayer(playerId) {
    var players = Game.getState().players;
    for (var i = 0; i < players.length; i++) {
      if (players[i].id === playerId) {
        return players[i].deviceId === myDeviceId;
      }
    }
    return false;
  }

  // Check if a seat belongs to this device
  function isMySeat(seatIdx) {
    return lobbyState.seats[seatIdx] && lobbyState.seats[seatIdx].deviceId === myDeviceId;
  }

  return {
    hostGame: hostGame,
    joinGame: joinGame,
    leaveRoom: leaveRoom,
    approveGuest: approveGuest,
    denyGuest: denyGuest,
    addAI: addAI,
    removeFromSeat: removeFromSeat,
    swapSeats: swapSeats,
    startOnlineGame: startOnlineGame,
    sendAction: sendAction,
    sendChangeName: sendChangeName,
    sendChangeAnimal: sendChangeAnimal,
    sendSwapSeat: sendSwapSeat,
    onJoinResponse: onJoinResponse,
    onGameStart: onGameStart,
    onAction: onAction,
    onGameAction: onGameAction,
    onGameStateSync: onGameStateSync,
    onRenderLobby: onRenderLobby,
    broadcastGameAction: broadcastGameAction,
    broadcastGameStateSync: broadcastGameStateSync,
    broadcastLobbyState: broadcastLobbyState,
    setGamePhase: setGamePhase,
    renderOnlineLobby: renderOnlineLobby,
    renderJoinRequests: renderJoinRequests,
    isActive: isActive,
    isHost: isHost,
    isMyPlayer: isMyPlayer,
    isMySeat: isMySeat,
    getMyDeviceId: getMyDeviceId,
    getMyUsername: getMyUsername,
    getLobbyState: getLobbyState,
    getGamePhase: getGamePhase,
    totalPlayerCount: totalPlayerCount,
    cleanup: cleanup
  };
})();
