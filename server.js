const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const COLORS = ['red', 'yellow', 'green', 'blue'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const AVATAR_COLORS = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63'];

// ─── IN-MEMORY ────────────────────────────────────────────────────────────────
const rooms = {};
const users = {};

// ─── DECK ─────────────────────────────────────────────────────────────────────
function buildDeck() {
    const deck = [];
    let id = 0;
    COLORS.forEach(color => {
        VALUES.forEach(value => {
            const count = value === '0' ? 1 : 2;
            for (let i = 0; i < count; i++) {
                deck.push({ id: id++, color, value, type: 'normal' });
            }
        });
    });
    for (let i = 0; i < 4; i++) deck.push({ id: id++, color: 'wild', value: 'wild', type: 'wild' });
    for (let i = 0; i < 4; i++) deck.push({ id: id++, color: 'wild', value: 'draw4', type: 'wild' });
    return deck;
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ─── ROOM ────────────────────────────────────────────────────────────────────
function createRoom(roomId) {
    return {
        id: roomId,
        players: {},
        order: [],
        turnIdx: 0,
        direction: 1,
        deck: [],
        discard: [],
        topCard: null,
        activeColor: null,
        started: false,
        winner: null,
        scores: {},
        round: 1,
        drawStack: 0,
        unoCallers: new Set(),
    };
}

function dealGame(room) {
    room.deck = shuffle(buildDeck());
    room.discard = [];
    room.winner = null;
    room.direction = 1;
    room.drawStack = 0;
    room.unoCallers = new Set();

    room.order.forEach(pid => {
        room.players[pid].hand = [];
        for (let i = 0; i < 7; i++) room.players[pid].hand.push(room.deck.pop());
    });

    let first;
    do { first = room.deck.pop(); } while (first.type === 'wild');
    room.discard.push(first);
    room.topCard = first;
    room.activeColor = first.color;

    if (first.value === 'reverse') room.direction = -1;
    if (first.value === 'skip') advanceTurn(room, true);
    else room.turnIdx = 0;
}

function advanceTurn(room, skipExtra = false) {
    const n = room.order.length;
    room.turnIdx = ((room.turnIdx + room.direction) % n + n) % n;
    if (skipExtra) room.turnIdx = ((room.turnIdx + room.direction) % n + n) % n;
}

function currentPlayer(room) {
    return room.order[room.turnIdx];
}

function canPlay(card, topCard, activeColor, drawStack) {
    if (drawStack > 0) {
        if (topCard.value === 'draw2') return card.value === 'draw2';
        if (topCard.value === 'draw4') return card.value === 'draw4';
    }
    if (card.type === 'wild') return true;
    return card.color === activeColor || card.value === topCard.value;
}

function playCard(room, pid, cardId, chosenColor) {
    if (currentPlayer(room) !== pid) return { ok: false, msg: 'Senin sıran değil!' };
    const player = room.players[pid];
    const idx = player.hand.findIndex(c => c.id === cardId);
    if (idx === -1) return { ok: false, msg: 'Kart elde yok!' };
    const card = player.hand[idx];
    if (!canPlay(card, room.topCard, room.activeColor, room.drawStack))
        return { ok: false, msg: 'Bu kart oynanamaz!' };

    player.hand.splice(idx, 1);
    room.discard.push(card);
    room.topCard = card;

    if (card.type === 'wild') {
        room.activeColor = chosenColor || 'red';
        if (card.value === 'draw4') room.drawStack += 4;
        advanceTurn(room);
    } else {
        room.activeColor = card.color;
        switch (card.value) {
            case 'skip': advanceTurn(room, true); break;
            case 'reverse':
                room.direction *= -1;
                if (room.order.length === 2) advanceTurn(room, true);
                else advanceTurn(room);
                break;
            case 'draw2':
                room.drawStack += 2;
                advanceTurn(room);
                break;
            default:
                advanceTurn(room);
        }
    }

    if (player.hand.length === 0) room.winner = pid;
    return { ok: true, card };
}

function drawCards(room, pid) {
    if (currentPlayer(room) !== pid) return { ok: false, msg: 'Senin sıran değil!' };
    const player = room.players[pid];
    const count = room.drawStack > 0 ? room.drawStack : 1;
    room.drawStack = 0;

    const drawn = [];
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            const top = room.discard.pop();
            room.deck = shuffle(room.discard);
            room.discard = [top];
        }
        if (room.deck.length > 0) {
            const c = room.deck.pop();
            player.hand.push(c);
            drawn.push(c);
        }
    }

    const playable = count === 1 && drawn.length > 0 &&
        canPlay(drawn[0], room.topCard, room.activeColor, 0);

    if (!playable || count > 1) advanceTurn(room);

    return { ok: true, drawn, playable: count === 1 ? playable : false, count };
}

function calcScore(room) {
    Object.keys(room.players).forEach(pid => {
        if (!room.scores[pid]) room.scores[pid] = 0;
    });
    const winner = room.winner;
    if (!winner) return;
    let pts = 0;
    Object.entries(room.players).forEach(([pid, p]) => {
        if (pid === winner) return;
        p.hand.forEach(c => {
            if (c.type === 'wild') pts += 50;
            else if (['skip', 'reverse', 'draw2'].includes(c.value)) pts += 20;
            else pts += parseInt(c.value) || 0;
        });
    });
    room.scores[winner] = (room.scores[winner] || 0) + pts;
}

