/* ============================================================
   30 - Network Layer (PeerJS WebRTC)
   Handles room creation, joining, and message passing
   Includes heartbeat keepalive & auto-reconnection for mobile
   ============================================================ */

var Network = (function () {
  'use strict';

  var peer = null;
  var connections = {};    // peerId -> DataConnection (host only)
  var hostConn = null;     // guest's connection to host
  var _isHost = false;
  var myPeerId = '';
  var roomCode = '';

  var messageHandler = null;
  var connectHandler = null;
  var disconnectHandler = null;   // FINAL drop (after grace period)
  var reconnectHandler = null;    // guest reconnects during grace
  var pausedHandler = null;       // conn closed, entering grace period
  var resumedHandler = null;      // conn reopened within grace

  var ROOM_PREFIX = 'thirty-game-';
  var HEARTBEAT_INTERVAL = 5000;   // 5 seconds
  var HEARTBEAT_TIMEOUT = 60000;   // 60s without heartbeat = probably dead
  var RECONNECT_GRACE = 300000;    // 5 MINUTES to reconnect before final drop.
                                   // Covers iPad/phone screen-off periods
                                   // (iOS suspends JS when the screen locks).

  var heartbeatTimer = null;
  var peerHeartbeats = {};  // peerId -> { timer, lastSeen, graceTimer, paused }

  // ICE server config — STUN + TURN. STUN handles the common case (NAT
  // hole-punching), TURN is the fallback when the network blocks direct
  // device-to-device UDP. Routers with "AP isolation", strict-symmetric
  // NATs, mobile hotspots, and guest Wi-Fi networks commonly need TURN or
  // the peers will never actually reach each other.
  //
  // We pass multiple public TURN providers (Open Relay, expressturn) on
  // UDP, TCP and TLS so at least one combination escapes most
  // corporate/guest firewalls. Each guest's PeerJS picks whichever pairs
  // successfully with the host during ICE gathering.
  var TURN_SERVERS = [
    // Open Relay Project (metered.ca) — free public demo, shared creds.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    // ExpressTURN.com — free community TURN, public demo creds.
    { urls: 'turn:relay1.expressturn.com:3478', username: 'ef9WOA39BIBJY9HREJ', credential: 'zkR3gWmKWQYCASWZ' },
    { urls: 'turn:relay1.expressturn.com:3480?transport=tcp', username: 'ef9WOA39BIBJY9HREJ', credential: 'zkR3gWmKWQYCASWZ' }
  ];

  var STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' }
  ];

  // Build a full ICE config. If `relayOnly` is true we strip the STUN
  // servers and force iceTransportPolicy: 'relay' so WebRTC ONLY attempts
  // TURN paths. That's slower but reliable when the network blocks
  // every form of direct connectivity.
  function buildIceConfig(relayOnly) {
    if (relayOnly) {
      return {
        iceServers: TURN_SERVERS.slice(),
        iceTransportPolicy: 'relay',
        iceCandidatePoolSize: 4
      };
    }
    return {
      iceServers: STUN_SERVERS.concat(TURN_SERVERS),
      iceCandidatePoolSize: 4
    };
  }

  // Legacy default config (kept for the host path which doesn't retry).
  var ICE_CONFIG = buildIceConfig(false);

  // Generate a short, readable room code (no ambiguous chars)
  function generateRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // ================================================================
  //  HEARTBEAT SYSTEM
  // ================================================================

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (_isHost) {
        // Host sends heartbeat to all guests
        broadcast({ type: '_hb' });
        // Check for dead guests
        var now = Date.now();
        for (var id in peerHeartbeats) {
          var hb = peerHeartbeats[id];
          if (now - hb.lastSeen > HEARTBEAT_TIMEOUT && !hb.graceTimer) {
            console.warn('[Network] No heartbeat from', id, '- starting grace period');
            startGracePeriod(id);
          }
        }
      } else {
        // Guest sends heartbeat to host
        if (hostConn && hostConn.open) {
          hostConn.send({ type: '_hb' });
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    // Clear all grace timers
    for (var id in peerHeartbeats) {
      if (peerHeartbeats[id].graceTimer) {
        clearTimeout(peerHeartbeats[id].graceTimer);
      }
    }
    peerHeartbeats = {};
  }

  function recordHeartbeat(peerId) {
    if (!peerHeartbeats[peerId]) {
      peerHeartbeats[peerId] = { lastSeen: Date.now(), graceTimer: null, paused: false };
    }
    peerHeartbeats[peerId].lastSeen = Date.now();

    // If they were in grace period OR marked paused, they're back!
    var wasPaused = peerHeartbeats[peerId].paused || peerHeartbeats[peerId].graceTimer;
    if (peerHeartbeats[peerId].graceTimer) {
      console.log('[Network] Peer', peerId, 'recovered during grace period');
      clearTimeout(peerHeartbeats[peerId].graceTimer);
      peerHeartbeats[peerId].graceTimer = null;
    }
    if (peerHeartbeats[peerId].paused) {
      peerHeartbeats[peerId].paused = false;
      if (resumedHandler) resumedHandler(peerId);
    }
    if (wasPaused && reconnectHandler) reconnectHandler(peerId);
  }

  function startGracePeriod(peerId) {
    if (!peerHeartbeats[peerId]) return;
    // Mark as paused immediately so app-layer can start AI fallback etc.
    if (!peerHeartbeats[peerId].paused) {
      peerHeartbeats[peerId].paused = true;
      console.log('[Network] Peer paused (grace started):', peerId);
      if (pausedHandler) pausedHandler(peerId);
    }
    peerHeartbeats[peerId].graceTimer = setTimeout(function () {
      console.warn('[Network] Grace period expired for', peerId);
      peerHeartbeats[peerId].graceTimer = null;
      // Final drop
      delete connections[peerId];
      delete peerHeartbeats[peerId];
      if (disconnectHandler) disconnectHandler(peerId);
    }, RECONNECT_GRACE);
  }

  // ================================================================
  //  HOST: Create Room
  // ================================================================

  function createRoom() {
    return new Promise(function (resolve, reject) {
      roomCode = generateRoomCode();
      var peerId = ROOM_PREFIX + roomCode;

      // Clean up any existing peer first
      if (peer) {
        try { peer.destroy(); } catch (e) {}
        peer = null;
      }

      peer = new Peer(peerId, { debug: 2, config: ICE_CONFIG });
      _isHost = true;

      // Register connection listener BEFORE open — prevents race condition
      peer.on('connection', function (conn) {
        console.log('[Network] Incoming connection from:', conn.peer);
        setupHostConnection(conn);
      });

      peer.on('open', function (id) {
        console.log('[Network] Host peer opened with ID:', id);
        myPeerId = id;
        startHeartbeat();
        resolve(roomCode);
      });

      peer.on('disconnected', function () {
        console.warn('[Network] Host disconnected from signaling server, reconnecting...');
        if (peer && !peer.destroyed) {
          peer.reconnect();
        }
      });

      peer.on('error', function (err) {
        console.error('[Network] Host peer error:', err.type, err.message);
        if (err.type === 'unavailable-id') {
          peer.destroy();
          peer = null;
          createRoom().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  function setupHostConnection(conn) {
    conn.on('open', function () {
      console.log('[Network] Connection opened with:', conn.peer);
      var existingConn = connections[conn.peer];

      // If this peer already has a connection, this is a reconnection
      if (existingConn) {
        console.log('[Network] Replacing old connection for:', conn.peer);
        try { existingConn.close(); } catch (e) {}
      }

      connections[conn.peer] = conn;
      recordHeartbeat(conn.peer);

      conn.on('data', function (data) {
        if (data && data.type === '_hb') {
          recordHeartbeat(conn.peer);
          return; // heartbeat — don't propagate
        }
        if (messageHandler) messageHandler(conn.peer, data);
      });

      conn.on('close', function () {
        console.log('[Network] Connection closed:', conn.peer);
        // Don't immediately disconnect — start grace period for reconnection
        if (peerHeartbeats[conn.peer] && !peerHeartbeats[conn.peer].graceTimer) {
          console.log('[Network] Starting grace period for:', conn.peer);
          startGracePeriod(conn.peer);
        }
      });

      conn.on('error', function (err) {
        console.error('[Network] Connection error from guest:', err);
        if (peerHeartbeats[conn.peer] && !peerHeartbeats[conn.peer].graceTimer) {
          startGracePeriod(conn.peer);
        }
      });

      // If this is a reconnection (peer was in grace period), notify
      if (existingConn) {
        if (reconnectHandler) reconnectHandler(conn.peer);
      } else {
        if (connectHandler) connectHandler(conn.peer);
      }
    });
  }

  // ================================================================
  //  GUEST: Join Room
  // ================================================================

  var guestRoomCode = '';
  var guestReconnecting = false;

  // Two-pass join: first normal ICE (direct + STUN + TURN), then — if
  // that fails — a relay-only retry. Many hotel / office / guest Wi-Fi
  // networks only let TURN traffic through, and the direct/STUN
  // candidates keep "winning" the ICE priority race before timing out.
  // Forcing relay on retry cuts past that.
  function joinRoom(code) {
    return attemptJoin(code, false).catch(function (err) {
      console.warn('[Network] Normal join failed, retrying relay-only:', err && err.message);
      return attemptJoin(code, true);
    });
  }

  function attemptJoin(code, relayOnly) {
    return new Promise(function (resolve, reject) {
      roomCode = code.toUpperCase();
      guestRoomCode = roomCode;
      var hostPeerId = ROOM_PREFIX + roomCode;

      // Clean up any existing peer first
      if (peer) {
        try { peer.destroy(); } catch (e) {}
        peer = null;
        hostConn = null;
      }

      var iceConfig = buildIceConfig(relayOnly);
      console.log('[Network] Join attempt, relayOnly=' + relayOnly, 'ICE servers:', iceConfig.iceServers.length);
      peer = new Peer(undefined, { debug: 2, config: iceConfig });
      _isHost = false;

      var resolved = false;
      var connectAttempted = false;

      function fail(msg) {
        if (!resolved) {
          resolved = true;
          console.error('[Network] Join failed (relayOnly=' + relayOnly + '):', msg);
          disconnect();
          reject(new Error(msg));
        }
      }

      peer.on('open', function (id) {
        console.log('[Network] Guest peer opened with ID:', id);
        console.log('[Network] Connecting to host:', hostPeerId);
        myPeerId = id;
        connectAttempted = true;

        connectToHost(hostPeerId, function () {
          if (!resolved) {
            resolved = true;
            startHeartbeat();
            resolve();
          }
        }, function (msg) {
          fail(msg);
        });

        // Connection timeout — give TURN negotiation room (it can take
        // 10–15s on congested networks). 20s total before giving up.
        setTimeout(function () {
          if (!resolved) {
            var hint = relayOnly
              ? ' This can happen when the Wi-Fi network blocks WebRTC relay traffic. Try switching one device to its mobile data / cellular hotspot.'
              : '';
            fail('Could not reach room ' + roomCode + '.' + hint);
          }
        }, 20000);
      });

      peer.on('disconnected', function () {
        console.warn('[Network] Guest disconnected from signaling server, reconnecting...');
        if (peer && !peer.destroyed) {
          peer.reconnect();
        }
      });

      peer.on('error', function (err) {
        console.error('[Network] Guest peer error:', err.type, err.message);
        if (err.type === 'peer-unavailable') {
          fail('Room ' + roomCode + ' not found. Check the code and try again.');
        } else if (!guestReconnecting) {
          fail('Connection error: ' + (err.message || err));
        }
      });

      // Timeout for signaling server
      setTimeout(function () {
        if (!connectAttempted && !resolved) {
          fail('Could not reach the signaling server. Check your internet connection.');
        }
      }, 10000);
    });
  }

  function connectToHost(hostPeerId, onSuccess, onFail) {
    hostConn = peer.connect(hostPeerId, { reliable: true, serialization: 'json' });

    // Wire up ICE state logging for diagnosis. PeerJS exposes the
    // underlying RTCPeerConnection as `peerConnection`. If we can reach
    // it, log every ICE state change and candidate — so if a join fails
    // the console tells us WHICH stage failed (signaling vs gathering vs
    // connectivity checks).
    setTimeout(function () {
      try {
        var pc = hostConn && hostConn.peerConnection;
        if (!pc) return;
        pc.oniceconnectionstatechange = function () {
          console.log('[Network] ICE state:', pc.iceConnectionState);
        };
        pc.onicegatheringstatechange = function () {
          console.log('[Network] ICE gathering:', pc.iceGatheringState);
        };
        pc.onicecandidate = function (e) {
          if (e.candidate) {
            console.log('[Network] ICE candidate:', e.candidate.type || '?', e.candidate.protocol, e.candidate.address || '(redacted)');
          } else {
            console.log('[Network] ICE candidate gathering complete');
          }
        };
      } catch (e) { /* ignore — diagnostics only */ }
    }, 100);

    hostConn.on('open', function () {
      console.log('[Network] Connection to host OPENED successfully!');
      guestReconnecting = false;

      hostConn.on('data', function (data) {
        if (data && data.type === '_hb') {
          return; // heartbeat from host — connection is alive
        }
        if (messageHandler) messageHandler('host', data);
      });

      hostConn.on('close', function () {
        console.log('[Network] Connection to host closed');
        attemptGuestReconnect();
      });

      hostConn.on('error', function (err) {
        console.error('[Network] hostConn error:', err);
        attemptGuestReconnect();
      });

      if (onSuccess) onSuccess();
    });

    hostConn.on('error', function (err) {
      console.error('[Network] hostConn initial error:', err.type || '', err.message || err);
      if (onFail) onFail('Connection failed: ' + (err.message || err));
    });
  }

  // Guest auto-reconnection with exponential backoff
  var reconnectAttempts = 0;
  var maxReconnectAttempts = 6; // ~30 seconds total
  var reconnectTimeout = null;

  function attemptGuestReconnect() {
    if (_isHost || guestReconnecting) return;
    if (!peer || peer.destroyed) {
      // Peer is gone — can't reconnect
      if (disconnectHandler) disconnectHandler('host');
      return;
    }

    guestReconnecting = true;
    reconnectAttempts = 0;
    console.log('[Network] Starting guest reconnection...');
    tryReconnect();
  }

  function tryReconnect() {
    if (!guestReconnecting || !peer || peer.destroyed) {
      guestReconnecting = false;
      if (disconnectHandler) disconnectHandler('host');
      return;
    }

    if (reconnectAttempts >= maxReconnectAttempts) {
      console.warn('[Network] Max reconnect attempts reached');
      guestReconnecting = false;
      if (disconnectHandler) disconnectHandler('host');
      return;
    }

    var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
    reconnectAttempts++;
    console.log('[Network] Reconnect attempt', reconnectAttempts, 'in', delay, 'ms');

    reconnectTimeout = setTimeout(function () {
      if (!guestReconnecting || !peer || peer.destroyed) return;

      // Make sure we're connected to signaling server
      if (peer.disconnected) {
        peer.reconnect();
        // Wait a bit for signaling to re-establish
        setTimeout(function () {
          doReconnect();
        }, 2000);
      } else {
        doReconnect();
      }
    }, delay);
  }

  function doReconnect() {
    if (!guestReconnecting || !peer || peer.destroyed) return;
    var hostPeerId = ROOM_PREFIX + guestRoomCode;

    try {
      hostConn = peer.connect(hostPeerId, { reliable: true, serialization: 'json' });
    } catch (e) {
      console.error('[Network] Reconnect connect() failed:', e);
      tryReconnect();
      return;
    }

    var reconnectResolved = false;

    hostConn.on('open', function () {
      if (reconnectResolved) return;
      reconnectResolved = true;
      console.log('[Network] Guest reconnected to host!');
      guestReconnecting = false;
      reconnectAttempts = 0;

      hostConn.on('data', function (data) {
        if (data && data.type === '_hb') return;
        if (messageHandler) messageHandler('host', data);
      });

      hostConn.on('close', function () {
        console.log('[Network] Connection to host closed (after reconnect)');
        attemptGuestReconnect();
      });

      hostConn.on('error', function (err) {
        console.error('[Network] hostConn error (after reconnect):', err);
        attemptGuestReconnect();
      });

      // Notify online.js so it can re-announce itself
      if (reconnectHandler) reconnectHandler('host');
    });

    hostConn.on('error', function (err) {
      if (reconnectResolved) return;
      reconnectResolved = true;
      console.warn('[Network] Reconnect attempt failed:', err.message || err);
      tryReconnect();
    });

    // Per-attempt timeout
    setTimeout(function () {
      if (!reconnectResolved) {
        reconnectResolved = true;
        console.warn('[Network] Reconnect attempt timed out');
        tryReconnect();
      }
    }, 8000);
  }

  // ================================================================
  //  VISIBILITY CHANGE (mobile background/foreground)
  // ================================================================

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      console.log('[Network] Page became visible — checking connections');
      if (_isHost) {
        // Host: re-establish signaling if needed
        if (peer && peer.disconnected && !peer.destroyed) {
          peer.reconnect();
        }
      } else {
        // Guest: check if host connection is still alive
        if (hostConn && !hostConn.open && !guestReconnecting) {
          console.log('[Network] Host connection lost while backgrounded, reconnecting...');
          attemptGuestReconnect();
        }
      }
    }
  });

  // ---- Send message to a specific peer (host → guest) ----
  function send(targetPeerId, message) {
    if (_isHost) {
      var conn = connections[targetPeerId];
      if (conn && conn.open) conn.send(message);
    } else {
      if (hostConn && hostConn.open) hostConn.send(message);
    }
  }

  // ---- Host: Broadcast to all connected guests ----
  function broadcast(message) {
    for (var id in connections) {
      if (connections[id] && connections[id].open) {
        connections[id].send(message);
      }
    }
  }

  // ---- Disconnect and cleanup ----
  function disconnect() {
    stopHeartbeat();
    guestReconnecting = false;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (peer) {
      peer.destroy();
      peer = null;
    }
    connections = {};
    hostConn = null;
    _isHost = false;
    roomCode = '';
    myPeerId = '';
  }

  // ---- Kick a specific guest ----
  function kickGuest(peerId) {
    var conn = connections[peerId];
    if (conn) {
      conn.close();
      delete connections[peerId];
    }
    if (peerHeartbeats[peerId]) {
      if (peerHeartbeats[peerId].graceTimer) {
        clearTimeout(peerHeartbeats[peerId].graceTimer);
      }
      delete peerHeartbeats[peerId];
    }
  }

  // ---- Event handlers ----
  function onMessage(handler) { messageHandler = handler; }
  function onConnect(handler) { connectHandler = handler; }
  function onDisconnect(handler) { disconnectHandler = handler; }
  function onReconnect(handler) { reconnectHandler = handler; }
  function onPaused(handler) { pausedHandler = handler; }
  function onResumed(handler) { resumedHandler = handler; }

  // ---- Accessors ----
  function isHost() { return _isHost; }
  function isConnected() { return peer !== null && !peer.disconnected; }
  function isReconnecting() { return guestReconnecting; }
  function getRoomCode() { return roomCode; }
  function getMyPeerId() { return myPeerId; }
  function getGuestIds() { return Object.keys(connections); }

  return {
    createRoom: createRoom,
    joinRoom: joinRoom,
    send: send,
    broadcast: broadcast,
    disconnect: disconnect,
    kickGuest: kickGuest,
    onMessage: onMessage,
    onConnect: onConnect,
    onDisconnect: onDisconnect,
    onReconnect: onReconnect,
    onPaused: onPaused,
    onResumed: onResumed,
    isHost: isHost,
    isConnected: isConnected,
    isReconnecting: isReconnecting,
    getRoomCode: getRoomCode,
    getMyPeerId: getMyPeerId,
    getGuestIds: getGuestIds
  };
})();
