// server.js
// ตัวอย่าง Webhook server รับข้อความจาก LINE Official Account
// แล้วแยกชื่อลูกค้า/เลข/ยอด ด้วย logic เดียวกับระบบใบเสนอราคาหวย (HTML)
//
// รันทดสอบในเครื่อง:   npm install && npm start
// ต้อง deploy ขึ้นโฮสต์ที่มี URL สาธารณะ (HTTPS) ก่อน LINE ถึงจะยิง Webhook มาถึงได้จริง
// (เช่น Render, Railway, Fly.io, VPS ของตัวเอง ฯลฯ)

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const DB_FILE = path.join(__dirname, 'db.json');

// ---------- ฐานข้อมูลอย่างง่าย (ไฟล์ JSON) ----------
// หมายเหตุ: นี่คือฐานข้อมูลชั่วคราวสำหรับตัวอย่าง/ทดสอบเท่านั้น
// การใช้งานจริงควรเปลี่ยนไปใช้ฐานข้อมูลจริง เช่น PostgreSQL, MongoDB, SQLite ฯลฯ
// เพราะไฟล์ JSON ไม่รองรับการเขียนพร้อมกันหลายคำขอ (concurrent write) และจะหายถ้าโฮสต์รีสตาร์ท
// (ขึ้นกับผู้ให้บริการโฮสติ้งบางเจ้าที่ไม่มี persistent disk)
function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { records: [], subscribers: [], trades: [] };
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(db.subscribers)) db.subscribers = []; // เผื่อไฟล์เดิมยังไม่มี field นี้
    if (!Array.isArray(db.records)) db.records = [];
    if (!Array.isArray(db.trades)) db.trades = []; // ประวัติสัญญาณเทรด/สถิติ
    return db;
  } catch (e) { return { records: [], subscribers: [], trades: [] }; }
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- บันทึกสัญญาณที่ยิงออกไปเป็น "เทรดที่เปิดอยู่" (open) เพื่อติดตามผลภายหลัง ----------
function recordTrade(signal) {
  const db = loadDb();
  db.trades.push({
    id: 't' + Date.now() + Math.random().toString(36).slice(2, 7),
    direction: signal.direction,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    riskRewardRatio: signal.riskRewardRatio,
    keyLevel: signal.keyLevel,
    openedAt: new Date().toISOString(),
    status: 'open', // open -> win | loss
    exitPrice: null,
    resultR: null,
    closedAt: null,
  });
  saveDb(db);
}

