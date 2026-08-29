/**
 * Core Ludo Engine supporting 4-Player Square & 6-Player Hexagonal modes,
 * custom diagonal teaming, server-authoritative move validation, and turn cycling.
 * Features Roll Balance (Dice Stacking) mechanic when rolling 6s,
 * and customizable house rules (extra turn on kill/home, kill required to enter home).
 */

const PLAYER_COLORS_4P = ['red', 'green', 'yellow', 'blue'];
const PLAYER_COLORS_6P = ['red', 'green', 'yellow', 'blue', 'orange', 'purple'];

class LudoEngine {
  constructor(mode = '4P', teamMode = 'solo', turnTimer = 30, customRules = {}) {
    this.mode = mode; // '4P' or '6P'
    this.teamMode = teamMode; // 4P: 'solo', '2v2' | 6P: 'solo', '3v3', '2v2v2'
    this.turnTimer = turnTimer;
    
    this.customRules = {
      diceCount: parseInt(customRules.diceCount || 1, 10),
      extraTurnOnKill: customRules.extraTurnOnKill !== false,
      extraTurnOnHome: customRules.extraTurnOnHome !== false,
      killRequiredToEnterHome: customRules.killRequiredToEnterHome !== false
    };

    this.colors = mode === '4P' ? PLAYER_COLORS_4P : PLAYER_COLORS_6P;
    this.trackLength = mode === '4P' ? 52 : 72;
    this.outerTrackLength = mode === '4P' ? 51 : 71;
    this.homeLength = 6;
    this.finishStep = mode === '4P' ? 56 : 76; // -1: yard, 0..outerTrackLength-1: main, outerTrackLength..finishStep: home stretch (56/76 is finished)
    
    this.startPositions = mode === '4P' ? {
      red: 0,
      green: 13,
      yellow: 26,
      blue: 39
    } : {
      red: 0,
      green: 12,
      yellow: 24,
      blue: 36,
      orange: 48,
      purple: 60
    };

    this.safeSpots = mode === '4P' 
      ? [0, 8, 13, 21, 26, 34, 39, 47]
      : [0, 8, 12, 20, 24, 32, 36, 44, 48, 56, 60, 68];

    // Teams mapping
    this.teams = this.initTeams();

    // Player states: { [color]: { name, socketId, connected, kills, appealsLeft: 3, tokens: [-1, -1, -1, -1] } }
    this.players = {};
    this.activePlayerIndex = 0;
    this.dicePool = [];
    this.selectedRollIndex = 0;
    this.canRoll = true;
    this.hasExtraTurn = false;
    this.currentDice = null;
    this.consecutiveSixes = 0;
    this.gameStarted = false;
    this.gameOver = false;
    this.winner = null;
    this.validMoves = [];
    this.lastAction = null; // { type, color, tokenIndex, rolled, captured }

    // Appeal System State & Snapshots (Zero-Wait Turn Rollback)
    this.turnStartSnapshot = null;
    this.turnDiceRolls = [];
    this.lastTurnSnapshot = null;
    this.lastTurnDiceRolls = [];
    this.lastTurnOffendingColor = null;
    this.canAppealLastTurn = false;
    this.preMoveSnapshot = null;
    this.postMoveSnapshot = null;
    this.appealState = {
      inWindow: false,
      inDemo: false,
      appealingColor: null,
      offendingColor: null,
      windowTimeLeft: 0,
      demoTimeLeft: 0,
      demoDicePool: []
    };
  }

  initTeams() {
    const teams = {};
    if (this.mode === '4P') {
      if (this.teamMode === '2v2') {
        teams.red = 'Team Alpha';
        teams.yellow = 'Team Alpha';
        teams.green = 'Team Beta';
        teams.blue = 'Team Beta';
      } else {
        this.colors.forEach(c => teams[c] = c.toUpperCase());
      }
    } else { // 6P
      if (this.teamMode === '3v3') {
        teams.red = 'Team Alpha';
        teams.yellow = 'Team Alpha';
        teams.blue = 'Team Alpha';
        teams.green = 'Team Beta';
        teams.purple = 'Team Beta';
        teams.orange = 'Team Beta';
      } else if (this.teamMode === '2v2v2') {
        teams.orange = 'Team Green-Orange';
        teams.yellow = 'Team Yellow-Purple';
        teams.purple = 'Team Yellow-Purple';
      } else {
        this.colors.forEach(c => teams[c] = c.toUpperCase());
      }
    }
    return teams;
  }

