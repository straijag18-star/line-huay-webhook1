# ตัวอย่าง Webhook รับข้อมูลจาก LINE OA เข้าระบบใบเสนอราคาหวย

โค้ดชุดนี้เป็น **จุดเริ่มต้น (starter)** สำหรับให้ LINE Official Account ส่งข้อความที่ลูกค้า/พนักงานพิมพ์
(เช่น `จักร์ / 58 50*50 / 85 50*50`) เข้ามาให้ระบบแยกชื่อ-เลข-ยอดให้อัตโนมัติ โดยไม่ต้อง copy-paste เอง

## สิ่งที่โค้ดนี้ทำได้แล้ว
- ตรวจสอบว่า request มาจาก LINE จริง (verify signature) ป้องกันคนยิงข้อมูลปลอมเข้ามา
- แยกข้อความหลายบรรทัดในบับเบิลเดียว เป็นชื่อลูกค้า + รายการเลข/ยอด (logic เดียวกับช่อง "วางข้อมูลด่วน" ในหน้าเว็บ)
- คำนวณยอดรวมของแต่ละชุด แล้วเก็บลงไฟล์ฐานข้อมูล (`db.json`)
- ตอบกลับสรุปยอดให้ผู้ส่งทราบทันทีทาง LINE ว่า "บันทึกแล้ว ✓"
- มี endpoint `GET /records` ให้ระบบอื่นดึงข้อมูลที่บันทึกไว้ไปดูได้

## สิ่งที่ยังต้องทำเพิ่มก่อนใช้งานจริง (สำคัญ)
1. **ฐานข้อมูล**: ตอนนี้ใช้ไฟล์ `db.json` เพื่อความง่ายในการทดสอบเท่านั้น ใช้งานจริงควรเปลี่ยนเป็นฐานข้อมูลจริง
   (เช่น PostgreSQL, MySQL, SQLite, MongoDB) เพราะไฟล์ JSON จะมีปัญหาเมื่อมีการเขียนพร้อมกันหลายคำขอ
   และข้อมูลอาจหายได้ถ้าโฮสต์ไม่มี persistent disk
2. **เชื่อมกับหน้าเว็บระบบใบเสนอราคาหวย (HTML)**: ตอนนี้ webhook นี้เก็บข้อมูลแยกจากหน้าเว็บ artifact
   (ซึ่งใช้ `window.storage` ที่ผูกกับ Claude เท่านั้น ให้ระบบภายนอกเข้าถึงไม่ได้) ถ้าต้องการให้ข้อมูลจาก LINE
   ไปโผล่ในหน้าเว็บเดียวกัน จะต้อง:
   - ปรับหน้าเว็บให้ดึงข้อมูลจาก API ของ backend นี้ (เช่น `fetch('https://your-domain.com/records')`)
     แทนที่จะอ่านจาก `window.storage`
   - หรือทำสคริปต์ sync ข้อมูลจาก `db.json`/ฐานข้อมูลจริง เข้าไปที่ `window.storage` เป็นระยะ
3. **การระบุผู้ขาย**: ตอนนี้ตั้งค่า seller เป็น `"จาก LINE OA"` แบบ hardcode ไว้ก่อน ถ้าแต่ละผู้ขายมี LINE OA
   หรือ LINE group แยกกัน ให้ปรับ logic ให้ map จาก `event.source.userId` / group ID ไปเป็นชื่อผู้ขายจริง
4. **ความปลอดภัย**: อย่า commit ไฟล์ `.env` ที่มี secret จริงขึ้น git หรือแชร์ให้ใคร

## วิธีติดตั้ง (ทดสอบในเครื่องก่อน)
```bash
npm install
cp .env.example .env
# แก้ไข .env ใส่ค่า LINE_CHANNEL_SECRET และ LINE_CHANNEL_ACCESS_TOKEN ของคุณ
npm start
```

## ขั้นตอนตั้งค่าฝั่ง LINE Developers Console
1. เข้า https://developers.line.biz/console/ แล้วสร้าง/เข้า Provider และ Channel ประเภท "Messaging API"
2. ในหน้า Channel เลือกแท็บ **Messaging API**:
   - คัดลอก **Channel access token** (กดสร้างถ้ายังไม่มี) → ใส่ใน `.env`
   - คัดลอก **Channel secret** (อยู่แท็บ Basic settings) → ใส่ใน `.env`
3. **ปิด** "Auto-reply messages" และ "Greeting messages" ในเมนู LINE Official Account Manager
   (ไม่งั้นข้อความอัตโนมัติของ LINE จะไปปนกับข้อความตอบกลับจากระบบเรา)
4. **เปิด** "Use webhook" ให้เป็น ON ในหน้า Messaging API settings

## ขั้นตอน deploy ขึ้นโฮสต์จริง (ต้องมี URL แบบ HTTPS สาธารณะ)
เลือกผู้ให้บริการที่ถนัด เช่น Render, Railway, Fly.io หรือ VPS ของตัวเอง โดยทั่วไปจะทำประมาณนี้:
1. อัปโหลดโค้ดชุดนี้ขึ้น GitHub repository
2. เชื่อม repository เข้ากับผู้ให้บริการ hosting แล้วตั้งค่า:
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`
3. หลัง deploy สำเร็จ จะได้ URL เช่น `https://your-app.onrender.com`
4. กลับไปที่ LINE Developers Console → Messaging API settings → ช่อง **Webhook URL**
   ใส่ `https://your-app.onrender.com/webhook` แล้วกด **Verify** เพื่อทดสอบว่าเชื่อมต่อสำเร็จ

## ทดสอบ
เพิ่ม LINE OA เป็นเพื่อน แล้วพิมพ์ข้อความแบบนี้เข้าไป:
```
จักร์
58 50*50
85 50*50
```
ถ้าตั้งค่าถูกต้อง ระบบจะตอบกลับทันทีว่า `บันทึกแล้ว ✓ / จักร์: รวม 200 บาท`
และดูข้อมูลที่เก็บไว้ได้ที่ `https://your-app.onrender.com/records`