// ---------- เช็คเทรดที่เปิดอยู่ทุกตัว ว่าราคาล่าสุดชน SL หรือ TP ก่อนกันหรือยัง ----------
// ข้อจำกัด: เช็คแค่ high/low ของแท่ง 1 นาทีล่าสุดเทียบกับ SL/TP เป็นการประมาณ
// ถ้า SL และ TP ถูกชนในแท่งเดียวกันพอดี จะนับเป็น SL ก่อนเสมอ (ระมัดระวังไว้ก่อน)
async function updateOpenTrades() {
  const db = loadDb();
  const openTrades = db.trades.filter(t => t.status === 'open');
  if (openTrades.length === 0) return;

  let latest;
  try {
    latest = await getLatestCandle();
  } catch (err) {
    console.error('เช็คผลเทรดที่เปิดอยู่ไม่สำเร็จ (ดึงราคาล่าสุดไม่ได้):', err.message);
    return;
  }

  let changed = false;
  for (const trade of openTrades) {
    const hitSL = trade.direction === 'long' ? latest.low <= trade.stopLoss : latest.high >= trade.stopLoss;
    const hitTP = trade.direction === 'long' ? latest.high >= trade.takeProfit : latest.low <= trade.takeProfit;

    if (hitSL) {
      trade.status = 'loss';
      trade.exitPrice = trade.stopLoss;
      trade.resultR = -1;
      trade.closedAt = new Date().toISOString();
      changed = true;
    } else if (hitTP) {
      trade.status = 'win';
      trade.exitPrice = trade.takeProfit;
      trade.resultR = +trade.riskRewardRatio.toFixed(2);
      trade.closedAt = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) saveDb(db);
}

// ---------- จัดการรายชื่อผู้ที่จะรับการแจ้งเตือน (คนที่ add เพื่อน/เคยทักมา) ----------
function addSubscriber(db, userId) {
  if (!userId) return;
  if (!db.subscribers.includes(userId)) {
    db.subscribers.push(userId);
    console.log('เพิ่มผู้รับการแจ้งเตือนใหม่:', userId);
  }
}
function removeSubscriber(db, userId) {
  if (!userId) return;
  const before = db.subscribers.length;
  db.subscribers = db.subscribers.filter(id => id !== userId);
  if (db.subscribers.length !== before) {
    console.log('ลบผู้รับการแจ้งเตือน (unfollow/block):', userId);
  }
}

// ---------- แยกข้อความ (ใช้ logic เดียวกับช่อง "วางข้อมูลด่วน" ในหน้าเว็บ) ----------
// รูปแบบที่รองรับ ต่อ 1 ข้อความ (1 บับเบิลแชท อาจมีหลายบรรทัด):
//   ชื่อลูกค้า
//   เลข ค่า1*ค่า2
//   เลข ค่า1 ค่า2
//   เลข ค่า1*ค่า2 กลับ   (สามตัวโต๊ด/กลับ)
function parseMessageText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const numRegex = /\d+(?:\.\d+)?/g;
  const groups = [];
  let current = null;
  lines.forEach(line => {
    const nums = line.match(numRegex);
    const isKlub = /กลับ/.test(line);
    if (nums && nums.length >= 3) {
      if (!current) { current = { name: '', entries: [] }; groups.push(current); }
      current.entries.push({
        number: nums[0],
        val1: parseFloat(nums[1]),
        val2: parseFloat(nums[2]),
        isKlub
      });
    } else {
      current = { name: line, entries: [] };
      groups.push(current);
    }
  });
  return groups.filter(g => g.entries.length > 0);
}

function rowTotal(num, v1, v2, isKlub) {
  if (num.length === 3 && isKlub) return v1 * v2;
  return v1 + v2;
}

function groupTotal(entries) {
  return entries.reduce((s, e) => s + rowTotal(e.number, e.val1, e.val2, e.isKlub), 0);
}

// ---------- ตรวจลายเซ็น LINE (signature verification) ----------
// LINE จะแนบ header 'x-line-signature' มาด้วยทุกครั้ง ต้องตรวจสอบก่อนเชื่อข้อมูล
// ไม่เช่นนั้นใครก็ยิง request ปลอมมาที่ webhook ของเราได้
function verifySignature(rawBody, signature) {
  if (!CHANNEL_SECRET) return false;
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  return hash === signature;
}

// ต้องใช้ raw body (ไม่ผ่าน JSON parser ก่อน) เพื่อตรวจลายเซ็นให้ตรงกับที่ LINE เซ็นมา
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(express.json()); // สำหรับ route อื่น ๆ

// ---------- ส่งข้อความตอบกลับใน LINE (reply API) ----------
async function replyMessage(replyToken, text) {
  if (!CHANNEL_ACCESS_TOKEN) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text }]
      })
    });
  } catch (e) {
    console.error('ส่งข้อความตอบกลับไม่สำเร็จ:', e.message);
  }
}

