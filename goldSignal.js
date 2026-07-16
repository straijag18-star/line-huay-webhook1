// ==================================================================
// goldSignal.js
// ระบบวิเคราะห์จุดเข้าเทรดทองคำ (XAU/USD) แบบ Multi-Timeframe Price Action
// แนวคิด: หาแนวรับ-แนวต้านจาก swing high/low ที่ราคาเคยเทสต์ซ้ำ
//         ไล่ดูจาก TF ใหญ่ (bias) ลงไป TF เล็ก (จุดยืนยัน + จุดเข้าจริง)
// ==================================================================
//
// คำเตือน: นี่คือเครื่องมือช่วยแจ้งเตือนตามเงื่อนไขทางเทคนิคที่ตั้งไว้เท่านั้น
// ไม่ใช่คำแนะนำการลงทุน และไม่มีระบบใดการันตีผลกำไรได้ 100%
// ผู้ใช้ต้องบริหารความเสี่ยงและตัดสินใจด้วยตนเองทุกครั้ง
//
// ==================================================================

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const TWELVE_DATA_URL = 'https://api.twelvedata.com/time_series';
const SYMBOL = 'XAU/USD';

// timeframe ที่ใช้วิเคราะห์ เรียงจากใหญ่ไปเล็ก
const TIMEFRAMES = ['4h', '1h', '15m', '5m', '1m'];

// map ชื่อ interval ของเราให้ตรงกับที่ Twelve Data ใช้
const TWELVE_DATA_INTERVAL = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
};

function getTwelveDataKey() {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error('ไม่พบ TWELVE_DATA_API_KEY กรุณาตั้งค่า environment variable ก่อนใช้งาน');
  }
  return TWELVE_DATA_API_KEY;
}

