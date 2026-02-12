const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// ==================== 数据库初始化 ====================
const DB_FILE = path.join(__dirname, "users.db");
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error("❌ 数据库连接失败:", err);
  } else {
    console.log("✅ 数据库连接成功:", DB_FILE);
    initDatabase();
  }
});

// 初始化数据库表
function initDatabase() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT DEFAULT '👤',
      created_at INTEGER NOT NULL,
      last_login INTEGER
    );
    
    CREATE INDEX IF NOT EXISTS idx_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_id ON users(id);
  `;
  
  db.exec(schema, (err) => {
    if (err) {
      console.error("❌ 数据库初始化失败:", err);
    } else {
      console.log("✅ 数据库表初始化成功");
      
      // 插入测试用户
      db.run(`INSERT OR IGNORE INTO users (id, phone, username, password, avatar, created_at) 
              VALUES (?, ?, ?, ?, ?, ?)`,
        ['testuser', '13800138000', '测试用户', '123456', '😊', Date.now()],
        (err) => {
          if (err) {
            console.log("测试用户已存在");
          } else {
            console.log("✅ 已创建测试用户: testuser / 13800138000 / 密码:123456");
          }
        }
      );
    }
  });
}

// ==================== 用户认证函数 ====================

// 注册新用户
function registerUser(data, callback) {
  const { id, phone, username, password } = data;
  
  // 验证手机号格式（11位数字）
  if (!/^1\d{10}$/.test(phone)) {
    return callback({ success: false, message: "手机号格式错误，需要11位数字" });
  }
  
  // 验证ID格式（不能为空，长度3-20）
  if (!id || id.length < 3 || id.length > 20) {
    return callback({ success: false, message: "ID长度应为3-20个字符" });
  }
  
  // 验证密码（至少6位）
  if (!password || password.length < 6) {
    return callback({ success: false, message: "密码至少需要6位" });
  }
  
  // 检查ID是否已存在
  db.get("SELECT id FROM users WHERE id = ?", [id], (err, row) => {
    if (err) {
      return callback({ success: false, message: "数据库查询错误" });
    }
    
    if (row) {
      return callback({ success: false, message: "该ID已被使用" });
    }
    
    // 检查手机号是否已存在
    db.get("SELECT phone FROM users WHERE phone = ?", [phone], (err, row) => {
      if (err) {
        return callback({ success: false, message: "数据库查询错误" });
      }
      
      if (row) {
        return callback({ success: false, message: "该手机号已被注册" });
      }
      
      // 创建新用户
      const finalUsername = username || id; // 默认用户名为ID
      const avatar = '👤';
      const createdAt = Date.now();
      
      db.run(
        `INSERT INTO users (id, phone, username, password, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, phone, finalUsername, password, avatar, createdAt],
        function(err) {
          if (err) {
            return callback({ success: false, message: "注册失败：" + err.message });
          }
          
          console.log(`\n✅ 新用户注册成功: ${id} / ${phone} / ${finalUsername}`);
          callback({
            success: true,
            message: "注册成功！",
            user: {
              id: id,
              phone: phone,
              username: finalUsername,
              avatar: avatar
            }
          });
        }
      );
    });
  });
}

// 用户登录
function loginUser(data, callback) {
  const { loginId, password } = data;
  
  // 判断loginId是手机号还是ID
  const isPhone = /^1\d{10}$/.test(loginId);
  const query = isPhone 
    ? "SELECT * FROM users WHERE phone = ?" 
    : "SELECT * FROM users WHERE id = ?";
  
  db.get(query, [loginId], (err, user) => {
    if (err) {
      return callback({ success: false, message: "数据库查询错误" });
    }
    
    if (!user) {
      return callback({ success: false, message: "用户不存在" });
    }
    
    if (user.password !== password) {
      return callback({ success: false, message: "密码错误" });
    }
    
    // 更新最后登录时间
    db.run("UPDATE users SET last_login = ? WHERE id = ?", [Date.now(), user.id]);
    
    console.log(`\n✅ 用户登录成功: ${user.username} (ID: ${user.id})`);
    callback({
      success: true,
      message: "登录成功！",
      user: {
        id: user.id,
        phone: user.phone,
        username: user.username,
        avatar: user.avatar
      }
    });
  });
}

