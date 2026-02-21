/**
 * ============================================================================
 * STREAM PARTY - Servidor Principal
 * ============================================================================
 * Backend con Express + Socket.io para:
 * - Gestión de salas (crear/unirse)
 * - Sincronización de YouTube (play/pause/seek)
 * - Señalización WebRTC para compartir pantalla
 * - Sincronización de la ruleta de películas
 * ============================================================================
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// ============================================================================
// CONFIGURACIÓN DEL SERVIDOR
// ============================================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// ALMACENAMIENTO EN MEMORIA (En producción usarías Redis o una BD)
// ============================================================================

// Estructura de una sala:
// {
//     id: string,
//     name: string,
//     host: socketId,
//     users: Map<socketId, { username, isHost }>,
//     videoState: { videoId, currentTime, isPlaying, lastUpdate },
//     rouletteOptions: string[],
//     screenSharer: socketId | null,
//     queue: [{ url, title, username, addedAt }]
// }
const rooms = new Map();

// ============================================================================
// RUTAS HTTP
// ============================================================================

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: Crear una nueva sala
app.get('/api/create-room', (req, res) => {
    const roomId = uuidv4().substring(0, 8); // ID corto para compartir
    res.json({ roomId });
});

// API: Verificar si una sala existe
app.get('/api/room/:roomId', (req, res) => {
    const { roomId } = req.params;
    const normalizedId = roomId.trim().toLowerCase();
    const room = rooms.get(normalizedId);
    
    if (room) {
        res.json({ 
            exists: true, 
            name: room.name,
            userCount: room.users.size 
        });
    } else {
        res.json({ exists: false });
    }
});

// API: Estado del servidor (para diagnóstico)
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        rooms: rooms.size,
        roomIds: Array.from(rooms.keys()),
        timestamp: new Date().toISOString()
    });
});

// ============================================================================
// SOCKET.IO - GESTIÓN DE CONEXIONES
// ============================================================================

io.on('connection', (socket) => {
    console.log(`✅ Usuario conectado: ${socket.id}`);
    
    // Variable para rastrear la sala actual del usuario
    let currentRoom = null;
    let currentUsername = null;

    // ------------------------------------------------------------------------
    // GESTIÓN DE SALAS
    // ------------------------------------------------------------------------
    
    /**
     * Crear una nueva sala
     * @param {Object} data - { roomName, username }
     */
    socket.on('create-room', ({ roomName, username }) => {
        const roomId = uuidv4().substring(0, 8).toLowerCase();
        
        console.log(`🏠 Creando sala: ${roomId} por ${username}`);
        
        // Crear la estructura de la sala
        const room = {
            id: roomId,
            name: roomName || `Sala de ${username}`,
            host: socket.id,
            users: new Map(),
            videoState: {
                videoId: null,
                currentTime: 0,
                isPlaying: false,
                lastUpdate: Date.now()
            },
            rouletteOptions: [],
            screenSharer: null,
            queue: []
        };
        
        // Añadir el creador como host
        room.users.set(socket.id, { username, isHost: true });
        rooms.set(roomId, room);
        
        console.log(`✅ Sala ${roomId} creada. Salas activas: ${rooms.size}`);
        
        // Unir al socket a la sala de Socket.io
        socket.join(roomId);
        currentRoom = roomId;
        currentUsername = username;
        
        console.log(`🏠 Sala creada: ${roomId} por ${username}`);
        
        // Enviar confirmación al creador
        socket.emit('room-created', {
            roomId,
            roomName: room.name,
            isHost: true,
            users: [{ id: socket.id, username, isHost: true }]
        });
    });

    /**
     * Unirse a una sala existente
     * @param {Object} data - { roomId, username }
     */
    socket.on('join-room', ({ roomId, username }) => {
        // Normalizar el código (quitar espacios, mayúsculas)
        const normalizedRoomId = roomId.trim().toLowerCase();
        
        console.log(`🔍 Intento de unirse a sala: "${normalizedRoomId}" por ${username}`);
        console.log(`📋 Salas activas: ${Array.from(rooms.keys()).join(', ') || 'ninguna'}`);
        
        const room = rooms.get(normalizedRoomId);
        
        if (!room) {
            console.log(`❌ Sala "${normalizedRoomId}" no encontrada`);
            socket.emit('error', { message: `La sala "${roomId}" no existe. Verifica el código o crea una nueva.` });
            return;
        }
        
        // Añadir usuario a la sala
        room.users.set(socket.id, { username, isHost: false });
        socket.join(normalizedRoomId);
        currentRoom = normalizedRoomId;
        currentUsername = username;
        
        // Preparar lista de usuarios
        const usersList = Array.from(room.users.entries()).map(([id, data]) => ({
            id,
            username: data.username,
            isHost: data.isHost
        }));
        
        console.log(`👤 ${username} se unió a la sala: ${normalizedRoomId}`);
        
        // Notificar al nuevo usuario
        socket.emit('room-joined', {
            roomId: normalizedRoomId,
            roomName: room.name,
            isHost: false,
            users: usersList,
            videoState: room.videoState,
            rouletteOptions: room.rouletteOptions,
            queue: room.queue
        });
        
        // Notificar a los demás usuarios
        socket.to(normalizedRoomId).emit('user-joined', {
            id: socket.id,
            username,
            isHost: false
        });

        // Si alguien está compartiendo pantalla, notificar al nuevo usuario
        if (room.screenSharer) {
            socket.emit('screen-share-started', { oderId: room.screenSharer });
        }
    });

    // ------------------------------------------------------------------------
    // SINCRONIZACIÓN DE YOUTUBE
    // ------------------------------------------------------------------------
    
    /**
     * Cargar un nuevo video de YouTube
     * @param {Object} data - { videoId }
     */
    socket.on('load-video', ({ videoId }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        // Solo el host puede cargar videos (o todos, según prefieras)
        room.videoState = {
            videoId,
            currentTime: 0,
            isPlaying: false,
            lastUpdate: Date.now()
        };
        
        console.log(`🎬 Video cargado en ${currentRoom}: ${videoId}`);
        
        // Sincronizar con todos en la sala
        io.to(currentRoom).emit('video-loaded', { videoId });
    });

    /**
     * Sincronizar estado del video (play/pause/seek)
     * @param {Object} data - { action, currentTime }
     */
    socket.on('video-sync', ({ action, currentTime }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        // Actualizar estado del video
        room.videoState.currentTime = currentTime;
        room.videoState.lastUpdate = Date.now();
        
        if (action === 'play') {
            room.videoState.isPlaying = true;
        } else if (action === 'pause') {
            room.videoState.isPlaying = false;
        }
        
        console.log(`▶️ Video sync en ${currentRoom}: ${action} @ ${currentTime.toFixed(2)}s`);
        
        // Enviar a todos excepto al emisor
        socket.to(currentRoom).emit('video-sync', {
            action,
            currentTime,
            timestamp: Date.now()
        });
    });

    /**
     * Solicitar estado actual del video (para nuevos usuarios)
     */
    socket.on('request-video-state', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.videoState.videoId) return;
        
        socket.emit('video-state', room.videoState);
    });

    // ------------------------------------------------------------------------
    // SEÑALIZACIÓN WEBRTC (Para compartir pantalla)
    // ------------------------------------------------------------------------
    
    /**
     * Notificar que un usuario comenzó a compartir pantalla
     */
    socket.on('start-screen-share', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        room.screenSharer = socket.id;
        
        console.log(`🖥️ ${currentUsername} comenzó a compartir pantalla en ${currentRoom}`);
        
        // Notificar a todos en la sala
        socket.to(currentRoom).emit('screen-share-started', { sharerId: socket.id });
    });

    /**
     * Notificar que un usuario dejó de compartir pantalla
     */
    socket.on('stop-screen-share', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        room.screenSharer = null;
        
        console.log(`🖥️ ${currentUsername} dejó de compartir pantalla`);
        
        // Notificar a todos en la sala
        io.to(currentRoom).emit('screen-share-stopped', { sharerId: socket.id });
    });

    /**
     * Reenviar oferta WebRTC
     * @param {Object} data - { targetId, signal }
     */
    socket.on('webrtc-offer', ({ targetId, signal }) => {
        io.to(targetId).emit('webrtc-offer', {
            callerId: socket.id,
            signal
        });
    });

    /**
     * Reenviar respuesta WebRTC
     * @param {Object} data - { targetId, signal }
     */
    socket.on('webrtc-answer', ({ targetId, signal }) => {
        io.to(targetId).emit('webrtc-answer', {
            answererId: socket.id,
            signal
        });
    });

    /**
     * Reenviar candidato ICE
     * @param {Object} data - { targetId, candidate }
     */
    socket.on('ice-candidate', ({ targetId, candidate }) => {
        io.to(targetId).emit('ice-candidate', {
            senderId: socket.id,
            candidate
        });
    });

    // ------------------------------------------------------------------------
    // RULETA DE PELÍCULAS
    // ------------------------------------------------------------------------
    
    /**
     * Añadir opción a la ruleta
     * @param {Object} data - { option }
     */
    socket.on('add-roulette-option', ({ option }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        // Evitar duplicados y limitar opciones
        if (!room.rouletteOptions.includes(option) && room.rouletteOptions.length < 20) {
            room.rouletteOptions.push(option);
            
            console.log(`🎰 Opción añadida a ruleta en ${currentRoom}: ${option}`);
            
            // Sincronizar con todos
            io.to(currentRoom).emit('roulette-options-updated', {
                options: room.rouletteOptions
            });
        }
    });

    /**
     * Eliminar opción de la ruleta
     * @param {Object} data - { option }
     */
    socket.on('remove-roulette-option', ({ option }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const index = room.rouletteOptions.indexOf(option);
        if (index > -1) {
            room.rouletteOptions.splice(index, 1);
            
            // Sincronizar con todos
            io.to(currentRoom).emit('roulette-options-updated', {
                options: room.rouletteOptions
            });
        }
    });

    /**
     * Girar la ruleta (sincronizado)
     * @param {Object} data - { result, rotationDegrees }
     */
    socket.on('spin-roulette', ({ result, rotationDegrees }) => {
        if (!currentRoom) return;
        
        console.log(`🎰 Ruleta girada en ${currentRoom}: resultado = ${result}`);
        
        // Enviar a TODOS incluyendo al emisor para sincronizar animación
        io.to(currentRoom).emit('roulette-spin', {
            result,
            rotationDegrees,
            spinnerId: socket.id,
            spinnerName: currentUsername
        });
    });

    /**
     * Limpiar todas las opciones de la ruleta
     */
    socket.on('clear-roulette-options', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        room.rouletteOptions = [];
        
        console.log(`🎰 Opciones de ruleta limpiadas en ${currentRoom}`);
        
        io.to(currentRoom).emit('roulette-options-updated', {
            options: room.rouletteOptions
        });
    });

    // ------------------------------------------------------------------------
    // COLA DE CONTENIDO
    // ------------------------------------------------------------------------

    /**
     * Añadir contenido a la cola
     * @param {Object} data - { url, title }
     */
    socket.on('add-to-queue', ({ url, title }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const queueItem = {
            id: Date.now().toString(),
            url,
            title: title || url,
            username: currentUsername,
            addedAt: Date.now()
        };
        
        room.queue.push(queueItem);
        
        console.log(`📋 Añadido a cola en ${currentRoom}: ${title} por ${currentUsername}`);
        
        io.to(currentRoom).emit('queue-updated', {
            queue: room.queue
        });
    });

    /**
     * Reproducir contenido de la cola
     * @param {Object} data - { itemId }
     */
    socket.on('play-from-queue', ({ itemId }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const itemIndex = room.queue.findIndex(item => item.id === itemId);
        if (itemIndex === -1) return;
        
        const item = room.queue[itemIndex];
        
        // Eliminar de la cola
        room.queue.splice(itemIndex, 1);
        
        console.log(`▶️ Reproduciendo desde cola en ${currentRoom}: ${item.title}`);
        
        // Notificar la reproducción
        io.to(currentRoom).emit('queue-play', {
            url: item.url,
            title: item.title
        });
        
        // Actualizar la cola
        io.to(currentRoom).emit('queue-updated', {
            queue: room.queue
        });
    });

    /**
     * Eliminar contenido de la cola
     * @param {Object} data - { itemId }
     */
    socket.on('remove-from-queue', ({ itemId }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        const itemIndex = room.queue.findIndex(item => item.id === itemId);
        if (itemIndex === -1) return;
        
        const removedItem = room.queue.splice(itemIndex, 1)[0];
        
        console.log(`🗑️ Eliminado de cola en ${currentRoom}: ${removedItem.title}`);
        
        io.to(currentRoom).emit('queue-updated', {
            queue: room.queue
        });
    });

    // ------------------------------------------------------------------------
    // VIDEO EXTERNO
    // ------------------------------------------------------------------------

    /**
     * Cargar video externo (Vimeo, Dailymotion, etc.)
     * @param {Object} data - { url, originalUrl }
     */
    socket.on('load-external-video', ({ url, originalUrl }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        room.externalVideoUrl = url;
        
        console.log(`🌐 Video externo cargado en ${currentRoom}: ${originalUrl}`);
        
        io.to(currentRoom).emit('external-video-loaded', { url });
    });

    // ------------------------------------------------------------------------
    // MÚSICA
    // ------------------------------------------------------------------------

    /**
     * Cargar música
     * @param {Object} data - { type, videoId, url }
     */
    socket.on('load-music', ({ type, videoId, url }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        room.musicState = {
            type,
            videoId,
            url,
            currentTime: 0,
            isPlaying: false
        };
        
        console.log(`🎵 Música cargada en ${currentRoom}: ${type === 'youtube' ? videoId : url}`);
        
        io.to(currentRoom).emit('music-loaded', { type, videoId, url });
    });

    /**
     * Sincronizar música
     * @param {Object} data - { action, currentTime }
     */
    socket.on('music-sync', ({ action, currentTime }) => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room) return;
        
        if (room.musicState) {
            room.musicState.currentTime = currentTime;
            room.musicState.isPlaying = action === 'play';
        }
        
        socket.to(currentRoom).emit('music-sync', {
            action,
            currentTime,
            timestamp: Date.now()
        });
    });

    /**
     * Solicitar estado de la música
     */
    socket.on('request-music-state', () => {
        if (!currentRoom) return;
        
        const room = rooms.get(currentRoom);
        if (!room || !room.musicState) return;
        
        socket.emit('music-loaded', {
            type: room.musicState.type,
            videoId: room.musicState.videoId,
            url: room.musicState.url
        });
    });

    // ------------------------------------------------------------------------
    // CHAT SIMPLE (Bonus)
    // ------------------------------------------------------------------------
    
    /**
     * Enviar mensaje de chat
     * @param {Object} data - { message }
     */
    socket.on('chat-message', ({ message }) => {
        if (!currentRoom || !message.trim()) return;
        
        io.to(currentRoom).emit('chat-message', {
            senderId: socket.id,
            senderName: currentUsername,
            message: message.trim(),
            timestamp: Date.now()
        });
    });

    // ------------------------------------------------------------------------
    // DESCONEXIÓN
    // ------------------------------------------------------------------------
    
    socket.on('disconnect', () => {
        console.log(`❌ Usuario desconectado: ${socket.id}`);
        
        if (currentRoom) {
            const room = rooms.get(currentRoom);
            
            if (room) {
                // Si era quien compartía pantalla, limpiar
                if (room.screenSharer === socket.id) {
                    room.screenSharer = null;
                    io.to(currentRoom).emit('screen-share-stopped', { sharerId: socket.id });
                }
                
                // Eliminar usuario de la sala
                room.users.delete(socket.id);
                
                // Notificar a los demás
                socket.to(currentRoom).emit('user-left', {
                    id: socket.id,
                    username: currentUsername
                });
                
                // Si la sala queda vacía, eliminarla
                if (room.users.size === 0) {
                    rooms.delete(currentRoom);
                    console.log(`🗑️ Sala eliminada: ${currentRoom}`);
                }
                // Si el host se fue, asignar nuevo host
                else if (room.host === socket.id) {
                    const newHostId = room.users.keys().next().value;
                    room.host = newHostId;
                    room.users.get(newHostId).isHost = true;
                    
                    io.to(currentRoom).emit('new-host', {
                        id: newHostId,
                        username: room.users.get(newHostId).username
                    });
                }
            }
        }
    });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║   🎬 STREAM PARTY - Servidor iniciado                         ║
║                                                                ║
║   📍 Local:   http://localhost:${PORT}                          ║
║   📍 Red:     http://<tu-ip>:${PORT}                            ║
║                                                                ║
║   ✅ Socket.io listo para conexiones                          ║
║   ✅ Señalización WebRTC activa                                ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
    `);
});

// Manejo de errores no capturados
process.on('uncaughtException', (err) => {
    console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('❌ Promesa rechazada:', err);
});