// ---------- webhook endpoint หลัก ----------
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const rawBody = req.body; // Buffer เพราะใช้ express.raw()

  if (!verifySignature(rawBody, signature)) {
    console.warn('ลายเซ็นไม่ถูกต้อง - ปฏิเสธ request');
    return res.status(401).send('invalid signature');
  }

  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); }
  catch (e) { return res.status(400).send('invalid json'); }

  const events = body.events || [];
  const db = loadDb();

  for (const event of events) {
    const userId = event.source ? event.source.userId : null;

    // ---------- คนกด Add เพื่อน หรือ Unblock OA ----------
    if (event.type === 'follow') {
      addSubscriber(db, userId);
      saveDb(db);
      continue;
    }

    // ---------- คน Block/ลบเพื่อน OA ----------
    if (event.type === 'unfollow') {
      removeSubscriber(db, userId);
      saveDb(db);
      continue;
    }

    if (event.type !== 'message' || event.message.type !== 'text') continue;

    // ทุกครั้งที่มีคนทักมา ให้บันทึกไว้เป็นผู้รับการแจ้งเตือนด้วย (เผื่อพลาด follow event)
    addSubscriber(db, userId);

    const text = event.message.text;
    const groups = parseMessageText(text);

    if (groups.length === 0) {
      // ข้อความที่ส่งมาไม่ตรงรูปแบบที่ระบบเข้าใจ (เช่นแชทคุยเล่นทั่วไป) - ไม่บันทึกเป็น record แต่ subscriber ข้างบนบันทึกไปแล้ว
      saveDb(db);
      continue;
    }

    let replyLines = [];
    groups.forEach(g => {
      const total = groupTotal(g.entries);
      const record = {
        id: 'r' + Date.now() + Math.random().toString(36).slice(2, 7),
        name: g.name || '(ไม่ระบุชื่อ)',
        seller: 'จาก LINE OA', // TODO: ปรับให้ระบุผู้ขายจริงตาม LINE user/group ที่ทักเข้ามา
        source: 'line',
        lineUserId: event.source ? event.source.userId : null,
        savedAt: new Date().toISOString(),
        entries: g.entries
      };
      db.records.push(record);
      replyLines.push(`${record.name}: รวม ${total.toLocaleString()} บาท`);
    });

    saveDb(db);

    // ตอบกลับสรุปยอดให้ผู้ส่งทราบทันทีว่าระบบรับข้อมูลแล้ว
    if (event.replyToken) {
      await replyMessage(event.replyToken, `บันทึกแล้ว ✓\n${replyLines.join('\n')}`);
    }
  }

  res.status(200).send('OK');
});

// ---------- ดึงข้อมูลที่บันทึกไว้ทั้งหมด (ให้หน้าเว็บ/ระบบอื่นเรียกดูได้) ----------
app.get('/records', (req, res) => {
  const db = loadDb();
  res.json(db.records);
});

app.get('/subscribers', (req, res) => {
  const db = loadDb();
  res.json({ count: (db.subscribers || []).length, subscribers: db.subscribers || [] });
});

// ---------- สถิติการเทรด สำหรับหน้าแดชบอร์ด ----------
app.get('/api/stats', (req, res) => {
  const db = loadDb();
  const trades = db.trades || [];
  const closed = trades.filter(t => t.status === 'win' || t.status === 'loss');
  const wins = closed.filter(t => t.status === 'win');
  const losses = closed.filter(t => t.status === 'loss');
  const totalR = closed.reduce((s, t) => s + t.resultR, 0);
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const avgRR = trades.length ? trades.reduce((s, t) => s + t.riskRewardRatio, 0) / trades.length : 0;

  let cum = 0;
  const equityCurve = closed
    .slice()
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))
    .map(t => {
      cum += t.resultR;
      return { time: t.closedAt, cumR: +cum.toFixed(2) };
    });

  res.json({
    totalSignals: trades.length,
    openTrades: trades.filter(t => t.status === 'open').length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +winRate.toFixed(1),
    avgRR: +avgRR.toFixed(2),
    totalR: +totalR.toFixed(2),
    equityCurve,
    trades: trades.slice().sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt)).slice(0, 100),
  });
});

// ---------- หน้าแดชบอร์ดติดตามผล ----------
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`LINE webhook server กำลังทำงานที่พอร์ต ${PORT}`);
});
// ==================================================================
// โค้ดส่วนนี้ให้เพิ่มเข้าไปใน server.js เดิม (ต่อท้ายไฟล์ หรือใกล้ๆ ส่วน replyMessage)
// ==================================================================

const { analyzeGoldSignal, formatSignalMessage, generateChartImageUrl, getLatestCandle } = require('./goldSignal');

