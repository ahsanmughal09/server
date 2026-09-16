const LADDERS = {
  9: 31,
  20: 38,
  28: 84,
  40: 59,
  51: 73,
  63: 81,
  71: 91
};

const SNAKES = {
  17: 7,
  54: 34,
  62: 19,
  64: 60,
  87: 24,
  93: 73,
  95: 75,
  99: 78
};

class SnakesLaddersEngine {
  constructor(mode = '4P', teamMode = 'solo', turnTimer = 30, customRules = {}) {
    this.mode = '4P';
    this.gameType = 'snakes_and_ladders';
    this.teamMode = 'solo';
    this.turnTimer = turnTimer;
    this.customRules = customRules;
    this.colors = ['red', 'yellow', 'green', 'blue'];

    this.players = {};
    this.colors.forEach(color => {
      this.players[color] = {
        color,
        name: null,
        socketId: null,
        connected: false,
        position: 0, // 0 = off board, 1..100 = tiles
        rank: null,
        finished: false
      };
    });

    this.turnOrder = ['red', 'yellow', 'green', 'blue'];
    this.activeColor = 'red';
    this.gameStarted = false;
    this.gameOver = false;
    this.rankings = [];

    this.currentDice = null;
    this.dicePool = [];
    this.canRoll = true;
    this.validMoves = [];
    this.lastMoveResult = null;
  }

  addPlayer(color, socketId, name) {
    if (this.players[color]) {
      this.players[color].socketId = socketId;
      this.players[color].name = name || `Player ${color.toUpperCase()}`;
      this.players[color].connected = true;
    }
  }

  removePlayer(socketId) {
    for (const color of this.colors) {
      if (this.players[color].socketId === socketId) {
        this.players[color].connected = false;
      }
    }
  }

  startGame() {
    this.gameStarted = true;
    this.gameOver = false;

    // Set first active player as the first connected player
    const firstActive = this.turnOrder.find(c => this.players[c].connected) || 'red';
    this.activeColor = firstActive;
    this.canRoll = true;
    this.currentDice = null;
    this.dicePool = [];
    this.validMoves = [];
    this.lastMoveResult = null;
  }

  getActiveColor() {
    return this.activeColor;
  }

  rollDice() {
    if (!this.gameStarted || this.gameOver || !this.canRoll) return null;

    const roll = Math.floor(Math.random() * 6) + 1;
    this.currentDice = roll;
    this.dicePool = [roll];
    this.canRoll = false;

    const player = this.players[this.activeColor];
    const targetPos = player.position + roll;

    if (targetPos <= 100) {
      this.validMoves = [0]; // Token 0 can move
    } else {
      this.validMoves = []; // Beyond cell 100, cannot move
    }

    return {
      roll,
      canRoll: false,
      validMoves: this.validMoves,
      penalty: false,
      dicePool: [roll]
    };
  }

  moveToken(color, tokenIndex = 0) {
    if (!this.gameStarted || this.gameOver) return null;
    if (color !== this.activeColor) return null;
    if (this.validMoves.length === 0 || this.currentDice === null) return null;

    const player = this.players[color];
    const oldPos = player.position;
    const roll = this.currentDice;
    const stepPos = oldPos + roll;

    if (stepPos > 100) return null;

    let finalPos = stepPos;
    let isLadder = false;
    let isSnake = false;

    if (LADDERS[stepPos]) {
      finalPos = LADDERS[stepPos];
      isLadder = true;
    } else if (SNAKES[stepPos]) {
      finalPos = SNAKES[stepPos];
      isSnake = true;
    }

    player.position = finalPos;
    this.validMoves = [];

    let playerFinished = false;
    if (finalPos === 100) {
      player.finished = true;
      playerFinished = true;
      if (!player.rank) {
        this.rankings.push(color);
        player.rank = this.rankings.length;
      }
    }

    // Check if game is over (either 1 player wins or all active players finished)
    const activePlayers = this.colors.filter(c => this.players[c].connected);
    const unfinishedPlayers = activePlayers.filter(c => !this.players[c].finished);

    if (unfinishedPlayers.length <= 1 && activePlayers.length > 1) {
      this.gameOver = true;
    } else if (unfinishedPlayers.length === 0) {
      this.gameOver = true;
    }

    // Extra Turn if rolled 6 and didn't finish
    const gotExtraTurn = (roll === 6) && !playerFinished && !this.gameOver;

    const moveRes = {
      moveId: `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      success: true,
      color,
      from: oldPos,
      landedOn: stepPos,
      finalPos,
      isLadder,
      isSnake,
      roll,
      extraTurn: gotExtraTurn,
      playerFinished
    };

    this.lastMoveResult = moveRes;

    if (gotExtraTurn) {
      this.canRoll = true;
      this.currentDice = null;
      this.dicePool = [];
    } else {
      this.finishTurn();
    }

    return moveRes;
  }

  finishTurn() {
    if (this.gameOver) return;
    this.nextTurn();
  }

  nextTurn() {
    const connectedPlayers = this.turnOrder.filter(c => this.players[c].connected);
    if (connectedPlayers.length === 0) return;

    let currentIndex = connectedPlayers.indexOf(this.activeColor);
    let attempts = 0;

    do {
      currentIndex = (currentIndex + 1) % connectedPlayers.length;
      attempts++;
    } while (this.players[connectedPlayers[currentIndex]].finished && attempts < connectedPlayers.length);

    this.activeColor = connectedPlayers[currentIndex];
    this.canRoll = true;
    this.currentDice = null;
    this.dicePool = [];
    this.validMoves = [];
  }

  getSmartAutoMoveTokenIndex() {
    if (!this.canRoll && this.validMoves.length > 0) {
      return 0;
    }
    return null;
  }

  getGameState() {
    return {
      gameType: this.gameType,
      mode: this.mode,
      teamMode: this.teamMode,
      players: this.players,
      activeColor: this.activeColor,
      gameStarted: this.gameStarted,
      gameOver: this.gameOver,
      rankings: this.rankings,
      currentDice: this.currentDice,
      dicePool: this.dicePool,
      canRoll: this.canRoll,
      validMoves: this.validMoves,
      lastMoveResult: this.lastMoveResult,
      ladders: LADDERS,
      snakes: SNAKES
    };
  }
}

module.exports = SnakesLaddersEngine;
