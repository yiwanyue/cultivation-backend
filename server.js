const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const schedule = require('node-schedule');

const app = express();
app.use(bodyParser.json());

// 初始化数据库
const db = new sqlite3.Database('./db.sqlite');
db.serialize(() => {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    openid TEXT PRIMARY KEY,
    cultivation INTEGER DEFAULT 0
  )`);
  // 任务表
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    openid TEXT,
    title TEXT,
    due_time INTEGER,
    remind_minutes INTEGER DEFAULT 15,
    status TEXT DEFAULT 'pending',
    reminded_flag INTEGER DEFAULT 0,
    create_time INTEGER
  )`);
  // 修为日志表
  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    openid TEXT,
    task_id TEXT,
    change INTEGER,
    reason TEXT,
    log_time INTEGER
  )`);
});

// 定时任务：处理逾期未完成的任务（每5分钟执行一次）
schedule.scheduleJob('*/5 * * * *', async () => {
  const now = Date.now();
  db.all(`SELECT * FROM tasks WHERE status='pending' AND due_time < ?`, [now], async (err, tasks) => {
    if (err) return;
    for (const task of tasks) {
      db.run(`UPDATE users SET cultivation = cultivation - 1 WHERE openid=?`, [task.openid]);
      db.run(`UPDATE tasks SET status='failed' WHERE id=?`, [task.id]);
      db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, 
        [task.openid, task.id, -1, '逾期自动失败', now]);
      console.log(`任务逾期自动失败: ${task.title}, openid: ${task.openid}`);
    }
  });
});

// ========== API 路由 ==========

// 1. 用户登录（POST）
app.post('/api/login', (req, res) => {
  console.log('收到登录请求', req.body);
  const { code } = req.body;
  const mockOpenid = code ? `test_${code}` : `test_${Date.now()}`;
  
  db.get(`SELECT * FROM users WHERE openid=?`, [mockOpenid], (err, row) => {
    if (err) {
      console.error('数据库查询错误:', err);
      return res.status(500).json({ error: '数据库错误' });
    }
    if (!row) {
      db.run(`INSERT INTO users (openid, cultivation) VALUES (?,0)`, [mockOpenid]);
    }
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [mockOpenid], (err, userRow) => {
      if (err) {
        return res.status(500).json({ error: '数据库错误' });
      }
      res.json({ openid: mockOpenid, cultivation: userRow ? userRow.cultivation : 0 });
    });
  });
});

// 2. 获取用户的所有任务（POST）
app.post('/api/tasks', (req, res) => {
  const { openid } = req.body;
  if (!openid) return res.status(400).json({ error: 'missing openid' });
  db.all(`SELECT * FROM tasks WHERE openid=? ORDER BY due_time ASC`, [openid], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ tasks: rows || [] });
  });
});

// 3. 添加任务（POST）
app.post('/api/addTask', (req, res) => {
  const { openid, title, dueTime, remindMinutes } = req.body;
  if (!openid || !title || !dueTime) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const id = Date.now() + '_' + Math.random().toString(36);
  db.run(`INSERT INTO tasks (id, openid, title, due_time, remind_minutes, reminded_flag, create_time) VALUES (?,?,?,?,?,0,?)`, 
    [id, openid, title, dueTime, remindMinutes || 15, Date.now()], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, taskId: id });
    });
});

// 4. 完成任务（POST）
app.post('/api/completeTask', (req, res) => {
  const { openid, taskId } = req.body;
  if (!openid || !taskId) return res.status(400).json({ error: 'missing' });
  
  db.get(`SELECT * FROM tasks WHERE id=? AND openid=? AND status='pending'`, [taskId, openid], (err, task) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!task) {
      return res.json({ success: false, message: '任务不存在或已处理' });
    }
    
    db.run(`UPDATE users SET cultivation = cultivation + 1 WHERE openid=?`, [openid]);
    db.run(`UPDATE tasks SET status='completed' WHERE id=?`, [taskId]);
    db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, 
      [openid, taskId, 1, '主动完成', Date.now()]);
    
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, cultivation: row.cultivation });
    });
  });
});

// 5. 任务失败（手动）（POST）
app.post('/api/failTask', (req, res) => {
  const { openid, taskId } = req.body;
  if (!openid || !taskId) return res.status(400).json({ error: 'missing' });
  
  db.get(`SELECT * FROM tasks WHERE id=? AND openid=? AND status='pending'`, [taskId, openid], (err, task) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!task) {
      return res.json({ success: false, message: '任务不存在或已处理' });
    }
    
    db.run(`UPDATE users SET cultivation = cultivation - 1 WHERE openid=?`, [openid]);
    db.run(`UPDATE tasks SET status='failed' WHERE id=?`, [taskId]);
    db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, 
      [openid, taskId, -1, '主动失败', Date.now()]);
    
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, cultivation: row.cultivation });
    });
  });
});

// 6. 获取用户修为和统计（POST）
app.post('/api/profile', (req, res) => {
  const { openid } = req.body;
  if (!openid) return res.status(400).json({ error: 'missing openid' });
  
  db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.json({ cultivation: 0, totalTasks: 0, doneTasks: 0 });
    }
    
    db.get(`SELECT COUNT(*) as total FROM tasks WHERE openid=? AND status!='pending'`, [openid], (err, total) => {
      db.get(`SELECT COUNT(*) as done FROM tasks WHERE openid=? AND status='completed'`, [openid], (err, done) => {
        res.json({ 
          cultivation: row.cultivation, 
          totalTasks: total ? total.total : 0, 
          doneTasks: done ? done.done : 0 
        });
      });
    });
  });
});

// 7. 获取修为变动日志（POST）
app.post('/api/logs', (req, res) => {
  const { openid, limit = 50 } = req.body;
  if (!openid) return res.status(400).json({ error: 'missing openid' });
  
  db.all(`SELECT * FROM logs WHERE openid=? ORDER BY log_time DESC LIMIT ?`, [openid, limit], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ logs: rows || [] });
  });
});

// 8. 删除任务（POST）
app.post('/api/deleteTask', (req, res) => {
  const { openid, taskId } = req.body;
  if (!openid || !taskId) return res.status(400).json({ error: 'missing' });
  
  db.get(`SELECT * FROM tasks WHERE id=? AND openid=?`, [taskId, openid], (err, task) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!task) {
      return res.json({ success: false, message: '任务不存在' });
    }
    
    // 如果任务是待办且已逾期，先处理
    if (task.status === 'pending' && task.due_time < Date.now()) {
      db.run(`UPDATE users SET cultivation = cultivation - 1 WHERE openid=?`, [openid]);
      db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, 
        [openid, taskId, -1, '删除时逾期', Date.now()]);
    }
    
    db.run(`DELETE FROM tasks WHERE id=?`, [taskId], (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true });
    });
  });
});

// 9. 根路径测试（GET）
app.get('/', (req, res) => {
  res.json({ 
    message: '修仙计划表后端服务运行中', 
    status: 'ok',
    version: '1.0.0',
    endpoints: [
      'POST /api/login',
      'POST /api/tasks', 
      'POST /api/addTask',
      'POST /api/completeTask',
      'POST /api/failTask',
      'POST /api/profile',
      'POST /api/logs',
      'POST /api/deleteTask'
    ]
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`修仙计划表后端服务已启动`);
  console.log(`端口: ${PORT}`);
  console.log(`测试地址: https://cultivation-backend.onrender.com`);
  console.log(`========================================`);
});
