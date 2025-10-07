const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// تخزين المستخدمين والغرف
const rooms = new Map();
const users = new Map();
const activeRooms = new Set();

// إنشاء وتوصيل قاعدة البيانات
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) {
        console.error('خطأ في فتح قاعدة البيانات:', err.message);
    } else {
        console.log('✅ تم الاتصال بقاعدة البيانات SQLite');
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roomId TEXT NOT NULL,
            sender TEXT NOT NULL,
            message TEXT NOT NULL,
            message_type TEXT DEFAULT 'text',
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'OK', 
        users: users.size, 
        rooms: rooms.size,
        features: ['text-messages', 'voice-messages', 'public-rooms']
    });
});

// دالة لتحميل الرسائل القديمة
function loadRoomMessages(roomId, callback) {
    db.all(
        "SELECT sender, message, message_type, timestamp FROM messages WHERE roomId = ? ORDER BY timestamp ASC",
        [roomId],
        (err, rows) => {
            if (err) {
                console.error('خطأ في تحميل الرسائل:', err);
                callback([]);
            } else {
                callback(rows);
            }
        }
    );
}

// دالة لحفظ رسالة جديدة
function saveMessage(roomId, sender, message, messageType = 'text') {
    db.run(
        "INSERT INTO messages (roomId, sender, message, message_type) VALUES (?, ?, ?, ?)",
        [roomId, sender, message, messageType],
        function(err) {
            if (err) {
                console.error('خطأ في حفظ الرسالة:', err);
            } else {
                console.log(`✅ تم حفظ ${messageType === 'audio' ? 'رسالة صوتية' : 'رسالة نصية'} في غرفة ${roomId}`);
            }
        }
    );
}

// دالة للحصول على الغرف النشطة
function getActiveRoomsInfo() {
    const roomsInfo = [];
    activeRooms.forEach(roomId => {
        if (rooms.has(roomId) && rooms.get(roomId).size > 0) {
            const usersInRoom = Array.from(rooms.get(roomId)).map(socketId => 
                users.get(socketId)?.userName
            ).filter(Boolean);
            
            roomsInfo.push({
                roomId: roomId,
                usersCount: usersInRoom.length,
                users: usersInRoom
            });
        }
    });
    return roomsInfo;
}

// Socket.IO events
io.on('connection', (socket) => {
    console.log('مستخدم جديد متصل:', socket.id);

    // إرسال قائمة الغرف النشطة للمستخدم الجديد
    socket.emit('active-rooms', getActiveRoomsInfo());

    // انضمام المستخدم إلى غرفة
    socket.on('join-room', (data) => {
        const { roomId, userName } = data;
        
        // مغادرة الغرف السابقة
        if (socket.roomId) {
            socket.leave(socket.roomId);
        }
        
        socket.join(roomId);
        socket.roomId = roomId;
        socket.userName = userName;

        // تخزين بيانات المستخدم
        users.set(socket.id, { userName, roomId });

        // إضافة المستخدم للغرفة
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
            activeRooms.add(roomId);
        }
        rooms.get(roomId).add(socket.id);

        // تحميل الرسائل القديمة
        loadRoomMessages(roomId, (oldMessages) => {
            oldMessages.forEach(msg => {
                if (msg.message_type === 'audio') {
                    socket.emit('receive-message', {
                        type: 'audio',
                        audioUrl: msg.message,
                        duration: 0,
                        sender: msg.sender,
                        timestamp: msg.timestamp,
                        isOld: true
                    });
                } else {
                    socket.emit('receive-message', {
                        type: 'text',
                        text: msg.message,
                        sender: msg.sender,
                        timestamp: msg.timestamp,
                        isOld: true
                    });
                }
            });
        });

        // إعلام الآخرين بانضمام مستخدم جديد
        socket.to(roomId).emit('user-joined', {
            userName,
            users: Array.from(rooms.get(roomId)).map(socketId => 
                users.get(socketId)?.userName
            ).filter(Boolean)
        });

        // إرسال معلومات الغرفة للمستخدم الجديد
        socket.emit('room-info', {
            roomId: roomId,
            users: Array.from(rooms.get(roomId)).map(socketId => 
                users.get(socketId)?.userName
            ).filter(Boolean)
        });

        // تحديث قائمة الغرف للجميع
        io.emit('active-rooms', getActiveRoomsInfo());

        console.log(`المستخدم ${userName} انضم للغرفة ${roomId}`);
    });

    // استقبال الرسائل
    socket.on('send-message', (data) => {
        const user = users.get(socket.id);
        if (user && user.roomId) {
            const messageData = {
                type: data.type || 'text',
                text: data.text,
                audio: data.audio,
                duration: data.duration,
                sender: user.userName,
                timestamp: new Date().toLocaleTimeString('ar-EG'),
                roomId: user.roomId
            };
            
            // حفظ الرسالة في قاعدة البيانات
            if (data.type === 'audio') {
                saveMessage(user.roomId, user.userName, data.audio, 'audio');
            } else {
                saveMessage(user.roomId, user.userName, data.text, 'text');
            }
            
            // إرسال الرسالة للجميع في الغرفة
            io.to(user.roomId).emit('receive-message', messageData);
            
            console.log(`رسالة ${data.type} من ${user.userName} في غرفة ${user.roomId}`);
        }
    });

    // إنشاء غرفة جديدة
    socket.on('create-room', (data) => {
        const roomId = generateRoomId();
        const userName = data.userName;
        
        socket.emit('room-created', { roomId, userName });
        console.log(`تم إنشاء غرفة جديدة: ${roomId}`);
    });

    // طلب الغرف النشطة
    socket.on('get-active-rooms', () => {
        socket.emit('active-rooms', getActiveRoomsInfo());
    });

    // فصل المستخدم
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            const { userName, roomId } = user;
            
            if (rooms.has(roomId)) {
                rooms.get(roomId).delete(socket.id);
                
                // إعلام الآخرين بمغادرة المستخدم
                socket.to(roomId).emit('user-left', {
                    userName,
                    users: Array.from(rooms.get(roomId)).map(socketId => 
                        users.get(socketId)?.userName
                    ).filter(Boolean)
                });

                // حذف الغرفة إذا كانت فارغة
                if (rooms.get(roomId).size === 0) {
                    activeRooms.delete(roomId);
                }
            }

            users.delete(socket.id);
            
            // تحديث قائمة الغرف
            io.emit('active-rooms', getActiveRoomsInfo());
            
            console.log(`المستخدم ${userName} غادر التطبيق`);
        }
    });
});

function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 تطبيق الدردشة العامة يعمل بنجاح!');
    console.log(`📍 المحلي: http://localhost:${PORT}`);
    console.log(`💾 قاعدة البيانات: SQLite`);
    console.log(`🎤 الميزات: رسائل نصية وصوتية، غرف عامة`);
});