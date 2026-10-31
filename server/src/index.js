import './config/env.js';

import { createServer } from 'node:http';
import { Server } from 'socket.io';

import { app, setSeatChangeEmitter } from './app.js';
import { expiryWorker, redis, setSocketServer } from './queue.js';
import { prisma } from './db.js';


const server = createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
        credentials: true
    }
});


io.on('connection', (socket) => {

    socket.on('movie:join', (id) => {
        if (typeof id === 'string' && id.length < 100) {
            socket.join(`movie:${id}`);
        }
    });

    socket.on('movie:leave', (id) => {
        socket.leave(`movie:${id}`);
    });

});


// Events are published after service transactions commit;
// inventory remains authoritative.
setSeatChangeEmitter((event) => {
    io.to(`movie:${event.movieId}`).emit('seats:changed', event);
});

setSocketServer(io);


const port = Number(process.env.PORT ?? 4000);

server.listen(port, () => {
    console.log(`CineLock API listening on ${port}`);
});


async function shutdown() {
    await expiryWorker.close();
    await redis.quit();
    await prisma.$disconnect();

    server.close();
}


process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
