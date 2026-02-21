/**
 * ============================================================================
 * MIGUEL2GETHER - Cliente JavaScript
 * ============================================================================
 * Maneja todas las interacciones del cliente:
 * - Conexión Socket.io y gestión de salas
 * - Reproductor de YouTube sincronizado
 * - Videos externos (cualquier URL)
 * - Solo Música (YouTube audio, MP3)
 * - Compartir pantalla con WebRTC (simple-peer)
 * - Ruleta de películas sincronizada mejorada
 * ============================================================================
 */

// ============================================================================
// VARIABLES GLOBALES
// ============================================================================

// Socket.io
let socket = null;

// Estado de la sala
let roomState = {
    roomId: null,
    roomName: null,
    isHost: false,
    username: null,
    users: []
};

// YouTube Player
let ytPlayer = null;
let isPlayerReady = false;
let isSyncing = false; // Flag para evitar loops de sincronización

// Music Player
let musicYtPlayer = null;
let isMusicPlayerReady = false;
let isMusicPlaying = false;

// WebRTC (Screen Share)
let localStream = null;
let peers = {}; // Conexiones peer por cada usuario
let isSharing = false;

// Ruleta
let rouletteOptions = [];
let isSpinning = false;

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    initializeSocket();
    initializeEventListeners();
    loadYouTubeAPI();
    initializeMusicPlayer();
    initializeQueue();
});

/**
 * Inicializa la conexión de Socket.io
 */
function initializeSocket() {
    socket = io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });
    
    // Eventos de conexión
    socket.on('connect', () => {
        console.log('✅ Conectado al servidor:', socket.id);
        showNotification('Conectado al servidor', 'success');
        updateConnectionStatus(true);
    });
    
    socket.on('connect_error', (error) => {
        console.error('❌ Error de conexión:', error.message);
        showNotification('Error al conectar: ' + error.message, 'error');
        updateConnectionStatus(false);
    });
    
    socket.on('disconnect', () => {
        console.log('❌ Desconectado del servidor');
        showNotification('Desconectado del servidor', 'error');
        updateConnectionStatus(false);
    });
    
    socket.on('error', ({ message }) => {
        showNotification(message, 'error');
    });
    
    // Eventos de sala
    setupRoomEvents();
    
    // Eventos de video
    setupVideoEvents();
    
    // Eventos de WebRTC
    setupWebRTCEvents();
    
    // Eventos de ruleta
    setupRouletteEvents();
    
    // Eventos de chat
    setupChatEvents();
    
    // Eventos de música
    setupMusicEvents();
    
    // Eventos de video externo
    setupExternalVideoEvents();
    
    // Eventos de cola
    setupQueueEvents();
}

/**
 * Inicializa los event listeners del DOM
 */
function initializeEventListeners() {
    // === LOBBY ===
    document.getElementById('btn-create-room').addEventListener('click', createRoom);
    document.getElementById('btn-join-room').addEventListener('click', joinRoom);
    
    // Enter para unirse a sala
    document.getElementById('room-code').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinRoom();
    });
    
    // === SALA ===
    document.getElementById('btn-leave-room').addEventListener('click', leaveRoom);
    document.getElementById('btn-copy-code').addEventListener('click', copyRoomLink);
    document.getElementById('btn-cinema-mode').addEventListener('click', toggleCinemaMode);
    
    // === TABS ===
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    
    // === YOUTUBE ===
    document.getElementById('btn-load-video').addEventListener('click', loadVideo);
    document.getElementById('youtube-url').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadVideo();
    });
    document.getElementById('btn-sync-video').addEventListener('click', requestVideoSync);
    
    // === VIDEO EXTERNO ===
    document.getElementById('btn-load-external-video').addEventListener('click', loadExternalVideo);
    document.getElementById('external-video-url').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadExternalVideo();
    });
    
    // === MÚSICA ===
    document.getElementById('btn-load-music').addEventListener('click', loadMusic);
    document.getElementById('music-url').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadMusic();
    });
    document.getElementById('btn-music-sync').addEventListener('click', requestMusicSync);
    
    // === SCREEN SHARE ===
    document.getElementById('btn-share-screen').addEventListener('click', startScreenShare);
    document.getElementById('btn-stop-share').addEventListener('click', stopScreenShare);
    
    // === CHAT ===
    document.getElementById('btn-send-chat').addEventListener('click', sendChatMessage);
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });
}

// ============================================================================
// GESTIÓN DE SALAS
// ============================================================================

/**
 * Crea una nueva sala
 */
function createRoom() {
    const username = document.getElementById('username').value.trim();
    
    if (!username) {
        showNotification('Por favor, ingresa tu nombre', 'warning');
        return;
    }
    
    roomState.username = username;
    
    socket.emit('create-room', {
        roomName: `Sala de ${username}`,
        username
    });
}

/**
 * Se une a una sala existente
 */
function joinRoom() {
    const username = document.getElementById('username').value.trim();
    const roomId = document.getElementById('room-code').value.trim().toUpperCase();
    
    if (!username) {
        showNotification('Por favor, ingresa tu nombre', 'warning');
        return;
    }
    
    if (!roomId) {
        showNotification('Por favor, ingresa el código de sala', 'warning');
        return;
    }
    
    roomState.username = username;
    
    socket.emit('join-room', { roomId, username });
}

