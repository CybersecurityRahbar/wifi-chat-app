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

// إنشاء وتوصيل قاعدة البيانات
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) {
        console.error('خطأ في فتح قاعدة البيانات:', err.message);
    } else {
        console.log('✅ تم الاتصال بقاعدة البيانات SQLite');
        // إنشاء جدول الرسائل إذا لم يكن موجوداً
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roomId TEXT NOT NULL,
            sender TEXT NOT NULL,
            message TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// تخزين المستخدمين والغرف (في الذاكرة)
const rooms = new Map();
const users = new Map();

// خدمة الملفات الثابتة
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
        database: 'SQLite'
    });
});

// دالة لتحميل الرسائل القديمة من قاعدة البيانات
function loadRoomMessages(roomId, callback) {
    db.all(
        "SELECT sender, message, timestamp FROM messages WHERE roomId = ? ORDER BY timestamp ASC",
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

// دالة لحفظ رسالة جديدة في قاعدة البيانات
function saveMessage(roomId, sender, message) {
    db.run(
        "INSERT INTO messages (roomId, sender, message) VALUES (?, ?, ?)",
        [roomId, sender, message],
        function(err) {
            if (err) {
                console.error('خطأ في حفظ الرسالة:', err);
            } else {
                console.log(`✅ تم حفظ رسالة في غرفة ${roomId} من ${sender}`);
            }
        }
    );
}

// Socket.IO events
io.on('connection', (socket) => {
    console.log('مستخدم جديد متصل:', socket.id);

    // انضمام المستخدم إلى غرفة
    socket.on('join-room', (data) => {
        const { roomId, userName } = data;
        
        // مغادرة الغرف السابقة إن وجدت
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
        }
        rooms.get(roomId).add(socket.id);

        // تحميل الرسائل القديمة وإرسالها للمستخدم الجديد
        loadRoomMessages(roomId, (oldMessages) => {
            oldMessages.forEach(msg => {
                socket.emit('receive-message', {
                    text: msg.message,
                    sender: msg.sender,
                    timestamp: msg.timestamp,
                    isOld: true // للإشارة أن هذه رسالة قديمة
                });
            });
        });

        // إعلام الآخرين بانضمام مستخدم جديد
        socket.to(roomId).emit('user-joined', {
            userName,
            users: getUsersInRoom(roomId),
            message: `${userName} انضم إلى الغرفة`
        });

        // إرسال قائمة المستخدمين للمستخدم الجديد
        socket.emit('room-info', {
            roomId: roomId,
            users: getUsersInRoom(roomId),
            message: `مرحباً ${userName}! لقد انضممت إلى غرفة ${roomId}`
        });

        console.log(`المستخدم ${userName} انضم للغرفة ${roomId}`);
    });

    // استقبال الرسائل
    socket.on('send-message', (data) => {
        const user = users.get(socket.id);
        if (user && user.roomId) {
            const messageData = {
                text: data.text,
                sender: user.userName,
                timestamp: new Date().toLocaleTimeString('ar-EG'),
                roomId: user.roomId
            };
            
            // حفظ الرسالة في قاعدة البيانات
            saveMessage(user.roomId, user.userName, data.text);
            
            // إرسال الرسالة للجميع في الغرفة
            io.to(user.roomId).emit('receive-message', messageData);
            
            console.log(`رسالة من ${user.userName} في غرفة ${user.roomId}: ${data.text}`);
        }
    });

    // فصل المستخدم
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            const { userName, roomId } = user;
            
            // إزالة المستخدم من الغرفة
            if (rooms.has(roomId)) {
                rooms.get(roomId).delete(socket.id);
                
                // إعلام الآخرين بمغادرة المستخدم
                socket.to(roomId).emit('user-left', {
                    userName,
                    users: getUsersInRoom(roomId),
                    message: `${userName} غادر الغرفة`
                });

                // حذف الغرفة إذا كانت فارغة
                if (rooms.get(roomId).size === 0) {
                    rooms.delete(roomId);
                    console.log(`تم حذف الغرفة ${roomId} لأنها أصبحت فارغة`);
                }
            }

            users.delete(socket.id);
            console.log(`المستخدم ${userName} غادر التطبيق`);
        }
    });
});

// دالة للحصول على المستخدمين في الغرفة
function getUsersInRoom(roomId) {
    if (!rooms.has(roomId)) return [];
    
    const usersInRoom = [];
    rooms.get(roomId).forEach(socketId => {
        const user = users.get(socketId);
        if (user) {
            usersInRoom.push({
                userName: user.userName,
                socketId: socketId
            });
        }
    });
    return usersInRoom;
}

// بدء الخادم
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 تطبيق الدردشة يعمل بنجاح!');
    console.log(`📍 المحلي: http://localhost:${PORT}`);
    console.log(`💾 قاعدة البيانات: SQLite (chat.db)`);
    console.log(`✅ Health Check: http://localhost:${PORT}/health`);
});