  addPlayer(color, socketId, name) {
    if (!this.colors.includes(color)) return false;
    this.players[color] = {
      color,
      name: name || color.toUpperCase(),
      socketId,
      connected: true,
      kills: 0,
      appealsLeft: 3,
      tokens: [-1, -1, -1, -1] // step index for 4 tokens
    };
    return true;
  }

  removePlayer(socketId) {
    for (const color of this.colors) {
      if (this.players[color] && this.players[color].socketId === socketId) {
        this.players[color].connected = false;
        return color;
      }
    }
    return null;
  }

  startGame() {
    this.gameStarted = true;
    this.activePlayerIndex = 0;
    this.dicePool = [];
    this.selectedRollIndex = 0;
    this.canRoll = true;
    this.hasExtraTurn = false;
    this.currentDice = null;
    this.consecutiveSixes = 0;
    this.validMoves = [];

    // If 2-player match or fewer than max players, force distinct opponent teams so captures always work!
    const activeColors = Object.keys(this.players).filter(c => this.players[c] && this.players[c].connected);
    if (activeColors.length < (this.mode === '4P' ? 4 : 6) || this.teamMode === 'solo') {
      this.colors.forEach(c => {
        this.teams[c] = c.toUpperCase();
      });
    }
  }

  getActiveColor() {
    return this.colors[this.activePlayerIndex];
  }

  saveTurnStartSnapshot() {
    this.turnStartSnapshot = {
      players: JSON.parse(JSON.stringify(this.players)),
      activePlayerIndex: this.activePlayerIndex,
      color: this.getActiveColor()
    };
    this.turnDiceRolls = [];
    this.hasExtraTurn = false;
  }

