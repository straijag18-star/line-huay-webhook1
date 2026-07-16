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
// 4.1) หา "แท่งหลัก" (impulse candle) ที่ใช้เป็นฐานคำนวณ 50% ของเนื้อแท่ง (body)
//      สำหรับฝั่ง Long: หาแท่งเขียว (แท่งขาขึ้น) ที่ body ใหญ่ที่สุดใน lookback ล่าสุด
//      สำหรับฝั่ง Short: หาแท่งแดง (แท่งขาลง) ที่ body ใหญ่ที่สุดใน lookback ล่าสุด
// ---------------------------------------------------------------
function getImpulseCandle(candles, biasDirection, lookback = 12) {
  const recent = candles.slice(-lookback, -1); // ไม่รวมแท่งล่าสุด (เก็บไว้เป็นแท่งยืนยัน)
  const isBullish = c => c.close > c.open;
  const isBearish = c => c.close < c.open;
  const candidates = recent.filter(c => biasDirection === 'long' ? isBullish(c) : isBearish(c));
  if (candidates.length === 0) return null;

  return candidates.reduce((biggest, c) => {
    const body = Math.abs(c.close - c.open);
    const biggestBody = Math.abs(biggest.close - biggest.open);
    return body > biggestBody ? c : biggest;
  }, candidates[0]);
}

// ---------------------------------------------------------------
// 4.2) เงื่อนไขยืนยันแบบ "50% ของเนื้อแท่ง" (ตามแนวคิด: ปิดเหนือ/ใต้ 50% ของ body
//      แท่งหลัก + ต้องปิดข้าม wick ของแท่งก่อนหน้าด้วย ถึงจะถือว่ากลับตัวแข็งแรงจริง)
//      ฝั่ง Long (B): แท่งล่าสุดต้องปิดเขียว, ปิดเหนือ 50% ของ body แท่งหลัก (เขียว),
//                     และปิดเหนือ high ของแท่งก่อนหน้า (ปิดเหนือไส้)
//      ฝั่ง Short (S): กลับกัน ใช้แท่งหลัก (แดง), ปิดใต้ 50% ของ body, ปิดใต้ low ของแท่งก่อนหน้า
// ---------------------------------------------------------------
function detectFiftyPercentConfirmation(candles, biasDirection) {
  if (candles.length < 4) return null;
  const impulse = getImpulseCandle(candles, biasDirection);
  if (!impulse) return null;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const midLevel = (impulse.open + impulse.close) / 2;

  if (biasDirection === 'long') {
    const closedGreen = last.close > last.open;
    const aboveMid = last.close > midLevel;
    const aboveWick = last.close > prev.high;
    if (closedGreen && aboveMid && aboveWick) {
      return { impulseCandle: impulse, level: +midLevel.toFixed(2), confirmCandle: last };
    }
  } else {
    const closedRed = last.close < last.open;
    const belowMid = last.close < midLevel;
    const belowWick = last.close < prev.low;
    if (closedRed && belowMid && belowWick) {
      return { impulseCandle: impulse, level: +midLevel.toFixed(2), confirmCandle: last };
    }
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

  // 5.3.1 เงื่อนไขเพิ่มเติม: ต้องมีแท่งที่ปิดผ่าน 50% ของเนื้อแท่งหลัก (impulse candle) + ปิดข้าม wick
  //       ในอย่างน้อย 1 TF เล็ก ด้วย ถึงจะถือว่ากลับตัว "แข็งแรงจริง" ไม่ใช่แค่สัมผัสครั้งแรกแบบอ่อนๆ
  const fiftyPctChecks = ['15m', '5m', '1m']
    .map(tf => ({ tf, result: detectFiftyPercentConfirmation(candleSets[tf], biasDirection) }))
    .filter(c => c.result);

  if (fiftyPctChecks.length === 0) {
    return {
      hasSignal: false,
      reason: `ราคาใกล้แนว ${keyLevel.price.toFixed(2)} (bias: ${biasDirection}) มีแท่งยืนยันรูปแบบแล้ว แต่ยังไม่ปิดผ่าน 50% ของเนื้อแท่งหลัก (ยังกลับตัวไม่แข็งแรงพอ)`,
    };
  }

  // ใช้ผลจาก TF ที่ยืนยันได้ก่อน (เรียงจากใหญ่ไปเล็ก: 15m > 5m > 1m)
  const fiftyPctConfirmed = fiftyPctChecks[0];

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
    fiftyPercentConfirmation: {
      tf: fiftyPctConfirmed.tf,
      level: fiftyPctConfirmed.result.level,
      impulseCandle: {
        time: fiftyPctConfirmed.result.impulseCandle.time,
        open: fiftyPctConfirmed.result.impulseCandle.open,
        close: fiftyPctConfirmed.result.impulseCandle.close,
      },
    },
    // เก็บแท่งเทียนล่าสุดของ TF ที่ยืนยันได้ ไว้ใช้สร้างกราฟประกอบข้อความแจ้งเตือน
    chartTf: fiftyPctConfirmed.tf,
    chartCandles: candleSets[fiftyPctConfirmed.tf].slice(-30),
  };
}