// ---------- ส่งข้อความแบบ push ไปหาทุกคนที่ add เพื่อน/เคยทักเข้ามา (ไม่ใช่ reply เพราะเป็นการแจ้งเตือนเอง ไม่ได้ตอบใคร) ----------
// ใช้ LINE Multicast API ส่งพร้อมกันได้สูงสุด 500 คนต่อ 1 ครั้ง
// ถ้ามี imageUrl แนบมาด้วย จะส่งรูปกราฟก่อน แล้วตามด้วยข้อความตัวหนังสือ (สูงสุด 5 ข้อความต่อ multicast call)
async function pushMessage(text, imageUrl = null) {
  if (!CHANNEL_ACCESS_TOKEN) {
    console.warn('ไม่พบ LINE_CHANNEL_ACCESS_TOKEN - ข้ามการส่งแจ้งเตือน');
    return;
  }

  const db = loadDb();
  let subscribers = db.subscribers || [];

  // รองรับของเดิม: ถ้ามีตั้ง LINE_PUSH_TARGET_ID ไว้ ให้รวมเข้าไปด้วย (เผื่ออยากส่งไปกลุ่ม/คนที่ตั้งไว้ตายตัวด้วย)
  const fixedTargetId = process.env.LINE_PUSH_TARGET_ID;
  if (fixedTargetId && !subscribers.includes(fixedTargetId)) {
    subscribers = [...subscribers, fixedTargetId];
  }

  if (subscribers.length === 0) {
    console.warn('ยังไม่มีผู้รับการแจ้งเตือนเลย (ยังไม่มีใคร add เพื่อน/ทักเข้ามา) - ข้ามการส่ง');
    return;
  }

  const messages = [];
  if (imageUrl) {
    messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
  }
  messages.push({ type: 'text', text });

  // LINE จำกัดสูงสุด 500 คนต่อ multicast call เดียว - แบ่งเป็นชุดๆ ถ้าเกิน
  const BATCH_SIZE = 500;
  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/multicast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          to: batch,
          messages,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        console.error(`ส่ง multicast ไม่สำเร็จ (${res.status}):`, bodyText);
      } else {
        console.log(`ส่งแจ้งเตือนไปหาผู้ติดตาม ${batch.length} คนสำเร็จ`);
      }
    } catch (err) {
      console.error('ส่ง push message ไม่สำเร็จ:', err);
    }
  }
}

// ---------- ฟังก์ชันเช็คสัญญาณแล้วส่งแจ้งเตือน (ถ้ามีสัญญาณ) ----------
let lastSignalKey = null; // กันส่งสัญญาณซ้ำๆ ทุกรอบถ้าเงื่อนไขยังไม่เปลี่ยน

async function checkAndNotify() {
  // เช็คผลเทรดที่เปิดอยู่ก่อนทุกครั้ง (ราคาชน SL/TP หรือยัง) เพื่ออัปเดตสถิติให้ทันปัจจุบัน
  await updateOpenTrades();

  try {
    const signal = await analyzeGoldSignal();
    if (!signal.hasSignal) {
      console.log('ยังไม่มีสัญญาณ:', signal.reason);
      return;
    }

    // สร้าง key จากรายละเอียดสัญญาณ กันไม่ให้ส่งข้อความเดิมซ้ำทุก 5-15 นาที
    const signalKey = `${signal.direction}-${signal.entry}-${signal.keyLevel}`;
    if (signalKey === lastSignalKey) {
      console.log('สัญญาณเดิม ไม่ส่งซ้ำ');
      return;
    }
    lastSignalKey = signalKey;

    recordTrade(signal); // บันทึกลงสถิติเป็นเทรดที่เปิดอยู่ ก่อนส่งแจ้งเตือน

    const message = formatSignalMessage(signal);
    const chartUrl = await generateChartImageUrl(signal); // ถ้าสร้างไม่สำเร็จจะได้ null แล้วส่งแค่ข้อความตัวหนังสือ
    await pushMessage(message, chartUrl);
    console.log('ส่งสัญญาณเทรดแล้ว:', signalKey, chartUrl ? '(พร้อมรูปกราฟ)' : '(ไม่มีรูปกราฟ)');
  } catch (err) {
    console.error('เกิดข้อผิดพลาดตอนวิเคราะห์สัญญาณ:', err);
  }
}

// ---------- ตั้งเวลาให้เช็คทุก 5 นาที ----------
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 นาที
setInterval(checkAndNotify, CHECK_INTERVAL_MS);

// เช็คครั้งแรกทันทีตอน server เริ่มทำงาน (ไม่ต้องรอ 5 นาทีแรก)
checkAndNotify();