/**
 * Sale de la sala actual
 */
function leaveRoom() {
    // Detener screen share si está activo
    if (isSharing) {
        stopScreenShare();
    }
    
    // Cerrar todas las conexiones peer
    Object.values(peers).forEach(peer => peer.destroy());
    peers = {};
    
    // Recargar la página para reiniciar todo
    location.reload();
}

/**
 * Copia el link de la sala al portapapeles
 */
function copyRoomLink() {
    const link = `${window.location.origin}?room=${roomState.roomId}`;
    navigator.clipboard.writeText(link).then(() => {
        showNotification('¡Link copiado!', 'success');
    });
}

/**
 * Estado del modo cine
 */
let isCinemaMode = false;

/**
 * Activa/desactiva el modo cine
 */
function toggleCinemaMode() {
    isCinemaMode = !isCinemaMode;
    const body = document.body;
    const overlay = document.getElementById('cinema-overlay');
    const btn = document.getElementById('btn-cinema-mode');
    const header = document.querySelector('.room-header');
    const trigger = document.getElementById('cinema-header-trigger');
    
    if (isCinemaMode) {
        // Activar modo cine
        body.classList.add('cinema-mode');
        overlay.classList.remove('hidden');
        btn.innerHTML = 'Salir Cine';
        
        // Botón flotante de salir
        document.getElementById('btn-exit-cinema').addEventListener('click', toggleCinemaMode);
        
        // Configurar zona de detección del header
        trigger.addEventListener('mouseenter', showCinemaHeader);
        header.addEventListener('mouseleave', hideCinemaHeader);
        
        showNotification('Modo Cine activado - Pulsa ESC o el botón × para salir', 'success');
        
        // Escuchar tecla Escape para salir
        document.addEventListener('keydown', handleCinemaEscape);
    } else {
        // Desactivar modo cine
        body.classList.remove('cinema-mode');
        overlay.classList.add('hidden');
        header.classList.remove('visible');
        btn.innerHTML = 'Modo Cine';
        
        // Remover listener del botón flotante
        document.getElementById('btn-exit-cinema').removeEventListener('click', toggleCinemaMode);
        
        // Remover listeners
        trigger.removeEventListener('mouseenter', showCinemaHeader);
        header.removeEventListener('mouseleave', hideCinemaHeader);
        document.removeEventListener('keydown', handleCinemaEscape);
        
        showNotification('Modo Cine desactivado', 'success');
    }
}

/**
 * Muestra el header en modo cine
 */
function showCinemaHeader() {
    document.querySelector('.room-header').classList.add('visible');
}

/**
 * Oculta el header en modo cine
 */
function hideCinemaHeader() {
    document.querySelector('.room-header').classList.remove('visible');
}

/**
 * Maneja la tecla Escape en modo cine
 */
function handleCinemaEscape(e) {
    if (e.key === 'Escape' && isCinemaMode) {
        toggleCinemaMode();
    }
}

// ============================================================================
// COLA DE CONTENIDO
// ============================================================================

let contentQueue = [];

/**
 * Inicializa la cola
 */
function initializeQueue() {
    document.getElementById('btn-add-to-queue').addEventListener('click', openQueueModal);
    document.getElementById('btn-cancel-queue').addEventListener('click', closeQueueModal);
    document.getElementById('btn-confirm-queue').addEventListener('click', addToQueue);
    
    // Cerrar modal al hacer clic fuera
    document.getElementById('queue-modal').addEventListener('click', (e) => {
        if (e.target.id === 'queue-modal') closeQueueModal();
    });
    
    // Enter para añadir
    document.getElementById('queue-url').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addToQueue();
    });
}

/**
 * Abre el modal de la cola
 */
function openQueueModal() {
    document.getElementById('queue-modal').classList.add('active');
    document.getElementById('queue-url').focus();
}

/**
 * Cierra el modal de la cola
 */
function closeQueueModal() {
    document.getElementById('queue-modal').classList.remove('active');
    document.getElementById('queue-url').value = '';
    document.getElementById('queue-title').value = '';
}

/**
 * Añade contenido a la cola
 */
function addToQueue() {
    const url = document.getElementById('queue-url').value.trim();
    let title = document.getElementById('queue-title').value.trim();
    
    if (!url) {
        showNotification('Por favor, ingresa una URL', 'warning');
        return;
    }
    
    // Si no hay título, intentar extraer uno
    if (!title) {
        title = extractTitleFromUrl(url);
    }
    
    socket.emit('add-to-queue', { url, title });
    closeQueueModal();
    showNotification('Añadido a la cola', 'success');
}

/**
 * Extrae un título básico de la URL
 */
function extractTitleFromUrl(url) {
    const youtubeId = extractYouTubeId(url);
    if (youtubeId) return `YouTube: ${youtubeId}`;
    
    if (url.includes('vimeo.com')) return 'Video de Vimeo';
    if (url.includes('twitch.tv')) return 'Twitch';
    if (url.includes('dailymotion.com')) return 'Dailymotion';
    
    return url.substring(0, 30) + '...';
}

/**
 * Actualiza la UI de la cola
 */