  rollDice(selectedDiceIndex = 0) {
    if (!this.gameStarted || this.gameOver || !this.canRoll) return null;

    if (!this.turnStartSnapshot) {
      this.saveTurnStartSnapshot();
    }

    if (this.customRules.diceCount === 2) {
      const allInHome = this.areAllTokensInHome(this.getActiveColor());

      if (allInHome) {
        // Player's tokens are all in Home -> Roll ONLY 1 chosen dice (Purple = 0, White = 1)
        const chosenIdx = (selectedDiceIndex === 1) ? 1 : 0;
        const roll = Math.floor(Math.random() * 6) + 1;
        this.currentDice = chosenIdx === 1 ? [null, roll] : [roll, null];
        this.turnDiceRolls.push(roll);
        this.dicePool = [roll];
        this.isHomeDiceSelectionMode = true;
        this.consecutiveSixes = 0;
        this.canRoll = false; // NO extra roll turn on 6 when all tokens are in Home!

        this.autoSelectValidRoll();

        if (this.validMoves.length === 0) {
          this.lastAction = { type: 'NO_VALID_MOVES', color: this.getActiveColor(), rolled: this.currentDice, dicePool: [...this.dicePool] };
        } else {
          this.lastAction = { type: 'ROLLED_NUMBER', color: this.getActiveColor(), rolled: this.currentDice, dicePool: [...this.dicePool] };
        }

        return { roll: this.currentDice, penalty: false, dicePool: this.dicePool, canRoll: false, validMoves: this.validMoves };
      }

      this.isHomeDiceSelectionMode = false;
      const roll1 = Math.floor(Math.random() * 6) + 1;
      const roll2 = Math.floor(Math.random() * 6) + 1;
      this.currentDice = [roll1, roll2];
      this.turnDiceRolls.push(roll1, roll2);

      const isDoubleSix = (roll1 === 6 && roll2 === 6);

      if (isDoubleSix) {
        this.consecutiveSixes += 2;
        if (this.consecutiveSixes >= 4) { // 4 sixes across 2 rolls -> penalty!
          this.consecutiveSixes = 0;
          this.dicePool = [];
          this.canRoll = false;
          this.validMoves = [];
          this.lastAction = { type: 'FOUR_SIXES_PENALTY', color: this.getActiveColor(), rolled: [6, 6] };
          this.nextTurn();
          return { roll: [6, 6], penalty: true, dicePool: [], canRoll: false, validMoves: [] };
        }

        // Double 6s grants extra roll turn!
        this.dicePool.push(6, 6);
        this.canRoll = true;
        this.validMoves = [];
        this.lastAction = { type: 'ROLLED_DOUBLE_SIX', color: this.getActiveColor(), rolled: [6, 6], dicePool: [...this.dicePool] };
        return { roll: [6, 6], penalty: false, dicePool: this.dicePool, canRoll: true, validMoves: [] };
      }

      // Non-double 6s roll (e.g. [6, 4] or [3, 2]): push both, no extra roll turn
      this.consecutiveSixes = 0;
      this.dicePool.push(roll1, roll2);
      this.canRoll = false;

      const hasMoves = this.autoSelectValidRoll();

      if (!hasMoves) {
        // No complete sequence can consume ALL dice in the pool -> use none!
        this.dicePool = [];
        this.validMoves = [];
        this.lastAction = { type: 'NO_VALID_MOVES', color: this.getActiveColor(), rolled: [roll1, roll2], dicePool: [] };
      } else {
        this.lastAction = { type: 'ROLLED_DICE', color: this.getActiveColor(), rolled: [roll1, roll2], dicePool: [...this.dicePool] };
      }

      return { roll: [roll1, roll2], penalty: false, dicePool: this.dicePool, canRoll: false, validMoves: this.validMoves };
    }

    // Standard 1-Dice Roll logic
    const roll = Math.floor(Math.random() * 6) + 1;
    this.currentDice = roll;
    this.turnDiceRolls.push(roll);

    if (roll === 6) {
      this.consecutiveSixes++;
      if (this.consecutiveSixes === 3) {
        this.consecutiveSixes = 0;
        this.dicePool = [];
        this.canRoll = false;
        this.lastAction = { type: 'THREE_SIXES_PENALTY', color: this.getActiveColor(), rolled: 6 };
        this.nextTurn();
        return { roll: 6, penalty: true, dicePool: [], canRoll: false, validMoves: [] };
      }

      this.dicePool.push(6);
      this.canRoll = true;
      this.validMoves = [];
      this.lastAction = { type: 'ROLLED_SIX', color: this.getActiveColor(), rolled: 6, dicePool: [...this.dicePool] };
      return { roll: 6, penalty: false, dicePool: this.dicePool, canRoll: true, validMoves: [] };
    }

    // Non-6 rolled
    this.consecutiveSixes = 0;
    this.dicePool.push(roll);
    this.canRoll = false;

    // Find first roll in dicePool that has valid moves
    const hasMoves = this.autoSelectValidRoll();

    if (!hasMoves) {
      this.dicePool = [];
      this.validMoves = [];
      this.lastAction = { type: 'NO_VALID_MOVES', color: this.getActiveColor(), rolled: roll, dicePool: [] };
    } else {
      this.lastAction = { type: 'ROLLED_NUMBER', color: this.getActiveColor(), rolled: roll, dicePool: [...this.dicePool] };
    }

    return { roll, penalty: false, dicePool: this.dicePool, canRoll: false, validMoves: this.validMoves };
  }

  canTokenMoveWithRoll(color, step, roll, hasKill) {
    if (step === undefined || step === null || roll === undefined || roll === null) return false;
    const outerLen = this.outerTrackLength || (this.mode === '4P' ? 51 : 71);
    const lastSafeStep = this.mode === '4P' ? 47 : 68;
    const killRequired = !!this.customRules.killRequiredToEnterHome;

    if (step === -1) {
      return roll === 6;
    }
    if (step === this.finishStep) {
      return false; // already in home finished
    }
    if (step >= outerLen) {
      return (step + roll <= this.finishStep);
    }
    
    // On main perimeter track (0..outerLen-1)
    const targetStep = step + roll;
    if (!killRequired || hasKill) {
      return targetStep <= this.finishStep;
    } else {
      if (targetStep <= lastSafeStep) {
        return true;
      } else if (targetStep < outerLen) {
        const targetAbsPos = (this.startPositions[color] + targetStep) % this.trackLength;
        return (!this.safeSpots.includes(targetAbsPos) && this.hasOpponentTokenAt(color, targetAbsPos));
      }
      return false;
    }
  }

  getNextStepForToken(step, roll) {
    if (step === -1) return 0;
    return step + roll;
  }

