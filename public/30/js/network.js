/* ============================================================
   30 - Network Layer (PeerJS WebRTC)
   Handles room creation, joining, and message passing
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
  var disconnectHandler = null;

  var ROOM_PREFIX = 'thirty-game-';

  // ICE server config — STUN only (no dead TURN servers that block ICE gathering)
  var ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ]
  };

  // Generate a short, readable room code (no ambiguous chars)
  function generateRoomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var code = '';
    for (var i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  // ---- Host: Create Room ----
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
      // where a guest connects before our handler is ready
      peer.on('connection', function (conn) {
        console.log('[Network] Incoming connection from:', conn.peer);

        conn.on('open', function () {
          console.log('[Network] Connection opened with:', conn.peer);
          connections[conn.peer] = conn;

          conn.on('data', function (data) {
            if (messageHandler) messageHandler(conn.peer, data);
          });

          conn.on('close', function () {
            console.log('[Network] Connection closed:', conn.peer);
            delete connections[conn.peer];
            if (disconnectHandler) disconnectHandler(conn.peer);
          });

          conn.on('error', function (err) {
            console.error('[Network] Connection error from guest:', err);
            delete connections[conn.peer];
            if (disconnectHandler) disconnectHandler(conn.peer);
          });

          if (connectHandler) connectHandler(conn.peer);
        });
      });

      peer.on('open', function (id) {
        console.log('[Network] Host peer opened with ID:', id);
        myPeerId = id;
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
          // Room code collision — retry with new code
          peer.destroy();
          peer = null;
          createRoom().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  // ---- Guest: Join Room ----
  function joinRoom(code) {
    return new Promise(function (resolve, reject) {
      roomCode = code.toUpperCase();
      var hostPeerId = ROOM_PREFIX + roomCode;

      // Clean up any existing peer first
      if (peer) {
        try { peer.destroy(); } catch (e) {}
        peer = null;
        hostConn = null;
      }

      peer = new Peer(undefined, { debug: 2, config: ICE_CONFIG });
      _isHost = false;

      var resolved = false;
      var connectAttempted = false;
      var iceState = 'new';

      function fail(msg) {
        if (!resolved) {
          resolved = true;
          console.error('[Network] Join failed:', msg);
          disconnect();
          reject(new Error(msg));
        }
      }

      peer.on('open', function (id) {
        console.log('[Network] Guest peer opened with ID:', id);
        console.log('[Network] Connecting to host:', hostPeerId);
        myPeerId = id;
        connectAttempted = true;

        hostConn = peer.connect(hostPeerId, { reliable: true, serialization: 'json' });

        hostConn.on('open', function () {
          console.log('[Network] Connection to host OPENED successfully!');

          hostConn.on('data', function (data) {
            if (messageHandler) messageHandler('host', data);
          });

          hostConn.on('close', function () {
            console.log('[Network] Connection to host closed');
            if (disconnectHandler) disconnectHandler('host');
          });

          if (!resolved) {
            resolved = true;
            resolve();
          }
        });

        hostConn.on('error', function (err) {
          console.error('[Network] hostConn error:', err.type || '', err.message || err);
          fail('Connection failed: ' + (err.message || err));
        });

        // Monitor ICE state for debugging
        setTimeout(function () {
          if (hostConn && hostConn.peerConnection) {
            var pc = hostConn.peerConnection;
            iceState = pc.iceConnectionState;
            console.log('[Network] ICE state:', pc.iceConnectionState, 'Signaling:', pc.signalingState);
            pc.oniceconnectionstatechange = function () {
              iceState = pc.iceConnectionState;
              console.log('[Network] ICE state changed to:', pc.iceConnectionState);
              if (pc.iceConnectionState === 'failed') {
                fail('Connection blocked by network. Your WiFi router may have "AP isolation" enabled, which prevents devices from connecting to each other. Try: (1) Check router settings for "AP isolation" or "Client isolation" and disable it, (2) Connect one device via ethernet, or (3) Use a mobile hotspot instead.');
              }
            };
          }
        }, 500);

        // Connection timeout
        setTimeout(function () {
          if (!resolved) {
            var hint = '';
            if (iceState === 'checking' || iceState === 'new') {
              hint = ' Your network may be blocking direct device connections (WiFi AP isolation). Try disabling "AP isolation" in your router settings, connecting one device via ethernet, or using a mobile hotspot.';
            }
            fail('Could not reach room ' + roomCode + '.' + hint);
          }
        }, 12000);
      });

      peer.on('error', function (err) {
        console.error('[Network] Guest peer error:', err.type, err.message);
        if (err.type === 'peer-unavailable') {
          fail('Room ' + roomCode + ' not found. Check the code and try again.');
        } else {
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

  // ---- Send message to a specific peer (host → guest) ----
  function send(targetPeerId, message) {
    if (_isHost) {
      var conn = connections[targetPeerId];
      if (conn && conn.open) conn.send(message);
    } else {
      // Guest always sends to host
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
  }

  // ---- Event handlers ----
  function onMessage(handler) { messageHandler = handler; }
  function onConnect(handler) { connectHandler = handler; }
  function onDisconnect(handler) { disconnectHandler = handler; }

  // ---- Accessors ----
  function isHost() { return _isHost; }
  function isConnected() { return peer !== null && !peer.disconnected; }
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
    isHost: isHost,
    isConnected: isConnected,
    getRoomCode: getRoomCode,
    getMyPeerId: getMyPeerId,
    getGuestIds: getGuestIds
  };
})();