function updateQueueUI() {
    const list = document.getElementById('queue-list');
    const empty = document.getElementById('queue-empty');
    const count = document.getElementById('queue-count');
    
    count.textContent = contentQueue.length;
    
    if (contentQueue.length === 0) {
        list.classList.add('hidden');
        empty.classList.remove('hidden');
        return;
    }
    
    list.classList.remove('hidden');
    empty.classList.add('hidden');
    
    list.innerHTML = '';
    contentQueue.forEach((item, index) => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="queue-number">${index + 1}</span>
            <div class="queue-info">
                <span class="queue-title">${escapeHtml(item.title)}</span>
                <span class="queue-user">por ${escapeHtml(item.username)}</span>
            </div>
            <div class="queue-actions">
                ${roomState.isHost ? `
                    <button class="queue-btn play" onclick="playFromQueue(${index})" title="Reproducir ahora">►</button>
                    <button class="queue-btn remove" onclick="removeFromQueue(${index})" title="Eliminar">×</button>
                ` : ''}
            </div>
        `;
        list.appendChild(li);
    });
}

/**
 * Reproduce un elemento de la cola (solo host)
 */
function playFromQueue(index) {
    if (!roomState.isHost) return;
    socket.emit('play-from-queue', { index });
}

/**
 * Elimina un elemento de la cola (solo host)
 */
function removeFromQueue(index) {
    if (!roomState.isHost) return;
    socket.emit('remove-from-queue', { index });
}

/**
 * Configura eventos de la cola
 */
function setupQueueEvents() {
    socket.on('queue-updated', ({ queue }) => {
        contentQueue = queue;
        updateQueueUI();
    });
    
    socket.on('queue-play', ({ url, title }) => {
        // Determinar el tipo de contenido y reproducir
        const youtubeId = extractYouTubeId(url);
        if (youtubeId) {
            loadVideoById(youtubeId);
            switchTab('youtube');
        } else {
            displayExternalVideo(getEmbedUrl(url) || url);
            switchTab('video');
        }
        showNotification(`Reproduciendo: ${title}`, 'success');
    });
}

/**
 * Configura eventos de sala
 */
function setupRoomEvents() {
    // Sala creada
    socket.on('room-created', ({ roomId, roomName, isHost, users }) => {
        roomState.roomId = roomId;
        roomState.roomName = roomName;
        roomState.isHost = isHost;
        roomState.users = users;
        
        switchScreen('room');
        updateRoomUI();
        initializeRoulette();
        
        showNotification(`Sala "${roomName}" creada`, 'success');
    });
    
    // Unido a sala
    socket.on('room-joined', ({ roomId, roomName, isHost, users, videoState, rouletteOptions: options, queue }) => {
        roomState.roomId = roomId;
        roomState.roomName = roomName;
        roomState.isHost = isHost;
        roomState.users = users;
        
        switchScreen('room');
        updateRoomUI();
        initializeRoulette();
        
        // Sincronizar estado del video si existe
        if (videoState && videoState.videoId) {
            loadVideoById(videoState.videoId);
            // Esperar a que el player esté listo para sincronizar
            setTimeout(() => {
                if (ytPlayer && isPlayerReady) {
                    ytPlayer.seekTo(videoState.currentTime, true);
                    if (videoState.isPlaying) {
                        ytPlayer.playVideo();
                    }
                }
            }, 2000);
        }
        
        // Sincronizar opciones de ruleta
        if (options && options.length > 0) {
            rouletteOptions = options;
            updateRouletteUI();
        }
        
        // Sincronizar cola
        if (queue && queue.length > 0) {
            contentQueue = queue;
            updateQueueUI();
        }
        
        showNotification(`Te uniste a "${roomName}"`, 'success');
    });
    
    // Usuario se unió
    socket.on('user-joined', ({ id, username, isHost }) => {
        roomState.users.push({ id, username, isHost });
        updateUsersList();
        addChatSystemMessage(`${username} se unió a la sala`);
        
        // Si estamos compartiendo pantalla, crear conexión peer con el nuevo usuario
        if (isSharing && localStream) {
            createPeerConnection(id, true);
        }
    });
    
    // Usuario se fue
    socket.on('user-left', ({ id, username }) => {
        roomState.users = roomState.users.filter(u => u.id !== id);
        updateUsersList();
        addChatSystemMessage(`${username} salió de la sala`);
        
        // Limpiar conexión peer si existe
        if (peers[id]) {
            peers[id].destroy();
            delete peers[id];
        }
    });
    
    // Nuevo host
    socket.on('new-host', ({ id, username }) => {
        roomState.users.forEach(u => {
            u.isHost = u.id === id;
        });
        if (socket.id === id) {
            roomState.isHost = true;
            showNotification('Ahora eres el host de la sala', 'success');
        }
        updateUsersList();
    });
}

/**
 * Cambia entre pantallas (lobby/room)
 */
function switchScreen(screen) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`${screen}-screen`).classList.add('active');
}

/**
 * Actualiza la UI de la sala
 */
function updateRoomUI() {
    document.getElementById('room-name').textContent = roomState.roomName;
    document.getElementById('room-code-display').textContent = roomState.roomId;
    updateUsersList();
}

/**
 * Actualiza la lista de usuarios
 */
function updateUsersList() {
    const list = document.getElementById('users-list');
    const count = document.getElementById('user-count');
    
    list.innerHTML = '';
    count.textContent = roomState.users.length;
    
    roomState.users.forEach(user => {
        const li = document.createElement('li');
        li.textContent = user.username;
        if (user.isHost) li.classList.add('host');
        if (user.id === socket.id) li.textContent += ' (Tú)';
        list.appendChild(li);
    });
}

// ============================================================================
// YOUTUBE PLAYER
// ============================================================================

/**
 * Carga la API de YouTube IFrame
 */
function loadYouTubeAPI() {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScript = document.getElementsByTagName('script')[0];
    firstScript.parentNode.insertBefore(tag, firstScript);
}

/**
 * Callback cuando la API de YouTube está lista
 */
window.onYouTubeIframeAPIReady = function() {
    ytPlayer = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        playerVars: {
            'playsinline': 1,
            'controls': 1,
            'rel': 0,
            'modestbranding': 1
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
    
    // Crear también el reproductor de música
    createMusicYouTubePlayer();
};

/**
 * Callback cuando el player está listo
 */
function onPlayerReady(event) {
    isPlayerReady = true;
    console.log('YouTube Player listo');
}

/**
 * Callback cuando el estado del player cambia
 */
function onPlayerStateChange(event) {
    // Evitar sincronización si estamos en proceso de sync
    if (isSyncing) return;
    
    const currentTime = ytPlayer.getCurrentTime();
    
    switch (event.data) {
        case YT.PlayerState.PLAYING:
            socket.emit('video-sync', { action: 'play', currentTime });
            updateVideoStatus('Reproduciendo');
            break;
            
        case YT.PlayerState.PAUSED:
            socket.emit('video-sync', { action: 'pause', currentTime });
            updateVideoStatus('⏸️ Pausado');
            break;
            
        case YT.PlayerState.BUFFERING:
            updateVideoStatus('⏳ Cargando...');
            break;
    }
}

/**
 * Carga un video de YouTube
 */
function loadVideo() {
    const url = document.getElementById('youtube-url').value.trim();
    const videoId = extractYouTubeId(url);
    
    if (!videoId) {
        showNotification('URL de YouTube inválida', 'error');
        return;
    }
    
    socket.emit('load-video', { videoId });
}

/**
 * Carga un video por ID
 */
function loadVideoById(videoId) {
    if (ytPlayer && isPlayerReady) {
        ytPlayer.loadVideoById(videoId);
        document.getElementById('youtube-url').value = `https://youtube.com/watch?v=${videoId}`;
    }
}

