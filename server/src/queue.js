import './config/env.js';

import { Queue, Worker } from 'bullmq'; 
import IORedis from 'ioredis'; 
import { expireReservation } from './reservations.js'; 
import { Server } from 'socket.io';

export const redis=new IORedis(process.env.REDIS_URL??'redis://localhost:6379',{maxRetriesPerRequest:null});
export const expiryQueue=new Queue('reservation-expiry',{connection:redis});

let ioRef; 
export function setSocketServer(io){
    ioRef=io;
}

export const expiryWorker=new Worker('reservation-expiry',async job=>{
    await expireReservation(job.data.reservationId,event=>ioRef?.to(`movie:${event.movieId}`).emit('seats:changed',event));},{connection:redis});

    