// ---------------------------------------------------------------
// 1) ดึงข้อมูลแท่งเทียน (OHLC) จาก Twelve Data ทีละ timeframe
// ---------------------------------------------------------------
async function fetchCandles(period, limit = 100) {
  const interval = TWELVE_DATA_INTERVAL[period];
  const url = `${TWELVE_DATA_URL}?symbol=${encodeURIComponent(SYMBOL)}&interval=${interval}&outputsize=${limit}&apikey=${getTwelveDataKey()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '(อ่าน response ไม่ได้)');
    throw new Error(`Twelve Data error (${period}): ${res.status} - ${bodyText}`);
  }

  const data = await res.json();

  // Twelve Data ใช้ status "error" ในตัว body แม้ HTTP status จะเป็น 200 ก็ได้
  if (data.status === 'error') {
    throw new Error(`Twelve Data error (${period}): ${data.code || ''} - ${data.message || JSON.stringify(data)}`);
  }
  if (!Array.isArray(data.values)) {
    throw new Error(`Twelve Data error (${period}): ไม่พบข้อมูล values ใน response - ${JSON.stringify(data)}`);
  }

  // Twelve Data ส่งข้อมูลมาเรียงจาก "ใหม่ -> เก่า" และค่าเป็น string ต้องแปลงเป็น number
  // เรียงใหม่เป็นเก่า -> ใหม่ เพื่อให้ index ท้ายสุดคือแท่งล่าสุด (เหมือนของเดิม)
  return data.values
    .map(c => ({
      time: Math.floor(new Date(c.datetime).getTime() / 1000),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
    }))
    .sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------
// 2) หา Swing High / Swing Low แบบ fractal (n แท่งซ้าย-ขวา)
// ---------------------------------------------------------------
function findSwings(candles, n = 2) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = n; i < candles.length - n; i++) {
    const window = candles.slice(i - n, i + n + 1);
    const isHigh = window.every(c => candles[i].high >= c.high);
    const isLow = window.every(c => candles[i].low <= c.low);
    if (isHigh) swingHighs.push({ price: candles[i].high, time: candles[i].time });
    if (isLow) swingLows.push({ price: candles[i].low, time: candles[i].time });
  }
  return { swingHighs, swingLows };
}

// ---------------------------------------------------------------
// 3) รวมกลุ่มจุด swing ที่ราคาใกล้กัน (tolerance %) แล้วนับจำนวนครั้งที่โดนเทสต์
//    เก็บเฉพาะแนวที่ถูกเทสต์ >= 2 ครั้ง (validated zone)
// ---------------------------------------------------------------
function clusterLevels(points, tolerancePct = 0.0015) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];

  for (const p of sorted) {
    let cluster = clusters.find(c => Math.abs(c.avgPrice - p.price) / c.avgPrice <= tolerancePct);
    if (cluster) {
      cluster.touches.push(p);
      cluster.avgPrice = cluster.touches.reduce((s, t) => s + t.price, 0) / cluster.touches.length;
    } else {
      clusters.push({ avgPrice: p.price, touches: [p] });
    }
  }

  return clusters
    .filter(c => c.touches.length >= 2) // ต้องเทสต์ซ้ำอย่างน้อย 2 ครั้งถึงนับเป็นแนว
    .map(c => ({ price: c.avgPrice, strength: c.touches.length }))
    .sort((a, b) => b.strength - a.strength);
}

function getValidatedLevels(candles) {
  const { swingHighs, swingLows } = findSwings(candles);
  return {
    resistances: clusterLevels(swingHighs),
    supports: clusterLevels(swingLows),
  };
}

// ---------------------------------------------------------------
// 4) ตรวจจับแท่งเทียนกลับตัว (pin bar / engulfing) ที่แท่งล่าสุด
// ---------------------------------------------------------------
function detectReversalPattern(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  // Pin bar ขาขึ้น (หางล่างยาว body เล็ก)
  if (range > 0 && lowerWick / range > 0.55 && body / range < 0.35) {
    return { type: 'bullish_pinbar', bias: 'long' };
  }
  // Pin bar ขาลง (หางบนยาว)
  if (range > 0 && upperWick / range > 0.55 && body / range < 0.35) {
    return { type: 'bearish_pinbar', bias: 'short' };
  }
  // Bullish engulfing
  if (prev.close < prev.open && last.close > last.open &&
      last.close > prev.open && last.open < prev.close) {
    return { type: 'bullish_engulfing', bias: 'long' };
  }
  // Bearish engulfing
  if (prev.close > prev.open && last.close < last.open &&
      last.close < prev.open && last.open > prev.close) {
    return { type: 'bearish_engulfing', bias: 'short' };
  }
  return null;
}

// ---------------------------------------------------------------
// 5) โครงหลัก: วิเคราะห์ทุก timeframe แล้วสรุปเป็นสัญญาณเดียว
// ---------------------------------------------------------------
async function analyzeGoldSignal() {
  // 5.1 ดึงข้อมูลทุก TF พร้อมกัน
  const candleSets = {};
  for (const tf of TIMEFRAMES) {
    candleSets[tf] = await fetchCandles(tf, 100);
  }

  const currentPrice = candleSets['1m'][candleSets['1m'].length - 1].close;

  // 5.2 หาแนวรับ-แนวต้านจาก TF ใหญ่ (4H, 1H) เป็นหลัก เพื่อกำหนด bias
  const levels4h = getValidatedLevels(candleSets['4h']);
  const levels1h = getValidatedLevels(candleSets['1h']);

  const nearZoneTolerance = 0.01; // ⚠️ TEMP TEST: ขยายจาก 0.002 (0.2%) เป็น 0.01 (1%) ชั่วคราวเพื่อทดสอบการส่งสัญญาณเข้า LINE — อย่าลืมเปลี่ยนกลับเป็น 0.002 หลังทดสอบเสร็จ!
  const isNear = (price, level) => Math.abs(price - level.price) / level.price <= nearZoneTolerance;

  const nearSupport4h = levels4h.supports.find(l => isNear(currentPrice, l));
  const nearResistance4h = levels4h.resistances.find(l => isNear(currentPrice, l));
  const nearSupport1h = levels1h.supports.find(l => isNear(currentPrice, l));
  const nearResistance1h = levels1h.resistances.find(l => isNear(currentPrice, l));

  const keyLevel = nearSupport4h || nearSupport1h || nearResistance4h || nearResistance1h;
  if (!keyLevel) {
    return { hasSignal: false, reason: 'ราคายังไม่เข้าใกล้แนวรับ-แนวต้านสำคัญใน TF 4H/1H' };
  }

  const biasDirection = (nearSupport4h || nearSupport1h) ? 'long' : 'short';

  // 5.3 หา pattern ยืนยันใน TF เล็ก (15M -> 5M -> 1M) ต้องสอดคล้องทิศทางเดียวกับ bias
  const pattern15m = detectReversalPattern(candleSets['15m']);
  const pattern5m = detectReversalPattern(candleSets['5m']);
  const pattern1m = detectReversalPattern(candleSets['1m']);

  const confirmations = [
    { tf: '15m', pattern: pattern15m },
    { tf: '5m', pattern: pattern5m },
    { tf: '1m', pattern: pattern1m },
  ].filter(c => c.pattern && c.pattern.bias === biasDirection);

  // ต้องมีอย่างน้อย 1 TF เล็กยืนยันทิศทางเดียวกับ bias ถึงจะออกสัญญาณ
  if (confirmations.length === 0) {
    return {
      hasSignal: false,
      reason: `ราคาใกล้แนว ${keyLevel.price.toFixed(2)} (bias: ${biasDirection}) แต่ยังไม่มีแท่งเทียนยืนยันใน TF เล็ก`,
    };
  }

  // 5.4 คำนวณ Entry / SL / TP
  const entry = currentPrice;
  const bufferPct = 0.0015; // กันชนเผื่อ noise ~0.15%
  const stopLoss = biasDirection === 'long'
    ? keyLevel.price * (1 - bufferPct)
    : keyLevel.price * (1 + bufferPct);

  // TP = แนวถัดไปฝั่งตรงข้ามที่ใกล้ที่สุดจาก TF 1H (ถ้าไม่มีใช้ 4H)
  const oppositeLevels = biasDirection === 'long'
    ? [...levels1h.resistances, ...levels4h.resistances]
    : [...levels1h.supports, ...levels4h.supports];

  const sortedByDistance = oppositeLevels
    .filter(l => biasDirection === 'long' ? l.price > entry : l.price < entry)
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  const takeProfit = sortedByDistance[0]
    ? sortedByDistance[0].price
    : biasDirection === 'long' ? entry * 1.006 : entry * 0.994; // fallback ~0.6%

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  const riskRewardRatio = risk > 0 ? +(reward / risk).toFixed(2) : 0;

  // กรองสัญญาณคุณภาพต่ำ: RR ต้องอย่างน้อย 1.2 ขึ้นไป
  if (riskRewardRatio < 1.2) {
    return { hasSignal: false, reason: `RR ratio ต่ำเกินไป (${riskRewardRatio}) ไม่ออกสัญญาณ` };
  }

  return {
    hasSignal: true,
    direction: biasDirection,
    entry: +entry.toFixed(2),
    stopLoss: +stopLoss.toFixed(2),
    takeProfit: +takeProfit.toFixed(2),
    riskRewardRatio,
    keyLevel: +keyLevel.price.toFixed(2),
    keyLevelStrength: keyLevel.strength,
    confirmations: confirmations.map(c => `${c.tf}: ${c.pattern.type}`),
  };
}

// ---------------------------------------------------------------
// 6) จัดรูปแบบข้อความสำหรับส่งเข้า LINE
// ---------------------------------------------------------------
function formatSignalMessage(signal) {
  if (!signal.hasSignal) return null; // ไม่มีสัญญาณ ไม่ต้องส่งอะไร

  const dirText = signal.direction === 'long' ? '🟢 เข้า BUY (Long)' : '🔴 เข้า SELL (Short)';

  return [
    `📊 สัญญาณเทรดทองคำ (XAU/USD)`,
    ``,
    dirText,
    `จุดเข้า: ${signal.entry}`,
    `Stop Loss: ${signal.stopLoss}`,
    `Take Profit: ${signal.takeProfit}`,
    `Risk:Reward = 1:${signal.riskRewardRatio}`,
    ``,
    `เหตุผล:`,
    `- แนวสำคัญ (4H/1H): ${signal.keyLevel} (โดนเทสต์ ${signal.keyLevelStrength} ครั้ง)`,
    `- ยืนยันจาก: ${signal.confirmations.join(', ')}`,
    ``,
    `⚠️ นี่คือสัญญาณจากการวิเคราะห์ทางเทคนิคอัตโนมัติเท่านั้น`,
    `ไม่ใช่คำแนะนำการลงทุน โปรดบริหารความเสี่ยงและตัดสินใจด้วยตัวเองทุกครั้ง`,
  ].join('\n');
}

module.exports = { analyzeGoldSignal, formatSignalMessage };
