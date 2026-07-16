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
  if (!fs.existsSync(DB_FILE)) return { records: [] };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { records: [] }; }
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const text = event.message.text;
    const groups = parseMessageText(text);

    if (groups.length === 0) {
      // ข้อความที่ส่งมาไม่ตรงรูปแบบที่ระบบเข้าใจ (เช่นแชทคุยเล่นทั่วไป) - ข้ามไปเฉย ๆ ไม่บันทึก
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

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`LINE webhook server กำลังทำงานที่พอร์ต ${PORT}`);
});
// ==================================================================
// โค้ดส่วนนี้ให้เพิ่มเข้าไปใน server.js เดิม (ต่อท้ายไฟล์ หรือใกล้ๆ ส่วน replyMessage)
// ==================================================================

const { analyzeGoldSignal, formatSignalMessage } = require('./goldSignal');

// ---------- ส่งข้อความแบบ push (ไม่ใช่ reply เพราะเป็นการแจ้งเตือนเอง ไม่ได้ตอบใคร) ----------
async function pushMessage(text) {
  const targetId = process.env.LINE_PUSH_TARGET_ID; // userId หรือ groupId ที่จะส่งแจ้งเตือนไปหา
  if (!targetId || !CHANNEL_ACCESS_TOKEN) return;

  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: targetId,
        messages: [{ type: 'text', text }],
      }),
    });
  } catch (err) {
    console.error('ส่ง push message ไม่สำเร็จ:', err);
  }
}

// ---------- ฟังก์ชันเช็คสัญญาณแล้วส่งแจ้งเตือน (ถ้ามีสัญญาณ) ----------
let lastSignalKey = null; // กันส่งสัญญาณซ้ำๆ ทุกรอบถ้าเงื่อนไขยังไม่เปลี่ยน

async function checkAndNotify() {
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

    const message = formatSignalMessage(signal);
    await pushMessage(message);
    console.log('ส่งสัญญาณเทรดแล้ว:', signalKey);
  } catch (err) {
    console.error('เกิดข้อผิดพลาดตอนวิเคราะห์สัญญาณ:', err);
  }
}

// ---------- ตั้งเวลาให้เช็คทุก 5 นาที ----------
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 นาที
setInterval(checkAndNotify, CHECK_INTERVAL_MS);

// เช็คครั้งแรกทันทีตอน server เริ่มทำงาน (ไม่ต้องรอ 5 นาทีแรก)
checkAndNotify();