function roomPublic(room) {
    const ps = {};
    Object.entries(room.players).forEach(([pid, p]) => {
        ps[pid] = { name: p.name, color: p.color, handCount: p.hand.length };
    });
    return {
        id: room.id, order: room.order, turnIdx: room.turnIdx,
        direction: room.direction, topCard: room.topCard,
        activeColor: room.activeColor, started: room.started,
        winner: room.winner, scores: room.scores, round: room.round,
        deckCount: room.deck.length, drawStack: room.drawStack,
        players: ps
    };
}

// ─── SOCKET ──────────────────────────────────────────────────────────────────
io.on('connection', socket => {
    socket.on('join', ({ name, roomId }) => {
        const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
        users[socket.id] = { name, color, roomId };

        if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
        const room = rooms[roomId];
        room.players[socket.id] = { name, color, hand: [] };
        if (!room.scores[socket.id]) room.scores[socket.id] = 0;
        if (!room.order.includes(socket.id)) room.order.push(socket.id);

        socket.join(roomId);
        io.to(roomId).emit('room_update', roomPublic(room));
        io.to(socket.id).emit('your_hand', room.players[socket.id].hand);
        io.to(roomId).emit('chat', { system: true, msg: `${name} odaya katıldı! 👋`, time: Date.now() });
    });

    socket.on('start_game', () => {
        const u = users[socket.id]; if (!u) return;
        const room = rooms[u.roomId]; if (!room || room.started) return;
        if (room.order.length < 2) { socket.emit('error_msg', 'En az 2 oyuncu gerekli!'); return; }

        dealGame(room);
        room.started = true;

        room.order.forEach(pid => io.to(pid).emit('your_hand', room.players[pid].hand));
        io.to(u.roomId).emit('room_update', roomPublic(room));
        io.to(u.roomId).emit('game_started', { firstPlayer: currentPlayer(room) });
        io.to(u.roomId).emit('chat', { system: true, msg: '🎮 UNO başladı! İlk kart açıldı!', time: Date.now() });
    });

    socket.on('play_card', ({ cardId, chosenColor }) => {
        const u = users[socket.id]; if (!u) return;
        const room = rooms[u.roomId]; if (!room?.started) return;

        const result = playCard(room, socket.id, cardId, chosenColor);
        if (!result.ok) { socket.emit('error_msg', result.msg); return; }

        room.order.forEach(pid => io.to(pid).emit('your_hand', room.players[pid].hand));
        io.to(u.roomId).emit('card_played', {
            pid: socket.id, name: u.name, card: result.card,
            activeColor: room.activeColor, drawStack: room.drawStack
        });
        io.to(u.roomId).emit('room_update', roomPublic(room));

        if (room.players[socket.id].hand.length === 1) {
            io.to(u.roomId).emit('uno_alert', { pid: socket.id, name: u.name });
        }
        if (room.winner) {
            calcScore(room);
            io.to(u.roomId).emit('room_update', roomPublic(room));
            io.to(u.roomId).emit('game_over', { winner: socket.id, winnerName: u.name, scores: room.scores });
        }
    });

    socket.on('draw_card', () => {
        const u = users[socket.id]; if (!u) return;
        const room = rooms[u.roomId]; if (!room?.started) return;

        const result = drawCards(room, socket.id);
        if (!result.ok) { socket.emit('error_msg', result.msg); return; }

        io.to(socket.id).emit('your_hand', room.players[socket.id].hand);
        io.to(socket.id).emit('drew_cards', { drawn: result.drawn, playable: result.playable });
        io.to(u.roomId).emit('room_update', roomPublic(room));
        io.to(u.roomId).emit('player_drew', { pid: socket.id, name: u.name, count: result.count });
    });

    socket.on('call_uno', () => {
        const u = users[socket.id]; if (!u) return;
        const room = rooms[u.roomId]; if (!room) return;
        room.unoCallers.add(socket.id);
        io.to(u.roomId).emit('uno_called', { pid: socket.id, name: u.name });
        io.to(u.roomId).emit('chat', { system: true, msg: `${u.name}: UNO! 🔥`, time: Date.now() });
    });

    socket.on('new_round', () => {
        const u = users[socket.id]; if (!u) return;
        const room = rooms[u.roomId]; if (!room) return;
        room.round++;
        dealGame(room);
        room.started = true;
        room.order.forEach(pid => io.to(pid).emit('your_hand', room.players[pid].hand));
        io.to(u.roomId).emit('room_update', roomPublic(room));
        io.to(u.roomId).emit('new_round_started', { round: room.round });
        io.to(u.roomId).emit('chat', { system: true, msg: `🔄 ${room.round}. tur başladı!`, time: Date.now() });
    });

    socket.on('chat', ({ msg }) => {
        const u = users[socket.id]; if (!u || !msg?.trim()) return;
        io.to(u.roomId).emit('chat', {
            system: false, pid: socket.id, name: u.name,
            color: u.color, msg: msg.trim().slice(0, 200), time: Date.now()
        });
    });

    socket.on('disconnect', () => {
        const u = users[socket.id];
        if (u) {
            const room = rooms[u.roomId];
            if (room) {
                delete room.players[socket.id];
                delete room.scores[socket.id];
                room.order = room.order.filter(p => p !== socket.id);
                if (room.turnIdx >= room.order.length) room.turnIdx = 0;
                if (room.order.length === 0) delete rooms[u.roomId];
                else {
                    io.to(u.roomId).emit('room_update', roomPublic(room));
                    io.to(u.roomId).emit('chat', { system: true, msg: `${u.name} ayrıldı 👋`, time: Date.now() });
                }
            }
            delete users[socket.id];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏 3D UNO Server: http://localhost:${PORT}`));