/**
 * Extrae el ID de un video de YouTube de una URL
 */
function extractYouTubeId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
        /^([a-zA-Z0-9_-]{11})$/ // Solo el ID
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    
    return null;
}

/**
 * Solicita sincronización de video
 */
function requestVideoSync() {
    socket.emit('request-video-state');
    showNotification('Sincronizando video...', 'success');
}

/**
 * Actualiza el estado del video en la UI
 */
function updateVideoStatus(text) {
    document.getElementById('video-status').textContent = text;
}

/**
 * Configura eventos de video
 */
function setupVideoEvents() {
    // Video cargado
    socket.on('video-loaded', ({ videoId }) => {
        loadVideoById(videoId);
        showNotification('Nuevo video cargado', 'success');
    });
    
    // Sincronización de video
    socket.on('video-sync', ({ action, currentTime, timestamp }) => {
        if (!ytPlayer || !isPlayerReady) return;
        
        isSyncing = true;
        
        // Calcular el desfase de tiempo de red
        const networkDelay = (Date.now() - timestamp) / 1000;
        const adjustedTime = currentTime + networkDelay;
        
        // Sincronizar posición si hay diferencia significativa (> 2 segundos)
        const playerTime = ytPlayer.getCurrentTime();
        if (Math.abs(playerTime - adjustedTime) > 2) {
            ytPlayer.seekTo(adjustedTime, true);
        }
        
        // Aplicar acción
        if (action === 'play') {
            ytPlayer.playVideo();
        } else if (action === 'pause') {
            ytPlayer.pauseVideo();
        } else if (action === 'seek') {
            ytPlayer.seekTo(adjustedTime, true);
        }
        
        // Reset flag después de un pequeño delay
        setTimeout(() => {
            isSyncing = false;
        }, 500);
    });
    
    // Estado del video (para nuevos usuarios)
    socket.on('video-state', ({ videoId, currentTime, isPlaying }) => {
        if (videoId) {
            loadVideoById(videoId);
            setTimeout(() => {
                if (ytPlayer && isPlayerReady) {
                    ytPlayer.seekTo(currentTime, true);
                    if (isPlaying) {
                        ytPlayer.playVideo();
                    }
                }
            }, 1000);
        }
    });
}

// ============================================================================
// SCREEN SHARE (WebRTC con simple-peer)
// ============================================================================

/**
 * Inicia el compartir pantalla
 */
async function startScreenShare() {
    try {
        // Obtener stream de pantalla
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: 'always',
                displaySurface: 'monitor'
            },
            audio: true // Audio del sistema si está disponible
        });
        
        isSharing = true;
        
        // Mostrar nuestro propio stream
        const videoElement = document.getElementById('screen-video');
        videoElement.srcObject = localStream;
        document.getElementById('screen-placeholder').classList.add('hidden');
        
        // Actualizar UI
        document.getElementById('btn-share-screen').classList.add('hidden');
        document.getElementById('btn-stop-share').classList.remove('hidden');
        
        // Notificar al servidor
        socket.emit('start-screen-share');
        
        // Crear conexiones peer con todos los usuarios en la sala
        roomState.users.forEach(user => {
            if (user.id !== socket.id) {
                createPeerConnection(user.id, true);
            }
        });
        
        // Escuchar cuando el usuario detiene desde el navegador
        localStream.getVideoTracks()[0].onended = () => {
            stopScreenShare();
        };
        
        showNotification('Compartiendo pantalla', 'success');
        
    } catch (err) {
        console.error('Error al compartir pantalla:', err);
        showNotification('No se pudo compartir la pantalla', 'error');
    }
}