// ==================== 简单的内存存储 ====================
const bubbles = new Map(); // 所有气泡
const onlineUsers = new Map(); // 在线用户
const socketUser = new Map(); // WebSocket -> User
const userSocket = new Map(); // UserID -> WebSocket

// 统计
let stats = {
  totalPublished: 0,
  totalQueried: 0,
  totalMessages: 0,
  lastCleared: null,
  clearedBy: null
};

// 管理员密码（可以修改）
const ADMIN_PASSWORD = "admin123"; // ⭐ 添加管理员密码

// 备份文件路径
const BACKUP_FILE = path.join(__dirname, "bubbles_backup.json");

// ==================== 启动时加载备份 ====================
function loadBackup() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      data.forEach(bubble => {
        if (bubble.expiresAt > Date.now()) {
          bubbles.set(bubble.id, bubble);
        }
      });
      console.log(`✅ 从备份恢复了 ${bubbles.size} 个气泡`);
    }
  } catch (error) {
    console.error("备份加载失败:", error);
  }
}

// ==================== 定期保存备份 ====================
function saveBackup() {
  try {
    const data = Array.from(bubbles.values());
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 已备份 ${data.length} 个气泡`);
  } catch (error) {
    console.error("备份保存失败:", error);
  }
}

// ==================== 工具函数 ====================
function genUserId() {
  return Math.random().toString(36).slice(2, 10);
}

function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  onlineUsers.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

// ⭐⭐⭐ 新功能：清除所有气泡
function clearAllBubbles(initiator = "管理员") {
  try {
    const bubbleCount = bubbles.size;
    const userCount = onlineUsers.size;
    
    // 记录统计信息
    stats.lastCleared = new Date().toISOString();
    stats.clearedBy = initiator;
    
    // 清空气泡
    bubbles.clear();
    
    // 广播清除通知给所有在线用户
    broadcast({
      type: "bubblesCleared",
      message: `所有气泡已被 ${initiator} 清除`,
      clearedCount: bubbleCount,
      timestamp: Date.now()
    });
    
    // 保存空备份
    saveBackup();
    
    console.log("\n" + "=".repeat(60));
    console.log("🗑️  气泡清除操作");
    console.log("=".repeat(60));
    console.log(`   执行者: ${initiator}`);
    console.log(`   清除数量: ${bubbleCount} 个气泡`);
    console.log(`   在线用户: ${userCount} 人`);
    console.log(`   时间: ${new Date().toLocaleString('zh-CN')}`);
    console.log("=".repeat(60));
    
    return {
      success: true,
      clearedCount: bubbleCount,
      message: `已成功清除 ${bubbleCount} 个气泡`,
      timestamp: stats.lastCleared
    };
    
  } catch (error) {
    console.error("清除气泡失败:", error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== WebSocket 服务器 ====================
const wss = new WebSocket.Server({ port: 3000, host: "0.0.0.0" });

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log("\n" + "=".repeat(60));
  console.log(`🔌 新连接: ${ip}`);
  console.log("=".repeat(60));

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    // Ping-Pong
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // ⭐⭐⭐ 用户注册
    if (data.type === "register") {
      registerUser(data, (result) => {
        ws.send(JSON.stringify({
          type: "registerResponse",
          ...result
        }));
      });
      return;
    }

    // ⭐⭐⭐ 用户登录（新的认证登录）
    if (data.type === "authLogin") {
      loginUser(data, (result) => {
        if (result.success) {
          const user = {
            id: result.user.id,
            nickname: result.user.username,
            phone: result.user.phone,
            avatar: result.user.avatar,
            lat: null,
            lng: null,
          };

          // 如果用户已登录，关闭旧连接
          if (userSocket.has(user.id)) {
            try {
              userSocket.get(user.id).close();
            } catch {}
          }

          socketUser.set(ws, user);
          userSocket.set(user.id, ws);
          onlineUsers.set(user.id, { user, ws });

          console.log(`\n👤 登录: ${user.nickname} (ID: ${user.id})`);
          console.log(`📊 在线: ${onlineUsers.size} 人`);

          ws.send(JSON.stringify({ 
            type: "loginSuccess", 
            user: user,
            message: result.message
          }));
          
          // ⭐ 广播新用户上线
          broadcast({
            type: "userJoined",
            userId: user.id,
            nickname: user.nickname,
            avatar: user.avatar
          });
          broadcast({ type: "onlineCount", count: onlineUsers.size });
        } else {
          ws.send(JSON.stringify({
            type: "loginFailed",
            message: result.message
          }));
        }
      });
      return;
    }

    // ⭐⭐⭐ 新功能：清除气泡命令
    if (data.type === "adminCommand") {
      const user = socketUser.get(ws);
      
      // 验证密码
      if (data.password !== ADMIN_PASSWORD) {
        console.log(`❌ 管理员密码错误: ${data.command} (来自: ${user ? user.nickname : ip})`);
        ws.send(JSON.stringify({
          type: "adminResponse",
          success: false,
          message: "管理员密码错误"
        }));
        return;
      }
      
      console.log(`🔐 管理员命令: ${data.command} (来自: ${user ? user.nickname : ip})`);
      
      // 处理不同的管理命令
      switch(data.command) {
        case "clearBubbles":
          const result = clearAllBubbles(user ? user.nickname : "管理员");
          ws.send(JSON.stringify({
            type: "adminResponse",
            success: result.success,
            message: result.message || result.error,
            clearedCount: result.clearedCount,
            timestamp: result.timestamp
          }));
          break;
          
        case "getStats":
          ws.send(JSON.stringify({
            type: "adminResponse",
            success: true,
            stats: {
              bubbleCount: bubbles.size,
              onlineUsers: onlineUsers.size,
              totalPublished: stats.totalPublished,
              totalQueried: stats.totalQueried,
              totalMessages: stats.totalMessages,
              lastCleared: stats.lastCleared,
              clearedBy: stats.clearedBy
            }
          }));
          break;
          
        case "saveBackup":
          saveBackup();
          ws.send(JSON.stringify({
            type: "adminResponse",
            success: true,
            message: `已保存备份，共 ${bubbles.size} 个气泡`
          }));
          break;
          
        default:
          ws.send(JSON.stringify({
            type: "adminResponse",
            success: false,
            message: "未知的管理员命令"
          }));
      }
      return;
    }

    // ⭐⭐⭐ 客户端清除气泡请求（兼容旧版本）
    if (data.type === "clearBubbles") {
      const user = socketUser.get(ws);
      if (!user) {
        ws.send(JSON.stringify({
          type: "clearBubblesResponse",
          success: false,
          message: "用户未登录"
        }));
        return;
      }
      
      console.log(`🗑️  客户端清除气泡请求: ${user.nickname}`);
      
      // 可以在这里添加权限验证
      if (data.clearAll) {
        const result = clearAllBubbles(user.nickname);
        
        ws.send(JSON.stringify({
          type: "clearBubblesResponse",
          success: result.success,
          message: result.message || result.error,
          clearedCount: result.clearedCount
        }));
      }
      return;
    }

    // 旧版登录（兼容性保留，但建议使用authLogin）
    if (data.type === "login") {
      const user = {
        id: data.userId || genUserId(),
        nickname: data.nickname || "用户" + Math.floor(Math.random() * 10000),
        phone: data.phone,
        avatar: data.avatar || "👤",
        lat: null,
        lng: null,
      };

      // 如果用户已登录，关闭旧连接
      if (userSocket.has(user.id)) {
        try {
          userSocket.get(user.id).close();
        } catch {}
      }

      socketUser.set(ws, user);
      userSocket.set(user.id, ws);
      onlineUsers.set(user.id, { user, ws });

      console.log(`\n👤 登录: ${user.nickname} (ID: ${user.id})`);
      console.log(`📊 在线: ${onlineUsers.size} 人`);

      ws.send(JSON.stringify({ type: "loginSuccess", user: user }));
      
      // ⭐ 广播新用户上线
      broadcast({
        type: "userJoined",
        userId: user.id,
        nickname: user.nickname,
        avatar: user.avatar
      });
      broadcast({ type: "onlineCount", count: onlineUsers.size });
    }

    // 位置更新
    if (data.type === "position") {
      const user = socketUser.get(ws);
      if (user) {
        user.lat = data.lat;
        user.lng = data.lng;
        console.log(`📍 ${user.nickname}: ${user.lat.toFixed(4)}, ${user.lng.toFixed(4)}`);
        
        // ⭐ 广播位置给其他用户
        broadcast({
          type: "userPosition",
          userId: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
          lat: user.lat,
          lng: user.lng
        });
      }
    }

    // 公屏聊天
    if (data.type === "publicChat") {
      const user = socketUser.get(ws);
      if (!user) return;

      const msgObj = {
        type: "publicChat",
        from: user.nickname,
        fromId: user.id,
        avatar: user.avatar,
        msg: data.msg,
        time: Date.now(),
      };

      stats.totalMessages++;
      console.log(`💬 [公屏] ${user.nickname}: ${data.msg}`);
      broadcast(msgObj);
    }

    // 聊天室消息
    if (data.type === "chatroomMsg") {
      const user = socketUser.get(ws);
      if (!user) return;

      const msgObj = {
        type: "chatroomMsg",
        from: user.nickname,
        fromId: user.id,
        avatar: user.avatar,
        msg: data.msg,
        roomCode: data.roomCode,
        time: Date.now(),
      };

      stats.totalMessages++;
      console.log(`💬 [房间 ${data.roomCode}] ${user.nickname}: ${data.msg}`);
      
      // 广播给所有在同一房间的用户
      onlineUsers.forEach(({ user: u, ws: w }) => {
        if (w.readyState === WebSocket.OPEN) {
          w.send(JSON.stringify(msgObj));
        }
      });
    }

    // 私聊
    if (data.type === "privateChat") {
      const user = socketUser.get(ws);
      if (!user) return;

      const targetWs = userSocket.get(data.to);
      const msgObj = {
        type: "privateChat",
        from: user.nickname,
        fromId: user.id,
        to: data.to,
        avatar: user.avatar,
        msg: data.msg,
        time: Date.now(),
      };

      stats.totalMessages++;
      console.log(`🔒 [私聊] ${user.nickname} → ${data.to}: ${data.msg}`);

      // 发给目标
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(msgObj));
      }

      // 回显给自己
      ws.send(JSON.stringify(msgObj));
    }

    // 发布气泡
    if (data.type === "publishBubble") {
      const user = socketUser.get(ws);
      if (!user) return;

      const bubble = {
        id: Math.random().toString(36).slice(2),
        author: user.nickname,
        authorId: user.id,
        avatar: user.avatar,
        type: data.bubbleType || "recommend",
        roomCode: data.roomCode || null,
        title: data.title,
        content: data.content || "",
        lat: data.lat,
        lng: data.lng,
        activityTags: data.activityTags || [],
        createdAt: Date.now(),
        expiresAt: Date.now() + (data.duration || 3600) * 1000,
      };

      bubbles.set(bubble.id, bubble);
      stats.totalPublished++;

      console.log(`🎈 发布气泡: [${bubble.type}] ${bubble.title} by ${user.nickname}${bubble.roomCode ? ' (房间: ' + bubble.roomCode + ')' : ''}`);

      // 广播给所有人
      broadcast({
        type: "newBubble",
        bubble: bubble,
      });

      ws.send(JSON.stringify({
        type: "publishSuccess",
        bubbleId: bubble.id,
      }));
    }

    // 查询气泡
    if (data.type === "queryBubbles") {
      const user = socketUser.get(ws);
      if (!user) return;

      const now = Date.now();
      const results = [];

      bubbles.forEach((bubble) => {
        if (bubble.expiresAt < now) return;

        const dist = calculateDistance(
          data.lat,
          data.lng,
          bubble.lat,
          bubble.lng
        );

        if (dist <= (data.radius || 5000)) {
          results.push({
            ...bubble,
            distance: Math.round(dist),
          });
        }
      });

      results.sort((a, b) => a.distance - b.distance);

      stats.totalQueried++;
      console.log(`🔍 查询气泡: ${user.nickname} 找到 ${results.length} 个`);

      ws.send(JSON.stringify({
        type: "queryResult",
        bubbles: results,
      }));
    }
  });

  ws.on("close", () => {
    const user = socketUser.get(ws);
    if (user) {
      console.log(`\n👋 断开: ${user.nickname}`);
      onlineUsers.delete(user.id);
      socketUser.delete(ws);
      userSocket.delete(user.id);

      broadcast({ type: "onlineCount", count: onlineUsers.size });
      
      // ⭐ 广播用户离线
      broadcast({
        type: "userLeft",
        userId: user.id,
        nickname: user.nickname
      });
    }
  });
});

console.log("✅ WebSocket服务器: ws://0.0.0.0:3000");

// ==================== HTTP 监控服务器 ====================
const httpServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/clearBubbles") {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        
        // 验证管理员密码
        if (data.password !== ADMIN_PASSWORD) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: false,
            message: "管理员密码错误"
          }));
          return;
        }
        
        // 执行清除操作
        const result = clearAllBubbles(data.initiator || "HTTP管理员");
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: false,
          message: "请求处理失败: " + error.message
        }));
      }
    });
    return;
  }

  if (req.url === "/" || req.url === "/monitor") {
    const now = Date.now();
    const activeBubbles = Array.from(bubbles.values())
      .filter((b) => b.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);

    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MomentMap 实时监控</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
      font-family: "Segoe UI", Arial, sans-serif;
      color: white;
      padding: 20px;
      min-height: 100vh;
    }
    h1 {
      text-align: center;
      font-size: 32px;
      margin-bottom: 30px;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }
    .stat-box {
      background: rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(10px);
      padding: 20px;
      border-radius: 10px;
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .stat-box h3 {
      font-size: 14px;
      margin-bottom: 10px;
      opacity: 0.9;
    }
    .stat-box .value {
      font-size: 28px;
      font-weight: bold;
      color: #00ff00;
    }
    .section {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      padding: 20px;
      border-radius: 10px;
      margin-bottom: 20px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .section h2 {
      margin-bottom: 15px;
      font-size: 20px;
      color: #00ffff;
    }
    .user-item, .bubble-item {
      padding: 10px;
      margin: 5px 0;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 5px;
      border-left: 3px solid #00ff00;
    }
    .bubble-item {
      background: #0a0a0a;
      padding: 15px;
      margin: 10px 0;
      border-left: 4px solid #ff00ff;
    }
    .bubble-item .title {
      font-size: 18px;
      color: #00ffff;
      font-weight: bold;
      margin-bottom: 5px;
    }
    .bubble-item .info {
      font-size: 12px;
      color: #888;
    }
    .location { color: #00ff00; }
    .time { color: #ffff00; }
    .refresh {
      text-align: center;
      color: #888;
      margin-top: 20px;
      font-size: 12px;
    }
    .admin-panel {
      background: linear-gradient(135deg, #ff416c, #ff4b2b);
      padding: 20px;
      border-radius: 10px;
      margin-bottom: 20px;
    }
    .admin-panel h2 {
      color: white;
      margin-bottom: 15px;
    }
    .admin-button {
      background: #ff0000;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 5px;
      cursor: pointer;
      font-weight: bold;
      margin-right: 10px;
    }
    .admin-button:hover {
      background: #cc0000;
    }
    .admin-input {
      padding: 8px;
      border-radius: 5px;
      border: 2px solid #00ff00;
      background: #0a0a0a;
      color: white;
      margin-right: 10px;
    }
  </style>
</head>
<body>
  <h1>🗺️ MomentMap 实时监控</h1>
  
  <div class="admin-panel">
    <h2>🔐 管理员控制台</h2>
    <input type="password" id="adminPassword" class="admin-input" placeholder="管理员密码" />
    <button class="admin-button" onclick="clearBubbles()">🗑️ 清除所有气泡</button>
    <button class="admin-button" onclick="saveBackup()">💾 立即备份</button>
    <button class="admin-button" onclick="refreshStats()">🔄 刷新统计</button>
    <div id="adminMessage" style="margin-top: 10px; color: yellow;"></div>
  </div>
  
  <div class="stats">
    <div class="stat-box">
      <h3>🎈 内存气泡</h3>
      <div class="value">${bubbles.size}</div>
    </div>
    <div class="stat-box">
      <h3>✅ 活跃气泡</h3>
      <div class="value">${activeBubbles.length}</div>
    </div>
    <div class="stat-box">
      <h3>👥 在线用户</h3>
      <div class="value">${onlineUsers.size}</div>
    </div>
    <div class="stat-box">
      <h3>📤 已发布</h3>
      <div class="value">${stats.totalPublished}</div>
    </div>
    <div class="stat-box">
      <h3>🔍 已查询</h3>
      <div class="value">${stats.totalQueried}</div>
    </div>
    <div class="stat-box">
      <h3>💬 消息数</h3>
      <div class="value">${stats.totalMessages}</div>
    </div>
    <div class="stat-box">
      <h3>🗑️ 最后清除</h3>
      <div class="value" style="font-size: 16px;">
        ${stats.lastCleared ? new Date(stats.lastCleared).toLocaleTimeString('zh-CN') : '从未'}
      </div>
    </div>
  </div>

  <div class="section">
    <h2>👥 在线用户 (${onlineUsers.size})</h2>
    ${onlineUsers.size === 0 ? '<div style="color: #888;">暂无在线用户</div>' : ''}
    ${Array.from(onlineUsers.values()).map(({ user }) => `
      <div class="user-item">
        ${user.avatar} ${user.nickname} 
        ${user.lat ? `<span class="location">(${user.lat.toFixed(4)}, ${user.lng.toFixed(4)})</span>` : '<span style="color: #ff0000;">(无位置)</span>'}
      </div>
    `).join('')}
  </div>

  <div class="section">
    <h2>🎈 所有气泡 (${activeBubbles.length}/${bubbles.size})</h2>
    ${activeBubbles.length === 0 ? '<div style="color: #888;">暂无气泡</div>' : ''}
    ${activeBubbles.map(b => `
      <div class="bubble-item">
        <div class="title">${b.title}</div>
        <div class="info">
          作者: ${b.author} | 
          类型: ${b.type} | 
          位置: <span class="location">${b.lat.toFixed(4)}, ${b.lng.toFixed(4)}</span><br>
          创建: <span class="time">${new Date(b.createdAt).toLocaleString('zh-CN')}</span> | 
          过期: <span class="time">${new Date(b.expiresAt).toLocaleString('zh-CN')}</span>
        </div>
      </div>
    `).join('')}
  </div>

  <div class="refresh">
    页面每3秒自动刷新 | ${new Date().toLocaleString('zh-CN')}
  </div>

  <script>
    function showMessage(message, isError = false) {
      const elem = document.getElementById('adminMessage');
      elem.textContent = message;
      elem.style.color = isError ? '#ff0000' : '#00ff00';
      setTimeout(() => elem.textContent = '', 3000);
    }
    
    function clearBubbles() {
      const password = document.getElementById('adminPassword').value;
      if (!password) {
        showMessage('请输入管理员密码', true);
        return;
      }
      
      fetch('/api/clearBubbles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          password: password,
          initiator: '监控大屏管理员'
        })
      })
      .then(response => response.json())
      .then(data => {
        if (data.success) {
          showMessage('✅ ' + data.message);
          setTimeout(() => location.reload(), 1000);
        } else {
          showMessage('❌ ' + (data.message || data.error), true);
        }
      })
      .catch(error => {
        showMessage('❌ 请求失败: ' + error.message, true);
      });
    }
    
    function saveBackup() {
      showMessage('💾 备份功能已在服务器端定时执行');
    }
    
    function refreshStats() {
      showMessage('🔄 统计已刷新，页面3秒后自动更新');
    }
  </script>
</body>
</html>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

httpServer.listen(3001, "0.0.0.0", () => {
  console.log("✅ 监控大屏: http://0.0.0.0:3001");
  console.log("=".repeat(60));
  loadBackup();
});

// 定期清理过期气泡
setInterval(() => {
  const now = Date.now();
  let deleted = 0;
  bubbles.forEach((bubble, id) => {
    if (bubble.expiresAt < now) {
      bubbles.delete(id);
      deleted++;
    }
  });
  if (deleted > 0) {
    console.log(`\n🗑️  清理 ${deleted} 个过期气泡`);
    saveBackup();
  }
}, 60 * 60 * 1000);

// 定期保存备份
setInterval(() => {
  saveBackup();
}, 10 * 60 * 1000);

// 定期统计
setInterval(() => {
  console.log("\n" + "=".repeat(60));
  console.log("📊 系统状态");
  console.log(`   气泡: ${bubbles.size} 个`);
  console.log(`   在线: ${onlineUsers.size} 人`);
  console.log(`   已发布: ${stats.totalPublished} 次`);
  console.log(`   已查询: ${stats.totalQueried} 次`);
  console.log(`   最后清除: ${stats.lastCleared ? new Date(stats.lastCleared).toLocaleString('zh-CN') : '从未'}`);
  console.log("=".repeat(60));
}, 5 * 60 * 1000);

// 优雅关闭
process.on("SIGINT", () => {
  console.log("\n正在保存备份并关闭数据库...");
  saveBackup();
  db.close((err) => {
    if (err) {
      console.error("关闭数据库失败:", err);
    } else {
      console.log("数据库已关闭");
    }
    console.log("服务器已关闭");
    process.exit(0);
  });
});
