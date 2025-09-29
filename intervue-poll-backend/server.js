// server.js (CommonJS)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// In-memory stores (simple)
const polls = {}; // pollId -> poll object
const usernameToSockets = {}; // username -> Set(socketId)
const socketIdToUsername = {}; // socketId -> username

// Utility to make short ids
function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

// HTTP endpoints used by frontend
app.post("/teacher-login", (req, res) => {
  const username = "teacher-" + Math.random().toString(36).substring(2, 8);
  res.json({ username });
});

// returns polls created by a teacher (shapes expected by frontend)
app.get("/polls/:username", (req, res) => {
  const username = req.params.username;
  const result = Object.values(polls)
    .filter(p => p.teacherUsername === username)
    .map(p => ({
      _id: p._id,
      question: p.question,
      timer: p.timer,
      createdAt: p.createdAt,
      options: p.options.map(o => ({ id: o.id, text: o.text, votes: o.votes || 0 }))
    }));
  res.json({ data: result });
});

// Socket.IO handling
io.on("connection", socket => {
  console.log("connected:", socket.id);

  socket.on("joinChat", ({ username }) => {
    if (!username) return;
    socketIdToUsername[socket.id] = username;
    if (!usernameToSockets[username]) usernameToSockets[username] = new Set();
    usernameToSockets[username].add(socket.id);
    io.emit("participantsUpdate", Array.from(Object.keys(usernameToSockets)));
  });

  socket.on("chatMessage", message => {
    // message: { user, text }
    io.emit("chatMessage", message);
  });

  socket.on("createPoll", pollData => {
    // pollData expected: { question, options: [{id,text,correct}], timer, teacherUsername }
    const id = makeId();
    const poll = {
      _id: id,
      question: pollData.question,
      teacherUsername: pollData.teacherUsername || "teacher",
      timer: Number(pollData.timer) || 60,
      createdAt: Date.now(),
      active: true,
      options: (pollData.options || []).map(o => ({ id: o.id, text: o.text, correct: o.correct, votes: 0 })),
      answered: new Set(),
      timeoutId: null
    };
    polls[id] = poll;

    // emit pollCreated to clients (frontend expects poll._id)
    const clientPoll = {
      _id: poll._id,
      question: poll.question,
      options: poll.options.map(o => ({ id: o.id, text: o.text, correct: o.correct })),
      timer: poll.timer,
      teacherUsername: poll.teacherUsername
    };
    io.emit("pollCreated", clientPoll);

    // start server-side timeout to finalize poll (safe fallback)
    poll.timeoutId = setTimeout(() => finalizePoll(id), poll.timer * 1000);
  });

  socket.on("submitAnswer", ({ username, option, pollId }) => {
    const poll = polls[pollId];
    if (!poll || !poll.active) return;
    const opt = poll.options.find(o => o.text === option);
    if (!opt) return;
    opt.votes = (opt.votes || 0) + 1;
    poll.answered.add(username);

    // broadcast live results
    const votesObj = {};
    poll.options.forEach(o => { votesObj[o.text] = o.votes || 0; });
    io.emit("pollResults", votesObj);

    // if everyone answered, finalize early
    const participantCount = Object.keys(usernameToSockets).length;
    if (participantCount > 0 && poll.answered.size >= participantCount) {
      if (poll.timeoutId) clearTimeout(poll.timeoutId);
      finalizePoll(pollId);
    }
  });

  socket.on("kickOut", participant => {
    const set = usernameToSockets[participant];
    if (set) {
      for (const sid of Array.from(set)) {
        io.to(sid).emit("kickedOut");
        // remove mapping
        delete socketIdToUsername[sid];
        set.delete(sid);
        try { io.sockets.sockets.get(sid)?.disconnect(true); } catch (e) { /* safe */ }
      }
      delete usernameToSockets[participant];
      io.emit("participantsUpdate", Array.from(Object.keys(usernameToSockets)));
    }
  });

  socket.on("disconnect", () => {
    const username = socketIdToUsername[socket.id];
    if (username) {
      const s = usernameToSockets[username];
      if (s) {
        s.delete(socket.id);
        if (s.size === 0) delete usernameToSockets[username];
      }
      delete socketIdToUsername[socket.id];
      io.emit("participantsUpdate", Array.from(Object.keys(usernameToSockets)));
    }
  });
});

function finalizePoll(pollId) {
  const poll = polls[pollId];
  if (!poll) return;
  poll.active = false;
  const votesObj = {};
  poll.options.forEach(o => { votesObj[o.text] = o.votes || 0; });
  io.emit("pollResults", votesObj);
  // poll stored in memory so GET /polls/:username will return it
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Backend listening on", PORT));