/**
 * Detiene el compartir pantalla
 */
function stopScreenShare() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    isSharing = false;
    
    // Cerrar todas las conexiones peer
    Object.values(peers).forEach(peer => peer.destroy());
    peers = {};
    
    // Actualizar UI
    document.getElementById('screen-video').srcObject = null;
    document.getElementById('screen-placeholder').classList.remove('hidden');
    document.getElementById('btn-share-screen').classList.remove('hidden');
    document.getElementById('btn-stop-share').classList.add('hidden');
    
    // Notificar al servidor
    socket.emit('stop-screen-share');
    
    showNotification('Dejaste de compartir pantalla', 'success');
}

/**
 * Crea una conexión peer WebRTC
 * @param {string} peerId - ID del peer (socket ID)
 * @param {boolean} initiator - Si somos el que inicia la conexión
 */
function createPeerConnection(peerId, initiator) {
    // Si ya existe una conexión, destruirla
    if (peers[peerId]) {
        peers[peerId].destroy();
    }
    
    const peer = new SimplePeer({
        initiator,
        stream: initiator ? localStream : undefined,
        trickle: true,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        }
    });
    
    peers[peerId] = peer;
    
    // Cuando hay señal para enviar
    peer.on('signal', signal => {
        if (initiator) {
            socket.emit('webrtc-offer', { targetId: peerId, signal });
        } else {
            socket.emit('webrtc-answer', { targetId: peerId, signal });
        }
    });
    
    // Cuando recibimos el stream
    peer.on('stream', stream => {
        console.log('Stream recibido de:', peerId);
        const videoElement = document.getElementById('screen-video');
        videoElement.srcObject = stream;
        document.getElementById('screen-placeholder').classList.add('hidden');
    });
    
    // Conexión establecida
    peer.on('connect', () => {
        console.log('✅ Conexión P2P establecida con:', peerId);
    });
    
    // Error
    peer.on('error', err => {
        console.error('❌ Error en conexión peer:', err);
    });
    
    // Conexión cerrada
    peer.on('close', () => {
        console.log('Conexión cerrada con:', peerId);
        delete peers[peerId];
    });
    
    return peer;
}

/**
 * Configura eventos de WebRTC
 */
function setupWebRTCEvents() {
    // Alguien comenzó a compartir pantalla
    socket.on('screen-share-started', ({ sharerId }) => {
        if (sharerId !== socket.id) {
            showNotification('Un usuario está compartiendo su pantalla', 'success');
            // El sharer creará la conexión, nosotros esperamos
        }
    });
    
    // Alguien dejó de compartir
    socket.on('screen-share-stopped', ({ sharerId }) => {
        if (sharerId !== socket.id) {
            const videoElement = document.getElementById('screen-video');
            videoElement.srcObject = null;
            document.getElementById('screen-placeholder').classList.remove('hidden');
            
            // Limpiar conexión peer
            if (peers[sharerId]) {
                peers[sharerId].destroy();
                delete peers[sharerId];
            }
        }
    });
    
    // Recibir oferta WebRTC
    socket.on('webrtc-offer', ({ callerId, signal }) => {
        console.log('Oferta WebRTC recibida de:', callerId);
        
        // Crear peer como receptor
        const peer = createPeerConnection(callerId, false);
        peer.signal(signal);
    });
    
    // Recibir respuesta WebRTC
    socket.on('webrtc-answer', ({ answererId, signal }) => {
        console.log('Respuesta WebRTC recibida de:', answererId);
        
        if (peers[answererId]) {
            peers[answererId].signal(signal);
        }
    });
    
    // Recibir candidato ICE
    socket.on('ice-candidate', ({ senderId, candidate }) => {
        if (peers[senderId]) {
            peers[senderId].signal({ candidate });
        }
    });
}

// ============================================================================
// TABS
// ============================================================================

/**
 * Cambia entre tabs (YouTube, Screen, Roulette)
 */