// ---------------------------------------------------------------
// 6) จัดรูปแบบข้อความสำหรับส่งเข้า LINE
// ---------------------------------------------------------------
function formatSignalMessage(signal) {
  if (!signal.hasSignal) return null; // ไม่มีสัญญาณ ไม่ต้องส่งอะไร

  const dirText = signal.direction === 'long' ? '🟢 เข้า BUY (Long)' : '🔴 เข้า SELL (Short)';
  const fp = signal.fiftyPercentConfirmation;
  const fpSide = signal.direction === 'long' ? 'B (ปิดเหนือ 50% ของแท่งเขียวหลัก)' : 'S (ปิดใต้ 50% ของแท่งแดงหลัก)';

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
    `- ยืนยันรูปแบบแท่งเทียนจาก: ${signal.confirmations.join(', ')}`,
    `- ยืนยัน 50% Retracement ฝั่ง ${fpSide} ที่ TF ${fp.tf}`,
    `  ระดับ 50%: ${fp.level} | แท่งหลักอ้างอิง (${new Date(fp.impulseCandle.time * 1000).toLocaleString('th-TH')}): open ${fp.impulseCandle.open} → close ${fp.impulseCandle.close}`,
    ``,
    `⚠️ นี่คือสัญญาณจากการวิเคราะห์ทางเทคนิคอัตโนมัติเท่านั้น`,
    `ไม่ใช่คำแนะนำการลงทุน โปรดบริหารความเสี่ยงและตัดสินใจด้วยตัวเองทุกครั้ง`,
  ].join('\n');
}

// ---------------------------------------------------------------
// 7) สร้าง URL รูปกราฟแท่งเทียนประกอบสัญญาณ (ผ่าน QuickChart.io ไม่ต้องมี server เก็บรูปเอง)
//    คืนค่า null ถ้าสร้างไม่สำเร็จ (เช่น เน็ตล่ม) เพื่อให้ระบบยังส่งข้อความตัวหนังสือได้ตามปกติ
// ---------------------------------------------------------------
async function generateChartImageUrl(signal) {
  if (!signal.hasSignal || !signal.chartCandles) return null;

  try {
    const candles = signal.chartCandles;
    const dirColor = signal.direction === 'long' ? '#26a69a' : '#ef5350';

    const chartConfig = {
      type: 'candlestick',
      data: {
        datasets: [{
          label: `XAU/USD ${signal.chartTf}`,
          data: candles.map(c => ({
            x: new Date(c.time * 1000).toISOString(),
            o: c.open, h: c.high, l: c.low, c: c.close,
          })),
        }],
      },
      options: {
        plugins: {
          title: {
            display: true,
            text: `XAU/USD ${signal.chartTf} — Entry ${signal.entry} (${signal.direction.toUpperCase()})`,
          },
          annotation: {
            annotations: {
              keyLevel: {
                type: 'line', yMin: signal.keyLevel, yMax: signal.keyLevel,
                borderColor: '#ffb300', borderWidth: 1.5,
                label: { display: true, content: `แนว ${signal.keyLevel}`, position: 'start' },
              },
              fiftyPct: {
                type: 'line',
                yMin: signal.fiftyPercentConfirmation.level,
                yMax: signal.fiftyPercentConfirmation.level,
                borderColor: dirColor, borderWidth: 1.5, borderDash: [6, 4],
                label: { display: true, content: `50% = ${signal.fiftyPercentConfirmation.level}`, position: 'end' },
              },
            },
          },
        },
        scales: { x: { type: 'time' } },
      },
    };

    const res = await fetch('https://quickchart.io/chart/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chart: chartConfig, width: 700, height: 450, backgroundColor: '#111' }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data && data.success ? data.url : null;
  } catch (err) {
    console.error('สร้างรูปกราฟไม่สำเร็จ (ข้ามไป ส่งแค่ข้อความตัวหนังสือ):', err.message);
    return null;
  }
}

module.exports = { analyzeGoldSignal, formatSignalMessage, generateChartImageUrl };
