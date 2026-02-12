-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                    -- 用户ID（唯一，用于登录）
    phone TEXT UNIQUE NOT NULL,              -- 手机号（11位，唯一）
    username TEXT NOT NULL,                  -- 用户名（显示名称）
    password TEXT NOT NULL,                  -- 密码（实际应用中应该加密）
    avatar TEXT DEFAULT '👤',               -- 头像emoji
    created_at INTEGER NOT NULL,             -- 注册时间戳
    last_login INTEGER,                      -- 最后登录时间
    UNIQUE(phone)
);

-- 创建索引以提高查询效率
CREATE INDEX IF NOT EXISTS idx_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_id ON users(id);

-- 插入一个测试用户（密码：123456）
INSERT OR IGNORE INTO users (id, phone, username, password, avatar, created_at) 
VALUES ('testuser', '13800138000', '测试用户', '123456', '😊', strftime('%s', 'now') * 1000);