function switchTab(tabName) {
    // Actualizar botones
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    
    // Actualizar contenido
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-container`).classList.add('active');
}

// ============================================================================
// RULETA DE PELÍCULAS
// ============================================================================

/**
 * Inicializa el componente de la ruleta
 */
function initializeRoulette() {
    const container = document.getElementById('roulette-container');
    const template = document.getElementById('roulette-template');
    container.innerHTML = '';
    container.appendChild(template.content.cloneNode(true));
    
    // Event listeners de la ruleta
    document.getElementById('btn-add-option').addEventListener('click', addRouletteOption);
    document.getElementById('roulette-option-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addRouletteOption();
    });
    document.getElementById('btn-spin-roulette').addEventListener('click', spinRoulette);
    
    // Botón de limpiar opciones
    const clearBtn = document.getElementById('btn-clear-options');
    if (clearBtn) {
        clearBtn.addEventListener('click', clearRouletteOptions);
    }
}

/**
 * Añade una opción a la ruleta
 */
function addRouletteOption() {
    const input = document.getElementById('roulette-option-input');
    const option = input.value.trim();
    
    if (!option) {
        showNotification('Escribe el nombre de una película', 'warning');
        return;
    }
    
    if (rouletteOptions.includes(option)) {
        showNotification('Esta opción ya existe', 'warning');
        return;
    }
    
    if (rouletteOptions.length >= 20) {
        showNotification('Máximo 20 opciones', 'warning');
        return;
    }
    
    socket.emit('add-roulette-option', { option });
    input.value = '';
}

/**
 * Elimina una opción de la ruleta
 */
function removeRouletteOption(option) {
    socket.emit('remove-roulette-option', { option });
}

/**
 * Limpia todas las opciones de la ruleta
 */
function clearRouletteOptions() {
    if (rouletteOptions.length === 0) return;
    
    socket.emit('clear-roulette-options');
    showNotification('Opciones eliminadas', 'success');
}

/**
 * Actualiza la UI de la ruleta
 */
function updateRouletteUI() {
    // Actualizar lista
    const list = document.getElementById('roulette-options');
    const count = document.getElementById('options-count');
    
    list.innerHTML = '';
    count.textContent = rouletteOptions.length;
    
    rouletteOptions.forEach(option => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span>${option}</span>
            <span class="remove-option" onclick="removeRouletteOption('${option.replace(/'/g, "\\'")}')">✕</span>
        `;
        list.appendChild(li);
    });
    
    // Actualizar rueda visual
    updateRouletteWheel();
    
    // Habilitar/deshabilitar botón de girar
    const spinBtn = document.getElementById('btn-spin-roulette');
    spinBtn.disabled = rouletteOptions.length < 2 || isSpinning;
}

/**
 * Actualiza la rueda visual
 */
function updateRouletteWheel() {
    const wheel = document.getElementById('roulette-wheel');
    
    // Mantener el centro de la rueda
    wheel.innerHTML = '<div class="wheel-center">►</div>';
    
    if (rouletteOptions.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-muted);text-align:center;z-index:1;';
        emptyMsg.innerHTML = '<p>Añade opciones<br>para empezar</p>';
        wheel.appendChild(emptyMsg);
        return;
    }
    
    const segmentAngle = 360 / rouletteOptions.length;
    
    rouletteOptions.forEach((option, index) => {
        const segment = document.createElement('div');
        segment.className = 'roulette-segment';
        segment.style.transform = `rotate(${index * segmentAngle - 90}deg) skewY(${90 - segmentAngle}deg)`;
        segment.innerHTML = `<span>${option}</span>`;
        wheel.appendChild(segment);
    });
}

/**
 * Gira la ruleta
 */
function spinRoulette() {
    if (isSpinning || rouletteOptions.length < 2) return;
    
    // Seleccionar resultado aleatorio
    const resultIndex = Math.floor(Math.random() * rouletteOptions.length);
    const result = rouletteOptions[resultIndex];
    
    // Calcular rotación (múltiples vueltas + posición del resultado)
    const segmentAngle = 360 / rouletteOptions.length;
    const extraRotations = 5 * 360; // 5 vueltas completas
    const targetAngle = 360 - (resultIndex * segmentAngle) - (segmentAngle / 2);
    const rotationDegrees = extraRotations + targetAngle;
    
    // Enviar al servidor para sincronizar
    socket.emit('spin-roulette', { result, rotationDegrees });
}

/**
 * Ejecuta la animación de la ruleta
 */
function animateRoulette(rotationDegrees, result) {
    const wheel = document.getElementById('roulette-wheel');
    const resultDiv = document.getElementById('roulette-result');
    const resultText = document.getElementById('result-text');
    const spinBtn = document.getElementById('btn-spin-roulette');
    
    isSpinning = true;
    spinBtn.disabled = true;
    resultDiv.classList.add('hidden');
    
    // Reset y aplicar rotación
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    
    // Forzar reflow
    wheel.offsetHeight;
    
    // Animar
    wheel.style.transition = 'transform 4s cubic-bezier(0.17, 0.67, 0.12, 0.99)';
    wheel.style.transform = `rotate(${rotationDegrees}deg)`;
    
    // Mostrar resultado después de la animación
    setTimeout(() => {
        resultText.textContent = result;
        resultDiv.classList.remove('hidden');
        isSpinning = false;
        spinBtn.disabled = rouletteOptions.length < 2;
        
        showNotification(`La ruleta eligió: ${result}`, 'success');
    }, 4100);
}

/**
 * Configura eventos de la ruleta
 */
function setupRouletteEvents() {
    // Opciones actualizadas
    socket.on('roulette-options-updated', ({ options }) => {
        rouletteOptions = options;
        updateRouletteUI();
    });
    
    // Ruleta girada
    socket.on('roulette-spin', ({ result, rotationDegrees, spinnerName }) => {
        animateRoulette(rotationDegrees, result);
        
        if (spinnerName !== roomState.username) {
            showNotification(`${spinnerName} giró la ruleta`, 'success');
        }
    });
}

// ============================================================================
// CHAT
// ============================================================================

/**
 * Envía un mensaje de chat
 */