  // Recursive check whether currentTokens can consume ALL dice in remainingDicePool
  canConsumeAllDice(color, currentTokens, remainingDicePool, hasKill) {
    if (remainingDicePool.length === 0) return true;

    for (let rIdx = 0; rIdx < remainingDicePool.length; rIdx++) {
      const roll = remainingDicePool[rIdx];
      for (let tIdx = 0; tIdx < currentTokens.length; tIdx++) {
        const step = currentTokens[tIdx];
        if (this.canTokenMoveWithRoll(color, step, roll, hasKill)) {
          const nextStep = this.getNextStepForToken(step, roll);
          const nextTokens = [...currentTokens];
          nextTokens[tIdx] = nextStep;

          let nextHasKill = hasKill;
          if (!hasKill && nextStep >= 0 && nextStep < this.outerTrackLength) {
            const absPos = (this.startPositions[color] + nextStep) % this.trackLength;
            if (!this.safeSpots.includes(absPos) && this.hasOpponentTokenAt(color, absPos)) {
              nextHasKill = true;
            }
          }

          const nextPool = remainingDicePool.slice(0, rIdx).concat(remainingDicePool.slice(rIdx + 1));
          if (this.canConsumeAllDice(color, nextTokens, nextPool, nextHasKill)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Get all valid (tokenIndex, rollIndex) pairs that are part of at least ONE complete sequence that uses ALL dice in this.dicePool
  getValidMovesForPool(color) {
    const player = this.players[color];
    if (!player || !player.tokens || !this.dicePool || this.dicePool.length === 0) {
      return { validFirstMoves: [], movesByRollIndex: {} };
    }

    const currentTokens = [...player.tokens];
    const hasKill = (player.kills || 0) > 0;
    const validFirstMoves = [];
    const movesByRollIndex = {};

    for (let rIdx = 0; rIdx < this.dicePool.length; rIdx++) {
      movesByRollIndex[rIdx] = [];
      const roll = this.dicePool[rIdx];

      for (let tIdx = 0; tIdx < currentTokens.length; tIdx++) {
        const step = currentTokens[tIdx];
        if (this.canTokenMoveWithRoll(color, step, roll, hasKill)) {
          const nextStep = this.getNextStepForToken(step, roll);
          const nextTokens = [...currentTokens];
          nextTokens[tIdx] = nextStep;

          let nextHasKill = hasKill;
          if (!hasKill && nextStep >= 0 && nextStep < this.outerTrackLength) {
            const absPos = (this.startPositions[color] + nextStep) % this.trackLength;
            if (!this.safeSpots.includes(absPos) && this.hasOpponentTokenAt(color, absPos)) {
              nextHasKill = true;
            }
          }

          const nextPool = this.dicePool.slice(0, rIdx).concat(this.dicePool.slice(rIdx + 1));
          if (this.canConsumeAllDice(color, nextTokens, nextPool, nextHasKill)) {
            validFirstMoves.push({ tokenIndex: tIdx, rollIndex: rIdx, roll });
            if (!movesByRollIndex[rIdx].includes(tIdx)) {
              movesByRollIndex[rIdx].push(tIdx);
            }
          }
        }
      }
    }

    return { validFirstMoves, movesByRollIndex };
  }

  autoSelectValidRoll() {
    const activeColor = this.getActiveColor();
    const { validFirstMoves, movesByRollIndex } = this.getValidMovesForPool(activeColor);

    if (validFirstMoves.length === 0) {
      this.selectedRollIndex = 0;
      this.validMoves = [];
      return false;
    }

    // If current selectedRollIndex has valid moves, keep it
    if (movesByRollIndex[this.selectedRollIndex] && movesByRollIndex[this.selectedRollIndex].length > 0) {
      this.validMoves = movesByRollIndex[this.selectedRollIndex];
      return true;
    }

    // Otherwise select first rollIndex that has valid moves
    for (let rIdx = 0; rIdx < this.dicePool.length; rIdx++) {
      if (movesByRollIndex[rIdx] && movesByRollIndex[rIdx].length > 0) {
        this.selectedRollIndex = rIdx;
        this.validMoves = movesByRollIndex[rIdx];
        return true;
      }
    }

    this.selectedRollIndex = 0;
    this.validMoves = [];
    return false;
  }

  getSmartAutoMoveTokenIndex() {
    if (this.canRoll || this.dicePool.length === 0 || this.gameOver) return null;

    const activeColor = this.getActiveColor();
    const { validFirstMoves } = this.getValidMovesForPool(activeColor);

    // Find all unique token indices that have a valid move in the current pool
    const uniqueTokens = Array.from(new Set(validFirstMoves.map(m => m.tokenIndex)));

    // Auto-move IF AND ONLY IF exactly 1 unique token has valid moves across all available rolls!
    if (uniqueTokens.length === 1) {
      return uniqueTokens[0];
    }

    return null;
  }

  selectRoll(rollIndex) {
    if (rollIndex < 0 || rollIndex >= this.dicePool.length) return false;
    this.selectedRollIndex = rollIndex;
    const { movesByRollIndex } = this.getValidMovesForPool(this.getActiveColor());
    this.validMoves = movesByRollIndex[rollIndex] || [];
    return true;
  }

  hasOpponentTokenAt(myColor, absStep) {
    for (const c of this.colors) {
      if (c === myColor) continue;
      const p = this.players[c];
      if (!p) continue;
      for (const step of p.tokens) {
        if (step >= 0 && step < this.outerTrackLength) {
          const pAbs = (this.startPositions[c] + step) % this.trackLength;
          if (pAbs === absStep) return true;
        }
      }
    }
    return false;
  }

  calculateValidMoves(color, roll) {
    const { movesByRollIndex } = this.getValidMovesForPool(color);
    for (let rIdx = 0; rIdx < this.dicePool.length; rIdx++) {
      if (this.dicePool[rIdx] === roll && movesByRollIndex[rIdx]) {
        return movesByRollIndex[rIdx];
      }
    }
    return [];
  }

  // Convert token's relative step (-1, 0..finishStep) to absolute board step (0..trackLength-1 or home identifier)
  getGlobalPosition(color, step) {
    if (step === -1) return { type: 'YARD', color, id: `yard-${color}` };
    const outerLen = this.outerTrackLength || (this.mode === '4P' ? 51 : 71);
    if (step >= outerLen) {
      const homeIdx = step - outerLen;
      return { type: 'HOME_PATH', color, step: homeIdx, id: `home-${color}-${homeIdx}` };
    }
    
    const startPos = this.startPositions[color];
    const absStep = (startPos + step) % this.trackLength;
    return { type: 'MAIN', step: absStep, id: `main-${absStep}` };
  }

  moveToken(color, tokenIndex, explicitRollIndex = null) {
    if (color !== this.getActiveColor() || this.canRoll || this.dicePool.length === 0) return null;

    let useIndex = explicitRollIndex !== null ? explicitRollIndex : this.selectedRollIndex;
    if (useIndex < 0 || useIndex >= this.dicePool.length) {
      useIndex = this.selectedRollIndex;
    }

    const { movesByRollIndex } = this.getValidMovesForPool(color);
    const validTokensForRoll = movesByRollIndex[useIndex] || [];
    if (!validTokensForRoll.includes(tokenIndex)) return null;

    const player = this.players[color];
    const oldStep = player.tokens[tokenIndex];

    let newStep;
    if (oldStep === -1) {
      newStep = 0; // enter track at step 0
    } else {
      newStep = oldStep + roll;
    }

    this.savePreMoveSnapshot();
    player.tokens[tokenIndex] = newStep;
    const oldPos = this.getGlobalPosition(color, oldStep);
    const newPos = this.getGlobalPosition(color, newStep);

    let captured = null;
    // Check capture only if landing on main loop track
    if (newPos.type === 'MAIN' && !this.safeSpots.includes(newPos.step)) {
      captured = this.checkCapture(color, newPos.step);
    }

    const reachesHome = (newStep === this.finishStep && oldStep !== this.finishStep);

    // Remove executed roll from dicePool
    this.dicePool.splice(useIndex, 1);

    // Check extra turn rules
    const extraOnKill = (captured !== null) && this.customRules.extraTurnOnKill;
    const extraOnHome = reachesHome && this.customRules.extraTurnOnHome;

    if (extraOnKill || extraOnHome) {
      this.hasExtraTurn = true;
    }

    this.lastAction = {
      type: 'MOVE',
      color,
      tokenIndex,
      oldStep,
      newStep,
      rolled: roll,
      captured,
      reachesHome
    };

    // Check Win Condition
    const gameWon = this.checkWinCondition();
    if (gameWon) {
      this.gameOver = true;
      this.winner = this.teams[color] || color;
      return { success: true, gameOver: true, winner: this.winner, action: this.lastAction };
    }

    let turnFinished = false;
    // Check remaining dice pool or single dice selection mode for home tokens
    if (this.isHomeDiceSelectionMode) {
      this.dicePool = [];
      this.isHomeDiceSelectionMode = false;
      turnFinished = true;
    } else if (this.dicePool.length > 0) {
      const hasMoves = this.autoSelectValidRoll();
      if (!hasMoves) {
        // No remaining valid moves for any dice in pool -> clear pool
        this.dicePool = [];
        turnFinished = true;
      }
    } else {
      turnFinished = true;
    }

    if (turnFinished) {
      if (this.turnStartSnapshot) {
        this.lastTurnSnapshot = this.turnStartSnapshot;
        this.lastTurnDiceRolls = [...this.turnDiceRolls];
        this.lastTurnOffendingColor = color;
        this.canAppealLastTurn = true;
      }
      this.finishTurn();
    }

    // Save post-move snapshot for appeal rollback
    this.savePostMoveSnapshot();

    return { success: true, gameOver: false, turnFinished, action: this.lastAction };
  }

  finishTurn() {
    this.turnStartSnapshot = null;
    this.turnDiceRolls = [];
    this.appealState.inWindow = false;
    this.appealState.inDemo = false;
    if (this.hasExtraTurn) {
      this.grantExtraTurn();
    } else {
      this.nextTurn();
    }
  }

  savePreMoveSnapshot() {
    this.preMoveSnapshot = {
      players: JSON.parse(JSON.stringify(this.players)),
      activePlayerIndex: this.activePlayerIndex,
      dicePool: [...this.dicePool],
      canRoll: this.canRoll,
      hasExtraTurn: this.hasExtraTurn,
      consecutiveSixes: this.consecutiveSixes,
      color: this.getActiveColor()
    };
  }

  savePostMoveSnapshot() {
    this.postMoveSnapshot = {
      players: JSON.parse(JSON.stringify(this.players)),
      activePlayerIndex: this.activePlayerIndex,
      dicePool: [...this.dicePool],
      canRoll: this.canRoll,
      hasExtraTurn: this.hasExtraTurn,
      consecutiveSixes: this.consecutiveSixes,
      lastAction: this.lastAction ? { ...this.lastAction } : null
    };
  }

  openAppealWindow() {
    this.appealState = {
      inWindow: true,
      inDemo: false,
      appealingColor: null,
      offendingColor: this.lastAction?.color || this.getActiveColor(),
      windowTimeLeft: 5,
      demoTimeLeft: 10,
      demoDicePool: []
    };
  }

  closeAppealWindow() {
    this.appealState.inWindow = false;
    this.turnStartSnapshot = null;
    this.turnDiceRolls = [];
  }

  submitAppeal(appealingColor) {
    if (!this.canAppealLastTurn || !this.lastTurnSnapshot) {
      return { success: false, error: 'No turn available to appeal' };
    }
    const player = this.players[appealingColor];
    if (!player || (player.appealsLeft || 0) <= 0) {
      return { success: false, error: 'No appeals remaining' };
    }

    const offendingColor = this.lastTurnOffendingColor;
    if (!offendingColor || offendingColor === appealingColor) {
      return { success: false, error: 'Cannot appeal own turn' };
    }

    // Enter Appeal Demonstration Mode
    this.canAppealLastTurn = false;
    this.appealState.inWindow = false;
    this.appealState.inDemo = true;
    this.appealState.appealingColor = appealingColor;
    this.appealState.offendingColor = offendingColor;
    this.appealState.demoTimeLeft = 10;

    const demoPool = [...this.lastTurnDiceRolls];
    this.appealState.demoDicePool = demoPool;

    // Temporarily rollback board to start of offending player's turn for demonstration
    this.players = JSON.parse(JSON.stringify(this.lastTurnSnapshot.players));
    this.dicePool = [...demoPool];

    // Clear previous move action so tokens stay stationary until demo tap!
    this.lastAction = { type: 'APPEAL_SUBMIT', appealingColor, offendingColor };

    return { success: true, appealState: this.appealState };
  }

  executeDemoMove(appealingColor, tokenIndex, rollIndex = 0) {
    if (!this.appealState.inDemo || this.appealState.appealingColor !== appealingColor) {
      return { success: false, error: 'Not in appeal demonstration mode' };
    }

    const offendingColor = this.appealState.offendingColor;
    const offendingPlayer = this.players[offendingColor];
    if (!offendingPlayer) return { success: false, error: 'Offending player missing' };

    const useRollIdx = (rollIndex >= 0 && rollIndex < this.dicePool.length) ? rollIndex : 0;
    const roll = this.dicePool[useRollIdx];
    if (!roll) return { success: false, error: 'No remaining dice in demonstration queue' };

    // Splice executed roll from demo pool
    this.dicePool.splice(useRollIdx, 1);
    this.appealState.demoDicePool = [...this.dicePool];

    const oldStep = offendingPlayer.tokens[tokenIndex];
    if (oldStep === undefined) return { success: false, error: 'Invalid token index' };

    let newStep = oldStep === -1 ? 0 : oldStep + roll;
    offendingPlayer.tokens[tokenIndex] = newStep;

    const newPos = this.getGlobalPosition(offendingColor, newStep);
    let captured = null;
    if (newPos.type === 'MAIN' && !this.safeSpots.includes(newPos.step)) {
      captured = this.checkCapture(offendingColor, newPos.step);
    }

    const offendingTeam = this.teams[offendingColor];
    const isOpponentCaptured = captured && (this.teams[captured.color] !== offendingTeam);

    if (isOpponentCaptured) {
      // SUCCESSFUL DEMONSTRATION! Missed kill proven!
      this.appealState.inDemo = false;
      this.appealState.inWindow = false;

      // Get postMoveSnapshot positions for offending player's tokens
      const postMoveTokens = this.postMoveSnapshot && this.postMoveSnapshot.players[offendingColor] 
        ? [...this.postMoveSnapshot.players[offendingColor].tokens] 
        : null;

      // Restore board to postMoveSnapshot
      if (this.postMoveSnapshot) {
        this.players = JSON.parse(JSON.stringify(this.postMoveSnapshot.players));
      }

      // Penalize offending player's token (send to home yard -1)
      if (this.players[offendingColor]) {
        this.players[offendingColor].tokens[tokenIndex] = -1;
      }

      // Completely clear turn memory and dice queue
      this.turnStartSnapshot = null;
      this.turnDiceRolls = [];
      this.dicePool = [];
      this.selectedRollIndex = 0;
      this.validMoves = [];
      this.hasExtraTurn = false;
      this.currentDice = null;

      // Transfer active turn directly to appealing player!
      const appealingIdx = this.colors.indexOf(appealingColor);
      if (appealingIdx !== -1) {
        this.activePlayerIndex = appealingIdx;
      }
      this.canRoll = true;

      // Record DEMO_MOVE action for smooth 3-stage frontend animation & banner
      this.lastAction = {
        type: 'DEMO_MOVE',
        color: offendingColor,
        tokenIndex: tokenIndex,
        oldStep: oldStep,
        targetStep: newStep,
        penalized: true,
        appealingColor: appealingColor,
        postMoveTokens: postMoveTokens
      };

      this.savePostMoveSnapshot();

      return {
        success: true,
        appealSucceeded: true,
        offendingColor,
        offendingTokenIndex: tokenIndex,
        appealingColor
      };
    } else {
      // If there are still dice left in pool, allow challenger to continue demonstration
      if (this.dicePool.length > 0) {
        return {
          success: true,
          appealSucceeded: false,
          continueDemo: true,
          demoDicePool: this.dicePool
        };
      }

      // No dice left & no capture demonstrated -> Appeal Fails
      return this.failAppeal(appealingColor);
    }
  }

  failAppeal(appealingColor) {
    this.appealState.inDemo = false;
    this.appealState.inWindow = false;

    // Restore board to postMoveSnapshot
    if (this.postMoveSnapshot) {
      this.players = JSON.parse(JSON.stringify(this.postMoveSnapshot.players));
    }

    // Deduct 1 appeal from challenger
    if (this.players[appealingColor]) {
      this.players[appealingColor].appealsLeft = Math.max(0, (this.players[appealingColor].appealsLeft || 3) - 1);
    }

    // Completely clear turn memory and dice queue
    this.turnStartSnapshot = null;
    this.turnDiceRolls = [];
    this.dicePool = [];
    this.selectedRollIndex = 0;
    this.validMoves = [];

    this.savePostMoveSnapshot();

    return {
      success: true,
      appealSucceeded: false,
      appealingColor
    };
  }

  grantExtraTurn() {
    this.turnStartSnapshot = null;
    this.turnDiceRolls = [];
    this.hasExtraTurn = false;
    this.dicePool = [];
    this.selectedRollIndex = 0;
    this.canRoll = true;
    this.currentDice = null;
    this.consecutiveSixes = 0;
    this.validMoves = [];
  }

  checkCapture(movingColor, targetMainStep) {
    const movingTeam = this.teams[movingColor];

    for (const color of this.colors) {
      // Don't capture own tokens or teammate's tokens
      if (this.teams[color] === movingTeam) continue;

      const otherPlayer = this.players[color];
      if (!otherPlayer) continue;

      for (let tIdx = 0; tIdx < 4; tIdx++) {
        const step = otherPlayer.tokens[tIdx];
        const globalPos = this.getGlobalPosition(color, step);

        if (globalPos.type === 'MAIN' && globalPos.step === targetMainStep) {
          // Send captured token back to yard (-1)
          otherPlayer.tokens[tIdx] = -1;
          if (this.players[movingColor]) {
            this.players[movingColor].kills = (this.players[movingColor].kills || 0) + 1;
          }
          return { color, tokenIndex: tIdx, oldStep: step };
        }
      }
    }
    return null;
  }

  checkWinCondition() {
    // Check if team of active player has completed all member tokens
    const teamName = this.teams[this.getActiveColor()];
    const teamColors = this.colors.filter(c => this.teams[c] === teamName);

    for (const c of teamColors) {
      const p = this.players[c];
      if (!p) return false;
      const allFinished = p.tokens.every(step => step === this.finishStep);
      if (!allFinished) return false;
    }
    return true;
  }

  nextTurn() {
    this.turnStartSnapshot = null;
    this.turnDiceRolls = [];
    this.dicePool = [];
    this.selectedRollIndex = 0;
    this.canRoll = true;
    this.hasExtraTurn = false;
    this.currentDice = null;
    this.validMoves = [];
    let nextIdx = (this.activePlayerIndex + 1) % this.colors.length;

    // Loop until we find a CONNECTED player who hasn't fully finished all tokens
    let attempts = 0;
    while (attempts < this.colors.length) {
      const nextColor = this.colors[nextIdx];
      const p = this.players[nextColor];
      if (p && p.connected !== false && !p.tokens.every(s => s === this.finishStep)) {
        this.activePlayerIndex = nextIdx;
        return;
      }
      nextIdx = (nextIdx + 1) % this.colors.length;
      attempts++;
    }
  }

  areAllTokensInHome(color) {
    const p = this.players[color];
    if (!p || !p.tokens) return false;
    const outerLen = this.outerTrackLength || (this.mode === '4P' ? 51 : 71);
    return p.tokens.every(step => step >= outerLen);
  }

  getGameState() {
    let exportedDice = this.currentDice;
    if (exportedDice === null || exportedDice === undefined) {
      exportedDice = this.dicePool[this.selectedRollIndex] || (this.dicePool.length > 0 ? this.dicePool[0] : null);
    }

    return {
      mode: this.mode,
      teamMode: this.teamMode,
      turnTimer: this.turnTimer,
      customRules: this.customRules,
      colors: this.colors,
      teams: this.teams,
      players: this.players,
      activeColor: this.getActiveColor(),
      currentDice: exportedDice,
      dicePool: this.dicePool,
      selectedRollIndex: this.selectedRollIndex,
      canRoll: this.canRoll,
      hasExtraTurn: this.hasExtraTurn,
      validMoves: this.validMoves,
      gameStarted: this.gameStarted,
      gameOver: this.gameOver,
      winner: this.winner,
      safeSpots: this.safeSpots,
      lastAction: this.lastAction,
      appealState: this.appealState,
      finishStep: this.finishStep,
      canAppealLastTurn: this.canAppealLastTurn,
      lastTurnOffendingColor: this.lastTurnOffendingColor,
      isHomeDiceSelectionMode: !!this.isHomeDiceSelectionMode,
      allTokensInHome: this.areAllTokensInHome(this.getActiveColor())
    };
  }
}

module.exports = LudoEngine;
