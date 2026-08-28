const { generateRoomCode } = require('../utils/codeGen');
const LudoEngine = require('./LudoEngine');

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomCode -> room Object
    this.socketToRoom = new Map(); // socketId -> { roomCode, color }
  }

  createRoom(hostSocket, hostName, settings = {}) {
    let roomCode = generateRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = generateRoomCode();
    }

    const mode = settings.mode || '4P'; // '4P' or '6P'
    const teamMode = settings.teamMode || 'solo'; // 'solo', '2v2', '3v3', '2v2v2'
    const turnTimer = parseInt(settings.turnTimer || 30, 10);
    const diceCount = parseInt(settings.diceCount || 1, 10);
    const extraTurnOnKill = settings.extraTurnOnKill !== false;
    const extraTurnOnHome = settings.extraTurnOnHome !== false;
    const killRequiredToEnterHome = settings.killRequiredToEnterHome !== false;

    const customRules = { diceCount, extraTurnOnKill, extraTurnOnHome, killRequiredToEnterHome };
    const engine = new LudoEngine(mode, teamMode, turnTimer, customRules);
    
    // Assign host to first color ('red')
    engine.addPlayer('red', hostSocket.id, hostName);

    const room = {
      code: roomCode,
      hostId: hostSocket.id,
      engine,
      settings: { mode, teamMode, turnTimer, ...customRules },
      playerSlots: this.initSlots(engine.colors, hostSocket.id, hostName),
      chatHistory: [],
      timerInterval: null,
      timeLeft: turnTimer
    };

    this.rooms.set(roomCode, room);
    this.socketToRoom.set(hostSocket.id, { roomCode, color: 'red' });

    hostSocket.join(roomCode);
    return room;
  }

  initSlots(colors, hostSocketId, hostName) {
    const slots = {};
    colors.forEach((color, idx) => {
      if (idx === 0) {
        slots[color] = {
          color,
          name: hostName,
          socketId: hostSocketId,
          isHost: true,
          ready: true,
          connected: true
        };
      } else {
        slots[color] = {
          color,
          name: null,
          socketId: null,
          isHost: false,
          ready: false,
          connected: false
        };
      }
    });
    return slots;
  }

  joinRoom(socket, roomCode, playerName) {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) return { error: 'Room code not found.' };

    const { engine, playerSlots } = room;

    if (engine.gameStarted) {
      return { error: 'Game has already started in this room.' };
    }

    // Find first available slot following diagonal slot allocation order
    const slotPriority = engine.mode === '4P' 
      ? ['red', 'yellow', 'green', 'blue']
      : ['red', 'blue', 'yellow', 'purple', 'green', 'orange'];

    const freeColor = slotPriority.find(c => !playerSlots[c].socketId);
    if (!freeColor) {
      return { error: 'Room is full.' };
    }

    playerSlots[freeColor] = {
      color: freeColor,
      name: playerName || `Player ${freeColor.toUpperCase()}`,
      socketId: socket.id,
      isHost: false,
      ready: true,
      connected: true
    };

    engine.addPlayer(freeColor, socket.id, playerSlots[freeColor].name);
    this.socketToRoom.set(socket.id, { roomCode: room.code, color: freeColor });

    socket.join(room.code);
    return { room, color: freeColor };
  }

  rejoinRoom(socket, roomCode, color, playerName) {
    if (!roomCode || !color) return { error: 'Invalid room or color.' };

    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) return { error: 'Room not found or expired.' };

    const { engine, playerSlots } = room;
    const slot = playerSlots[color];
    if (!slot) return { error: 'Invalid color slot for this room.' };

    // Update slot with new socket and connected status
    slot.socketId = socket.id;
    slot.connected = true;
    if (playerName) slot.name = playerName;

    // Update engine player state
    if (engine.players[color]) {
      engine.players[color].socketId = socket.id;
      engine.players[color].connected = true;
    } else {
      engine.addPlayer(color, socket.id, slot.name);
    }

    this.socketToRoom.set(socket.id, { roomCode: room.code, color });
    socket.join(room.code);

    return { 
      room, 
      color, 
      slots: playerSlots, 
      settings: room.settings, 
      state: engine.getGameState() 
    };
  }

  leaveRoom(socketId) {
    const info = this.socketToRoom.get(socketId);
    if (!info) return null;

    const { roomCode, color } = info;
    this.socketToRoom.delete(socketId);
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const { engine, playerSlots } = room;
    
    if (playerSlots[color]) {
      playerSlots[color].socketId = null;
      playerSlots[color].connected = false;
      playerSlots[color].ready = false;
    }

    engine.removePlayer(socketId);

    // If room is empty, clear room and timer
    const anyConnected = Object.values(playerSlots).some(s => s.connected);
    if (!anyConnected) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      this.rooms.delete(roomCode);
      return { roomCode, empty: true };
    }

    // Transfer host if host left
    if (room.hostId === socketId) {
      const newHost = Object.values(playerSlots).find(s => s.connected);
      if (newHost) {
        room.hostId = newHost.socketId;
        newHost.isHost = true;
      }
    }

    return { roomCode, empty: false, room };
  }

  startGame(socketId, roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return { error: 'Room not found.' };
    if (room.hostId !== socketId) return { error: 'Only the host can start the game.' };

    const { engine, playerSlots } = room;

    // Check if at least 2 players have joined
    const connectedCount = Object.values(playerSlots).filter(s => s.connected).length;
    if (connectedCount < 2) {
      return { error: 'At least 2 players are required to start.' };
    }

    engine.startGame();
    this.startTurnTimer(room);
    return { room };
  }

  startTurnTimer(room) {
    if (room.timerInterval) clearInterval(room.timerInterval);
    if (room.settings.turnTimer <= 0) return;

    room.timeLeft = room.settings.turnTimer;

    room.timerInterval = setInterval(() => {
      if (room.engine.gameOver) {
        clearInterval(room.timerInterval);
        return;
      }

      // If in Appeal Demo mode, countdown the demo timer
      if (room.engine.appealState && room.engine.appealState.inDemo) {
        room.engine.appealState.demoTimeLeft = Math.max(0, (room.engine.appealState.demoTimeLeft || 10) - 1);
        this.io.to(room.code).emit('GAME_STATE_UPDATE', { state: room.engine.getGameState() });

        if (room.engine.appealState.demoTimeLeft <= 0) {
          const appealingColor = room.engine.appealState.appealingColor;
          room.engine.failAppeal(appealingColor);
          room.engine.finishTurn();
          this.resetTimer(room);
          this.io.to(room.code).emit('GAME_STATE_UPDATE', { state: room.engine.getGameState() });
        }
        return;
      }

      room.timeLeft--;
      this.io.to(room.code).emit('TIMER_TICK', { timeLeft: room.timeLeft });

      if (room.timeLeft <= 0) {
        // Auto-skip or execute random move on timeout
        this.handleTurnTimeout(room);
        room.timeLeft = room.settings.turnTimer;
      }
    }, 1000);
  }

  handleTurnTimeout(room) {
    const { engine } = room;
    const activeColor = engine.getActiveColor();

    if (engine.currentDice === null) {
      // Auto-roll dice if player hasn't rolled yet
      const rollRes = engine.rollDice();
      this.io.to(room.code).emit('DICE_ROLLED', { color: activeColor, ...rollRes, state: engine.getGameState() });

      if (rollRes && rollRes.validMoves.length > 0) {
        // Auto-pick first valid move IMMEDIATELY with zero wait!
        const tokenIndex = rollRes.validMoves[0];
        const moveRes = engine.moveToken(activeColor, tokenIndex);
        this.io.to(room.code).emit('TOKEN_MOVED', { state: engine.getGameState(), moveRes });
        this.resetTimer(room);
      } else {
        this.resetTimer(room);
      }
    } else if (engine.validMoves.length > 0) {
      // Auto-pick first valid move
      const tokenIndex = engine.validMoves[0];
      const moveRes = engine.moveToken(activeColor, tokenIndex);
      this.io.to(room.code).emit('TOKEN_MOVED', { state: engine.getGameState(), moveRes });
      this.resetTimer(room);
    } else {
      engine.nextTurn();
      this.io.to(room.code).emit('GAME_STATE_UPDATE', { state: engine.getGameState() });
      this.resetTimer(room);
    }
  }

  resetTimer(room) {
    room.timeLeft = room.settings.turnTimer;
  }
}

module.exports = RoomManager;