function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    
    if (!message) return;
    
    socket.emit('chat-message', { message });
    input.value = '';
}

/**
 * Añade un mensaje al chat
 */
function addChatMessage(senderName, message, isSelf = false) {
    const container = document.getElementById('chat-messages');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const initial = senderName.charAt(0).toUpperCase();
    
    const div = document.createElement('div');
    div.className = `chat-message ${isSelf ? 'self' : ''}`;
    div.innerHTML = `
        <div class="chat-avatar">${initial}</div>
        <div class="chat-bubble">
            <div class="chat-meta">
                <span class="chat-sender">${isSelf ? 'Tú' : escapeHtml(senderName)}</span>
                <span class="chat-time">${time}</span>
            </div>
            <p class="chat-text">${escapeHtml(message)}</p>
        </div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

/**
 * Añade un mensaje de sistema al chat
 */
function addChatSystemMessage(message) {
    const container = document.getElementById('chat-messages');
    
    const div = document.createElement('div');
    div.className = 'chat-message system';
    div.innerHTML = `
        <div class="chat-bubble">
            <p class="chat-text">${escapeHtml(message)}</p>
        </div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

/**
 * Configura eventos de chat
 */
function setupChatEvents() {
    socket.on('chat-message', ({ senderId, senderName, message }) => {
        addChatMessage(senderName, message, senderId === socket.id);
    });
}

// ============================================================================
// VIDEO EXTERNO (Cualquier URL)
// ============================================================================

/**
 * Carga un video externo (Vimeo, Dailymotion, Twitch, etc.)
 */
function loadExternalVideo() {
    const url = document.getElementById('external-video-url').value.trim();
    
    if (!url) {
        showNotification('Por favor, ingresa una URL', 'warning');
        return;
    }
    
    const embedUrl = getEmbedUrl(url);
    
    if (!embedUrl) {
        showNotification('URL no soportada. Prueba con Vimeo, Dailymotion o Twitch', 'error');
        return;
    }
    
    socket.emit('load-external-video', { url: embedUrl, originalUrl: url });
}

/**
 * Convierte URL de video a URL de embed
 */
function getEmbedUrl(url) {
    // Vimeo
    const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vimeoMatch) {
        return `https://player.vimeo.com/video/${vimeoMatch[1]}?autoplay=1`;
    }
    
    // Dailymotion
    const dailymotionMatch = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
    if (dailymotionMatch) {
        return `https://www.dailymotion.com/embed/video/${dailymotionMatch[1]}?autoplay=1`;
    }
    
    // Twitch (clips)
    const twitchClipMatch = url.match(/twitch\.tv\/\w+\/clip\/([a-zA-Z0-9-_]+)/);
    if (twitchClipMatch) {
        return `https://clips.twitch.tv/embed?clip=${twitchClipMatch[1]}&parent=${window.location.hostname}`;
    }
    
    // Twitch (canales en vivo)
    const twitchChannelMatch = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)$/);
    if (twitchChannelMatch) {
        return `https://player.twitch.tv/?channel=${twitchChannelMatch[1]}&parent=${window.location.hostname}`;
    }
    
    // Facebook Video
    const facebookMatch = url.match(/facebook\.com\/.*\/videos\/(\d+)/);
    if (facebookMatch) {
        return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`;
    }
    
    // Si es una URL directa de video (mp4, webm)
    if (url.match(/\.(mp4|webm|ogg)(\?.*)?$/i)) {
        return url;
    }
    
    // Si ya parece ser una URL de embed
    if (url.includes('embed') || url.includes('player')) {
        return url;
    }
    
    return null;
}

/**
 * Muestra un video externo
 */
function displayExternalVideo(embedUrl) {
    const iframe = document.getElementById('external-video-player');
    const placeholder = document.getElementById('external-video-placeholder');
    
    iframe.src = embedUrl;
    placeholder.classList.add('hidden');
}

/**
 * Configura eventos de video externo
 */
function setupExternalVideoEvents() {
    socket.on('external-video-loaded', ({ url }) => {
        displayExternalVideo(url);
        showNotification('Video externo cargado', 'success');
    });
}

// ============================================================================
// MÚSICA (Solo Audio)
// ============================================================================

/**
 * Inicializa el reproductor de música
 */
function initializeMusicPlayer() {
    // El reproductor de música de YouTube se crea cuando se carga la API
}

/**
 * Crea el reproductor de música de YouTube
 */
function createMusicYouTubePlayer() {
    if (musicYtPlayer) return;
    
    musicYtPlayer = new YT.Player('music-youtube-player', {
        height: '1',
        width: '1',
        playerVars: {
            'playsinline': 1,
            'controls': 0,
            'rel': 0
        },
        events: {
            'onReady': () => {
                isMusicPlayerReady = true;
                console.log('Music Player listo');
            },
            'onStateChange': onMusicStateChange
        }
    });
}

/**
 * Callback cuando el estado del reproductor de música cambia
 */
function onMusicStateChange(event) {
    if (isSyncing) return;
    
    const currentTime = musicYtPlayer.getCurrentTime();
    
    switch (event.data) {
        case YT.PlayerState.PLAYING:
            isMusicPlaying = true;
            socket.emit('music-sync', { action: 'play', currentTime });
            updateMusicStatus('Reproduciendo');
            animateVisualizer(true);
            break;
            
        case YT.PlayerState.PAUSED:
            isMusicPlaying = false;
            socket.emit('music-sync', { action: 'pause', currentTime });
            updateMusicStatus('⏸️ Pausado');
            animateVisualizer(false);
            break;
    }
}

/**
 * Carga música
 */
function loadMusic() {
    const url = document.getElementById('music-url').value.trim();
    
    if (!url) {
        showNotification('Por favor, ingresa una URL', 'warning');
        return;
    }
    
    // Verificar si es YouTube
    const youtubeId = extractYouTubeId(url);
    if (youtubeId) {
        socket.emit('load-music', { type: 'youtube', videoId: youtubeId, url });
        return;
    }
    
    // Verificar si es MP3 directo
    if (url.match(/\.(mp3|wav|ogg|m4a)(\?.*)?$/i)) {
        socket.emit('load-music', { type: 'audio', url });
        return;
    }
    
    showNotification('Formato no soportado. Usa YouTube o archivos de audio', 'error');
}

/**
 * Reproduce música de YouTube
 */
function playMusicFromYouTube(videoId) {
    if (!isMusicPlayerReady) {
        createMusicYouTubePlayer();
        setTimeout(() => playMusicFromYouTube(videoId), 1000);
        return;
    }
    
    musicYtPlayer.loadVideoById(videoId);
    document.getElementById('music-info').classList.remove('hidden');
    document.getElementById('music-title').textContent = 'Cargando...';
    document.getElementById('music-audio-player').classList.add('hidden');
    
    // Obtener título del video
    setTimeout(() => {
        if (musicYtPlayer.getVideoData) {
            const data = musicYtPlayer.getVideoData();
            if (data.title) {
                document.getElementById('music-title').textContent = data.title;
            }
        }
    }, 2000);
}

/**
 * Reproduce audio directo (MP3)
 */
function playAudioFile(url) {
    const audioPlayer = document.getElementById('music-audio-player');
    audioPlayer.src = url;
    audioPlayer.classList.remove('hidden');
    audioPlayer.play();
    
    document.getElementById('music-info').classList.remove('hidden');
    document.getElementById('music-title').textContent = url.split('/').pop();
}

/**
 * Solicita sincronización de música
 */
function requestMusicSync() {
    socket.emit('request-music-state');
    showNotification('Sincronizando música...', 'success');
}

/**
 * Actualiza el estado de la música
 */
function updateMusicStatus(text) {
    document.getElementById('music-status').textContent = text;
}

/**
 * Anima el visualizador
 */
function animateVisualizer(playing) {
    const bars = document.querySelectorAll('.visualizer-bars span');
    bars.forEach(bar => {
        bar.style.animationPlayState = playing ? 'running' : 'paused';
    });
}

/**
 * Configura eventos de música
 */
function setupMusicEvents() {
    socket.on('music-loaded', ({ type, videoId, url }) => {
        if (type === 'youtube') {
            playMusicFromYouTube(videoId);
        } else {
            playAudioFile(url);
        }
        showNotification('Música cargada', 'success');
    });
    
    socket.on('music-sync', ({ action, currentTime, timestamp }) => {
        if (!musicYtPlayer || !isMusicPlayerReady) return;
        
        isSyncing = true;
        
        const networkDelay = (Date.now() - timestamp) / 1000;
        const adjustedTime = currentTime + networkDelay;
        
        const playerTime = musicYtPlayer.getCurrentTime();
        if (Math.abs(playerTime - adjustedTime) > 2) {
            musicYtPlayer.seekTo(adjustedTime, true);
        }
        
        if (action === 'play') {
            musicYtPlayer.playVideo();
            animateVisualizer(true);
        } else if (action === 'pause') {
            musicYtPlayer.pauseVideo();
            animateVisualizer(false);
        }
        
        setTimeout(() => {
            isSyncing = false;
        }, 500);
    });
}

// ============================================================================
// UTILIDADES
// ============================================================================

/**
 * Actualiza el indicador de estado de conexión
 */
function updateConnectionStatus(connected) {
    let indicator = document.getElementById('connection-status');
    
    // Crear indicador si no existe
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'connection-status';
        indicator.style.cssText = `
            position: fixed;
            bottom: 10px;
            left: 10px;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            z-index: 9999;
            transition: all 0.3s ease;
        `;
        document.body.appendChild(indicator);
    }
    
    if (connected) {
        indicator.textContent = '● Conectado';
        indicator.style.background = 'rgba(34, 197, 94, 0.9)';
        indicator.style.color = 'white';
        // Ocultar después de 3 segundos
        setTimeout(() => {
            indicator.style.opacity = '0.5';
        }, 3000);
    } else {
        indicator.textContent = '● Desconectado';
        indicator.style.background = 'rgba(239, 68, 68, 0.9)';
        indicator.style.color = 'white';
        indicator.style.opacity = '1';
    }
}

/**
 * Muestra una notificación toast
 */
function showNotification(message, type = 'info') {
    const container = document.getElementById('notifications');
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    // Auto-remove después de 4 segundos
    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

/**
 * Escapa caracteres HTML para prevenir XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================================================
// MANEJO DE URL (para links compartidos)
// ============================================================================

(function checkUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get('room');
    
    if (roomId) {
        document.getElementById('room-code').value = roomId;
    }
})();
