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
