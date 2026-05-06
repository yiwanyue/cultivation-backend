const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const schedule = require('node-schedule');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ------------------- 配置区（稍后修改） -------------------
const WX_APPID = '你的小程序AppID';
const WX_SECRET = '你的小程序AppSecret';
const TEMPLATE_ID = '你的模板ID';
// -------------------------------------------------------

const db = new sqlite3.Database('./db.sqlite');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (openid TEXT PRIMARY KEY, cultivation INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, openid TEXT, title TEXT, due_time INTEGER, remind_minutes INTEGER DEFAULT 15, status TEXT DEFAULT 'pending', reminded_flag INTEGER DEFAULT 0, create_time INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, openid TEXT, task_id TEXT, change INTEGER, reason TEXT, log_time INTEGER)`);
});

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

app.post('/api/login', async (req, res) => {
  const { code } = req.body;
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_SECRET}&js_code=${code}&grant_type=authorization_code`;
  const wxRes = await axios.get(url);
  const openid = wxRes.data.openid;
  if (!openid) return res.status(500).json({ error: 'get openid failed' });
  db.get(`SELECT * FROM users WHERE openid=?`, [openid], (err, row) => {
    if (!row) db.run(`INSERT INTO users (openid, cultivation) VALUES (?,0)`, [openid]);
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, userRow) => {
      res.json({ openid, cultivation: userRow ? userRow.cultivation : 0 });
    });
  });
});

app.post('/api/tasks', (req, res) => {
  const { openid } = req.body;
  db.all(`SELECT * FROM tasks WHERE openid=? ORDER BY due_time ASC`, [openid], (err, rows) => {
    res.json({ tasks: rows || [] });
  });
});

app.post('/api/addTask', (req, res) => {
  const { openid, title, dueTime, remindMinutes } = req.body;
  const id = Date.now() + '_' + Math.random().toString(36);
  db.run(`INSERT INTO tasks (id, openid, title, due_time, remind_minutes, reminded_flag, create_time) VALUES (?,?,?,?,?,0,?)`, [id, openid, title, dueTime, remindMinutes || 15, Date.now()], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, taskId: id });
  });
});

app.post('/api/completeTask', (req, res) => {
  const { openid, taskId } = req.body;
  db.get(`SELECT * FROM tasks WHERE id=? AND openid=? AND status='pending'`, [taskId, openid], (err, task) => {
    if (!task) return res.json({ success: false, message: '任务不存在或已处理' });
    db.run(`UPDATE users SET cultivation = cultivation + 1 WHERE openid=?`, [openid]);
    db.run(`UPDATE tasks SET status='completed' WHERE id=?`, [taskId]);
    db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, [openid, taskId, 1, '主动完成', Date.now()]);
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
      res.json({ success: true, cultivation: row.cultivation });
    });
  });
});

app.post('/api/failTask', (req, res) => {
  const { openid, taskId } = req.body;
  db.get(`SELECT * FROM tasks WHERE id=? AND openid=? AND status='pending'`, [taskId, openid], (err, task) => {
    if (!task) return res.json({ success: false, message: '任务不存在或已处理' });
    db.run(`UPDATE users SET cultivation = cultivation - 1 WHERE openid=?`, [openid]);
    db.run(`UPDATE tasks SET status='failed' WHERE id=?`, [taskId]);
    db.run(`INSERT INTO logs (openid, task_id, change, reason, log_time) VALUES (?,?,?,?,?)`, [openid, taskId, -1, '主动失败', Date.now()]);
    db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
      res.json({ success: true, cultivation: row.cultivation });
    });
  });
});

app.post('/api/profile', (req, res) => {
  const { openid } = req.body;
  db.get(`SELECT cultivation FROM users WHERE openid=?`, [openid], (err, row) => {
    if (!row) return res.json({ cultivation: 0, totalTasks: 0, doneTasks: 0 });
    db.get(`SELECT COUNT(*) as total FROM tasks WHERE openid=? AND status!='pending'`, [openid], (err, total) => {
      db.get(`SELECT COUNT(*) as done FROM tasks WHERE openid=? AND status='completed'`, [openid], (err, done) => {
        res.json({ cultivation: row.cultivation, totalTasks: total ? total.total : 0, doneTasks: done ? done.done : 0 });
      });
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));