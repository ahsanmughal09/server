const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const RoomManager = require('./game/RoomManager');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const roomManager = new RoomManager(io);

// Health check API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Create Room
  socket.on('CREATE_ROOM', (payload, callback) => {
    try {
      const { name, ...settings } = payload || {};
      const room = roomManager.createRoom(socket, name, settings);
      const response = {
        roomCode: room.code,
        color: 'red',
        slots: room.playerSlots,
        settings: room.settings,
        state: room.engine.getGameState()
      };
      if (typeof callback === 'function') callback({ success: true, ...response });
      io.to(room.code).emit('ROOM_UPDATED', { slots: room.playerSlots, settings: room.settings });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // Join Room
  socket.on('JOIN_ROOM', ({ roomCode, name }, callback) => {
    const result = roomManager.joinRoom(socket, roomCode, name);
    if (result.error) {
      if (typeof callback === 'function') callback({ success: false, error: result.error });
      return;
    }

    const { room, color } = result;
    const response = {
      roomCode: room.code,
      color,
      slots: room.playerSlots,
      settings: room.settings,
      state: room.engine.getGameState()
    };

    if (typeof callback === 'function') callback({ success: true, ...response });

    io.to(room.code).emit('ROOM_UPDATED', { slots: room.playerSlots, settings: room.settings });
    io.to(room.code).emit('CHAT_MESSAGE', {
      sender: 'System',
      text: `${name} joined as ${color.toUpperCase()}`,
    });
  });

  // Rejoin Room on Refresh / Reconnect
  socket.on('REJOIN_ROOM', ({ roomCode, color, name }, callback) => {
    const result = roomManager.rejoinRoom(socket, roomCode, color, name);
    if (result.error) {
      if (typeof callback === 'function') callback({ success: false, error: result.error });
      return;
    }

    const { room, slots, settings, state } = result;
    const response = {
      roomCode: room.code,
      color: result.color,
      slots,
      settings,
      state
    };

    if (typeof callback === 'function') callback({ success: true, ...response });

    io.to(room.code).emit('ROOM_UPDATED', { slots: room.playerSlots, settings: room.settings });
    io.to(room.code).emit('GAME_STATE_UPDATE', { state: room.engine.getGameState() });
    io.to(room.code).emit('CHAT_MESSAGE', {
      sender: 'System',
      text: `${name || result.color.toUpperCase()} reconnected`,
      time: new Date().toLocaleTimeString()
    });
  });

  // Leave / Surrender Room
  socket.on('LEAVE_ROOM', ({ roomCode }, callback) => {
    const res = roomManager.leaveRoom(socket.id);
    if (res) {
      socket.leave(roomCode);
      if (typeof callback === 'function') callback({ success: true });
      if (!res.empty) {
        io.to(res.roomCode).emit('ROOM_UPDATED', { slots: res.room.playerSlots, settings: res.room.settings });
        io.to(res.roomCode).emit('GAME_STATE_UPDATE', { state: res.room.engine.getGameState() });
        io.to(res.roomCode).emit('CHAT_MESSAGE', {
          sender: 'System',
          text: `A player surrendered/left the room.`,
          time: new Date().toLocaleTimeString()
        });
      }
    }
  });

  // Start Game
  socket.on('START_GAME', ({ roomCode }, callback) => {
    const result = roomManager.startGame(socket.id, roomCode);
    if (result.error) {
      if (typeof callback === 'function') callback({ success: false, error: result.error });
      return;
    }

    if (typeof callback === 'function') callback({ success: true });
    io.to(roomCode).emit('GAME_STARTED', { state: result.room.engine.getGameState() });
  });

  // Select Roll from Balance
  socket.on('SELECT_ROLL', ({ roomCode, rollIndex }) => {
    const room = roomManager.rooms.get(roomCode);
    if (!room || !room.engine.gameStarted) return;

    const info = roomManager.socketToRoom.get(socket.id);
    if (!info || info.color !== room.engine.getActiveColor()) return;

    const success = room.engine.selectRoll(rollIndex);
    if (success) {
      io.to(roomCode).emit('GAME_STATE_UPDATE', { state: room.engine.getGameState() });
    }
  });

  // Roll Dice
  socket.on('ROLL_DICE', ({ roomCode, selectedDiceIndex }) => {
    const room = roomManager.rooms.get(roomCode);
    if (!room || !room.engine.gameStarted) return;

    const info = roomManager.socketToRoom.get(socket.id);
    if (!info || info.color !== room.engine.getActiveColor()) return;

    const rollRes = room.engine.rollDice(selectedDiceIndex);
    if (rollRes) {
      roomManager.resetTimer(room);
      io.to(roomCode).emit('DICE_ROLLED', {
        color: info.color,
        roll: rollRes.roll,
        penalty: rollRes.penalty,
        dicePool: rollRes.dicePool,
        canRoll: rollRes.canRoll,
        validMoves: rollRes.validMoves,
        state: room.engine.getGameState()
      });

      if (rollRes.penalty) {
        const isFourSixes = Array.isArray(rollRes.roll) && rollRes.roll.length === 2;
        const penaltyText = isFourSixes 
          ? `🚫 ${info.color.toUpperCase()} rolled 4 consecutive sixes! Turn cancelled & all rolls lost!` 
          : `🚫 ${info.color.toUpperCase()} rolled 3 consecutive sixes! Turn cancelled & all rolls lost!`;

        io.to(roomCode).emit('CHAT_MESSAGE', {
          sender: 'System',
          text: penaltyText
        });
      }

      // If rolling phase is done (canRoll === false), NOT a penalty, and NO valid moves exist for any roll in pool
      if (!rollRes.penalty && !rollRes.canRoll && rollRes.validMoves.length === 0) {
        setTimeout(() => {
          if (!room.engine.gameOver) {
            room.engine.finishTurn();
            roomManager.resetTimer(room);
            io.to(roomCode).emit('GAME_STATE_UPDATE', { state: room.engine.getGameState() });
          }
        }, 1100);
      } else if (!rollRes.penalty && !rollRes.canRoll) {
        // Smart Auto-Move: If only 1 unique token has legal moves, auto-move without waiting!
        checkAndTriggerSmartAutoMove(room, roomCode);
      }
    }
  });

  // Helper: Smart Auto-Move Single Choice Tokens
  function checkAndTriggerSmartAutoMove(room, roomCode) {
    if (!room || !room.engine || room.engine.gameOver || room.engine.canRoll) return;

    const autoTokenIdx = room.engine.getSmartAutoMoveTokenIndex();
    if (autoTokenIdx !== null) {
      setTimeout(() => {
        if (!room || !room.engine || room.engine.gameOver || room.engine.canRoll) return;
        const activeColor = room.engine.getActiveColor();
        const moveRes = room.engine.moveToken(activeColor, autoTokenIdx);

        if (moveRes && moveRes.success) {
          roomManager.resetTimer(room);
          io.to(roomCode).emit('TOKEN_MOVED', {
            color: activeColor,
            tokenIndex: autoTokenIdx,
            moveRes,
            state: room.engine.getGameState()
          });

          // Check for next forced auto-move on remaining dice in pool
          checkAndTriggerSmartAutoMove(room, roomCode);
        }
      }, 650);
    }
  }

  // Move Token
  socket.on('MOVE_TOKEN', ({ roomCode, tokenIndex, rollIndex }) => {
    const room = roomManager.rooms.get(roomCode);
    if (!room || !room.engine.gameStarted) return;

    const info = roomManager.socketToRoom.get(socket.id);
    if (!info || info.color !== room.engine.getActiveColor()) return;

    const moveRes = room.engine.moveToken(info.color, tokenIndex, rollIndex);
    if (moveRes && moveRes.success) {
      roomManager.resetTimer(room);
      io.to(roomCode).emit('TOKEN_MOVED', {
        color: info.color,
        tokenIndex,
        moveRes,
        state: room.engine.getGameState()
      });

      // Check if remaining roll in pool has a forced auto-move
      checkAndTriggerSmartAutoMove(room, roomCode);
    }
  });

  // Submit Appeal
  socket.on('SUBMIT_APPEAL', ({ roomCode }) => {
    const room = roomManager.rooms.get(roomCode);
    if (!room || !room.engine.gameStarted) return;

    const info = roomManager.socketToRoom.get(socket.id);
    if (!info) return;

    if (room.appealWindowTimer) {
      clearInterval(room.appealWindowTimer);
      room.appealWindowTimer = null;
    }

    const appealRes = room.engine.submitAppeal(info.color);
    if (appealRes && appealRes.success) {
      io.to(roomCode).emit('APPEAL_STARTED', {
        appealingColor: info.color,
        offendingColor: room.engine.appealState.offendingColor,
        demoTimeLeft: 10,
        state: room.engine.getGameState()
      });

      if (room.appealDemoTimer) clearInterval(room.appealDemoTimer);
      let demoSeconds = 10;
      room.appealDemoTimer = setInterval(() => {
        demoSeconds--;
        if (room.engine.appealState) {
          room.engine.appealState.demoTimeLeft = demoSeconds;
        }

        if (demoSeconds <= 0) {
          clearInterval(room.appealDemoTimer);
          room.appealDemoTimer = null;

          if (room.engine.appealState.inDemo) {
            const failRes = room.engine.failAppeal(info.color);
            room.engine.finishTurn();
            roomManager.resetTimer(room);
            io.to(roomCode).emit('APPEAL_RESOLVED', {
              success: false,
              appealingColor: info.color,
              state: room.engine.getGameState()
            });
          }
        } else {
          io.to(roomCode).emit('APPEAL_DEMO_TICK', { demoTimeLeft: demoSeconds });
        }
      }, 1000);
    }
  });

  // Execute Demonstration Move during Appeal Mode
  socket.on('DEMO_MOVE_TOKEN', ({ roomCode, tokenIndex, rollIndex }) => {
    const room = roomManager.rooms.get(roomCode);
    if (!room || !room.engine.gameStarted) return;

    const info = roomManager.socketToRoom.get(socket.id);
    if (!info) return;

    const demoRes = room.engine.executeDemoMove(info.color, tokenIndex, rollIndex);
    if (demoRes && demoRes.success) {
      if (!demoRes.continueDemo) {
        if (room.appealDemoTimer) {
          clearInterval(room.appealDemoTimer);
          room.appealDemoTimer = null;
        }

        if (!demoRes.appealSucceeded) {
          room.engine.finishTurn();
        }
        roomManager.resetTimer(room);
        io.to(roomCode).emit('APPEAL_RESOLVED', {
          success: demoRes.appealSucceeded,
          offendingColor: demoRes.offendingColor,
          offendingTokenIndex: demoRes.offendingTokenIndex,
          appealingColor: info.color,
          state: room.engine.getGameState()
        });
      } else {
        io.to(roomCode).emit('GAME_STATE_UPDATE', { state: room.engine.getGameState() });
      }
    }
  });

  // Send Chat / Reaction
  socket.on('SEND_CHAT', ({ roomCode, text, emote }) => {
    const info = roomManager.socketToRoom.get(socket.id);
    if (!info) return;
    const room = roomManager.rooms.get(roomCode);
    if (!room) return;

    const playerName = room.playerSlots[info.color]?.name || info.color;
    const chatItem = {
      sender: playerName,
      color: info.color,
      text: text || null,
      emote: emote || null,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chatHistory.push(chatItem);
    if (room.chatHistory.length > 50) room.chatHistory.shift();

    io.to(roomCode).emit('CHAT_MESSAGE', chatItem);
  });

  // Throw Item at Player
  socket.on('THROW_ITEM', ({ roomCode, targetColor, item }) => {
    const info = roomManager.socketToRoom.get(socket.id);
    if (!info) return;
    const room = roomManager.rooms.get(roomCode);
    if (!room) return;

    const fromColor = info.color;
    if (!fromColor || !targetColor || fromColor === targetColor) return;

    const targetSlot = room.playerSlots[targetColor];
    if (!targetSlot || !targetSlot.connected) return;

    const itemEmojiMap = {
      banana: '🍌',
      sandal: '👡',
      flower: '🌸',
      heart: '❤️',
      bomb: '💣',
      tomato: '🍅',
      egg: '🥚',
      poop: '💩'
    };

    const itemEmoji = itemEmojiMap[item] || '🎯';
    const senderName = room.playerSlots[fromColor]?.name || fromColor.toUpperCase();
    const targetName = room.playerSlots[targetColor]?.name || targetColor.toUpperCase();

    // Broadcast projectile action to all clients in the room
    io.to(roomCode).emit('ITEM_THROWN', {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      fromColor,
      targetColor,
      item,
      senderName,
      targetName
    });

    // Add chat system message
    const chatItem = {
      sender: 'System',
      text: `${senderName} threw a ${itemEmoji} at ${targetName}!`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.chatHistory.push(chatItem);
    if (room.chatHistory.length > 50) room.chatHistory.shift();
    io.to(roomCode).emit('CHAT_MESSAGE', chatItem);
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    const res = roomManager.leaveRoom(socket.id);
    if (res && !res.empty) {
      io.to(res.roomCode).emit('ROOM_UPDATED', { slots: res.room.playerSlots, settings: res.room.settings });
      io.to(res.roomCode).emit('GAME_STATE_UPDATE', { state: res.room.engine.getGameState() });
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Ludo Real-Time Server running on http://localhost:${PORT}`);
});
