const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const schedule = require('node-schedule');
// const axios = require('axios');  // 暂时注释，因为用不到

const app = express();
app.use(bodyParser.json());

// ------------------- 配置区（暂时注释，用于测试） -------------------
// const WX_APPID = '你的小程序AppID';
// const WX_SECRET = '你的小程序AppSecret';
// const TEMPLATE_ID = '你的模板ID';
// ----------------------------------------------------------------

// 初始化数据库
const db = new sqlite3.Database('./db.sqlite');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (openid TEXT PRIMARY KEY, cultivation INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, openid TEXT, title TEXT, due_time INTEGER, remind_minutes INTEGER DEFAULT 15, status TEXT DEFAULT 'pending', reminded_flag INTEGER DEFAULT 0, create_time INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT, task_id TEXT, change INTEGER, reason TEXT, log_time INTEGER)`);
});

// ========== 以下函数暂时注释，等配置好微信后再放开 ==========
/*
let accessTokenCache = { token: '', expireTime: 0 };
async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expireTime) return accessTokenCache.token;
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_SECRET}`;
  const res = await axios.get(url);
  if (res.data.access_token) {
    accessTokenCache.token = res.data.access_token;
    accessTokenCache.expireTime = Date.now() + (res.data.expires_in - 300) * 1000;
    return res.data.access_token;
  }
  throw new Error('获取access_token失败');
}

async function sendReminder(openid, taskTitle, dueTime, remindMinutes) {
  const accessToken = await getAccessToken();
  const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`;
  const dueDate = new Date(dueTime);
  const dueStr = `${dueDate.getFullYear()}-${dueDate.getMonth()+1}-${dueDate.getDate()} ${dueDate.getHours()}:${dueDate.getMinutes()}`;
  await axios.post(url, {
    touser: openid,
    template_id: TEMPLATE_ID,
    data: { thing1: { value: taskTitle }, time2: { value: dueStr }, thing3: { value: `${remindMinutes}分钟后到达` } }
  });
}

// 定时任务：发送提醒（暂时注释）
schedule.scheduleJob('* * * * *', async () => {
  const now = Date.now();
  db.all(`SELECT * FROM tasks WHERE status='pending' AND reminded_flag=0 AND (due_time - remind_minutes*60*1000) <= ?`, [now], async (err, tasks) => {
    if (err) return;
    for (const task of tasks) {
      await sendReminder(task.openid, task.title, task.due_time, task.remind_minutes);
      db.run(`UPDATE tasks SET reminded_flag=1 WHERE id=?`, [task.id]);
    }
  });
});
*/

// 定时任务：处理逾期未完成的任务（保留）
schedule.scheduleJob('*/5 * * * *', async () => {
  const now = Date.now();
  db.all(`SELECT * FROM tasks WHERE status='pending' AND due_time < ?`, [now], async (err, tasks) => {
    if (err) return;
    for (const task of tasks) {
      db.run(`UPDATE users SET cultivation = cultivation - 1 WHERE openid=?`, [task.openid]);
      db.run(`UPDATE tasks SET status='failed' WHERE id=?`, [task.id]);
      db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, [task.openid, task.id, -1, '逾期自动失败', now]);
    }
  });
});

// ========== API 路由 ==========

// 1. 用户登录（临时模拟版本，无需微信 code）
app.post('/api/login', async (req, res) => {
  // 临时方案：使用一个固定的测试 openid
  // 正式版需要改为从 req.body.code 换取真实 openid
  const { code } = req.body;
  // 为了测试，即使用户不传 code，也返回一个模拟的 openid
  const mockOpenid = code ? `test_${code}` : `test_${Date.now()}`;
  
  db.get(`SELECT * FROM users WHERE openid=?`, [mockOpenid], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO users (openid, cultivation) VALUES (?,0)`, [mockOpenid]);
    }
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [mockOpenid], (err, userRow) => {
      res.json({ openid: mockOpenid, cultivation: userRow ? userRow.cultivation : 0 });
    });
  });
});

// 2. 获取用户的所有任务
app.post('/api/tasks', (req, res) => {
  const { openid } = req.body;
  if (!openid) return res.status(400).json({ error: 'missing openid' });
  db.all(`SELECT * FROM tasks WHERE openid=? ORDER BY due_time ASC`, [openid], (err, rows) => {
    res.json({ tasks: rows || [] });
  });
});

// 3. 添加任务
app.post('/api/addTask', (req, res) => {
  const { openid, title, dueTime, remindMinutes } = req.body;
  if (!openid || !title || !dueTime) return res.status(400).json({ error: 'missing fields' });
  const id = Date.now() + '_' + Math.random().toString(36);
  db.run(`INSERT INTO tasks (id, openid, title, due_time, remind_minutes, reminded_flag, create_time) VALUES (?,?,?,?,?,0,?)`, 
    [id, openid, title, dueTime, remindMinutes || 15, Date.now()], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, taskId: id });
    });
});

// 4. 完成任务
app.post('/api/completeTask', (req, res) => {
  const { openid, taskId } = req.body;
  if (!openid || !taskId) return res.status(400).json({ error: 'missing' });
  db.get(`SELECT * FROM tasks WHERE id=? AND openid=? AND status='pending'`, [taskId, openid], (err, task) => {
    if (!task) return res.json({ success: false, message: '任务不存在或已处理' });
    db.run(`UPDATE users SET cultivation = cultivation + 1 WHERE openid=?`, [openid]);
    db.run(`UPDATE tasks SET status='completed' WHERE id=?`, [taskId]);
    db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, 
      [openid, taskId, 1, '主动完成', Date.now()]);
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
      res.json({ success: true, cultivation: row.cultivation });
    });
  });
});

// 5. 任务失败（手动）
app.post('/api/failTask', (req, res) => {
  const { openid, taskId } = req.body;
  if (!openid || !taskId) return res.status(400).json({ error: 'missing' });
  db.get(`SELECT * FROM tasks WHERE id=? AND openid=? AND status='pending'`, [taskId, openid], (err, task) => {
    if (!task) return res.json({ success: false, message: '任务不存在或已处理' });
    db.run(`UPDATE users SET cultivation = cultivation - 1 WHERE openid=?`, [openid]);
    db.run(`UPDATE tasks SET status='failed' WHERE id=?`, [taskId]);
    db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, 
      [openid, taskId, -1, '主动失败', Date.now()]);
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
      res.json({ success: true, cultivation: row.cultivation });
    });
  });
});

// 6. 获取修为和统计
app.post('/api/profile', (req, res) => {
  const { openid } = req.body;
  if (!openid) return res.status(400).json({ error: 'missing openid' });
  db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
    if (!row) return res.json({ cultivation: 0, totalTasks: 0, doneTasks: 0 });
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

// 7. 添加一个简单的根路径，用于测试服务是否正常
app.get('/', (req, res) => {
  res.json({ message: '修仙计划表后端服务运行中', status: 'ok' });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`测试地址: http://localhost:${PORT}/`);
  console.log(`API示例: POST /api/login`);
});
