# 🧾 LINE Bot อ่านบิล + สรุปยอด

ระบบ LINE แชทบอท: ถ่ายรูปบิลส่งเข้าไป → บอทอ่านข้อมูลด้วย AI → คุณยืนยันหรือแก้ไข → บันทึกลง Google Sheets → พิมพ์ขอ "สรุปยอด" ตามช่วงวันที่ได้ทันที

**เทคโนโลยี:** Node.js + LINE Messaging API + Google Gemini Vision (อ่านบิล) + Google Sheets (เก็บข้อมูล) + Render (โฮสต์ฟรี)

---

## ภาพรวมการทำงาน

```
[ถ่ายรูปบิล] → ส่งใน LINE → บอทอ่านด้วย Gemini
        → แสดงข้อมูล + ปุ่ม [✅ ยืนยัน] [✏️ แก้ไข]
        → ยืนยัน = บันทึกลง Google Sheets
        → พิมพ์ "สรุป 1/6/2026 ถึง 15/6/2026" = ดูยอดรวม
```

---

## สิ่งที่ต้องเตรียม (ทั้งหมดมีแพ็กเกจฟรี)

ทำตาม 5 ขั้นตอนนี้ตามลำดับ จะได้ค่า (key/token) มาใส่ในตอน deploy

### ขั้นที่ 1 — สมัคร LINE Official Account + Messaging API

1. ไปที่ https://developers.line.biz/console/ แล้วล็อกอินด้วยบัญชี LINE ส่วนตัว
2. กด **Create a new provider** ตั้งชื่ออะไรก็ได้ (เช่น ชื่อคุณ)
3. ในโปรไวเดอร์นั้น กด **Create a Messaging API channel**
   - ถ้าระบบให้สร้าง LINE Official Account ก่อน ให้กดสร้าง (ฟรี) แล้วกลับมาเชื่อมกับ Messaging API
4. กรอกชื่อบอท, หมวดหมู่ ฯลฯ แล้วสร้าง
5. เข้าไปที่แท็บ **Messaging API** ของ channel:
   - เลื่อนหา **Channel access token (long-lived)** กด **Issue** → คัดลอกเก็บไว้
     → นี่คือ `LINE_CHANNEL_ACCESS_TOKEN`
6. ไปที่แท็บ **Basic settings** หา **Channel secret** → คัดลอกเก็บไว้
   → นี่คือ `LINE_CHANNEL_SECRET`
7. สำคัญ: ที่แท็บ Messaging API ให้ **ปิด** Auto-reply messages และ Greeting messages (ไม่งั้นบอทอัตโนมัติของ LINE จะตอบแทรก)
   - กดเข้า LINE Official Account Manager → Settings → Response settings → เปิด "Webhook", ปิด "Auto-response"

### ขั้นที่ 2 — ขอ Gemini API Key (AI อ่านบิล)

1. ไปที่ https://aistudio.google.com/app/apikey
2. กด **Create API key** → คัดลอกเก็บไว้
   → นี่คือ `GEMINI_API_KEY`

(มี free tier เพียงพอสำหรับการใช้งานส่วนตัว)

### ขั้นที่ 3 — สร้าง Google Sheet สำหรับเก็บข้อมูล

1. สร้าง Google Sheet ใหม่ที่ https://sheets.new ตั้งชื่ออะไรก็ได้
2. ดู URL จะเป็นแบบ `https://docs.google.com/spreadsheets/d/`**`ตรงนี้คือ SHEET_ID`**`/edit`
   → คัดลอกส่วน ID นั้นเก็บไว้ = `GOOGLE_SHEET_ID`
3. แท็บชีตด้านล่าง เปลี่ยนชื่อเป็น `Bills` (หรือจะใช้ชื่ออื่นก็ได้ แต่ต้องตั้งให้ตรงกับ `GOOGLE_SHEET_NAME`)
   - หัวตารางไม่ต้องพิมพ์เอง บอทจะสร้างให้อัตโนมัติครั้งแรก

### ขั้นที่ 4 — สร้าง Service Account ให้บอทเขียนชีตได้

1. ไปที่ https://console.cloud.google.com/ (ใช้บัญชี Google เดียวกัน)
2. สร้างโปรเจกต์ใหม่ (มุมบนซ้าย → New Project) หรือใช้โปรเจกต์เดิม
3. เปิดใช้งาน API: ค้นหา **Google Sheets API** → กด **Enable**
4. ไปที่ **APIs & Services → Credentials → Create Credentials → Service account**
   - ตั้งชื่อ เช่น `line-bot` แล้วกด Done
5. คลิกเข้า service account ที่สร้าง → แท็บ **Keys → Add key → Create new key → JSON**
   - ระบบจะดาวน์โหลดไฟล์ `.json` มา → **เปิดไฟล์นี้ คัดลอกเนื้อหาทั้งหมด** = `GOOGLE_SERVICE_ACCOUNT_JSON`
6. ในไฟล์ JSON จะมีบรรทัด `"client_email": "xxxx@xxxx.iam.gserviceaccount.com"` → **คัดลอกอีเมลนี้**
7. กลับไปที่ Google Sheet ของคุณ กด **Share** แล้ววางอีเมลนั้น ตั้งสิทธิ์เป็น **Editor**
   - ขั้นตอนนี้สำคัญมาก ไม่งั้นบอทจะเขียนชีตไม่ได้

### ขั้นที่ 5 — Deploy ขึ้น Render (ฟรี)

1. อัปโหลดโฟลเดอร์ `line-bill-bot` นี้ขึ้น GitHub (สร้าง repo ใหม่แล้ว push)
   - ถ้าไม่ถนัด Git บอกผมได้ ผมช่วยเขียนคำสั่งให้ทีละขั้น
2. ไปที่ https://render.com สมัคร/ล็อกอิน (เชื่อมกับ GitHub)
3. กด **New → Web Service** → เลือก repo ที่เพิ่ง push
4. ตั้งค่า:
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
5. เลื่อนลงไปที่ **Environment Variables** ใส่ค่าทั้งหมดที่เก็บไว้:

   | Key | ค่า |
   |---|---|
   | `LINE_CHANNEL_ACCESS_TOKEN` | จากขั้นที่ 1 |
   | `LINE_CHANNEL_SECRET` | จากขั้นที่ 1 |
   | `GEMINI_API_KEY` | จากขั้นที่ 2 |
   | `GOOGLE_SHEET_ID` | จากขั้นที่ 3 |
   | `GOOGLE_SHEET_NAME` | `Bills` |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | เนื้อหาไฟล์ JSON ทั้งก้อน (วางทั้งหมด) |
   | `TZ` | `Asia/Bangkok` |

6. กด **Create Web Service** รอ build เสร็จ จะได้ URL เช่น `https://line-bill-bot-xxxx.onrender.com`

### ขั้นสุดท้าย — เชื่อม Webhook กับ LINE

1. กลับไปที่ LINE Developers → channel → แท็บ **Messaging API**
2. ช่อง **Webhook URL** ใส่ `https://line-bill-bot-xxxx.onrender.com/webhook` (อย่าลืม `/webhook` ต่อท้าย)
3. กด **Verify** ต้องขึ้น Success
4. เปิดสวิตช์ **Use webhook** ให้เป็น ON
5. เพิ่มบอทเป็นเพื่อนใน LINE (สแกน QR ในแท็บ Messaging API) → เริ่มส่งบิลได้เลย!

---

## วิธีใช้งานในแชท

| สิ่งที่พิมพ์/ทำ | ผลลัพธ์ |
|---|---|
| ส่งรูปบิล | บอทอ่านข้อมูลให้ตรวจสอบ พร้อมปุ่มยืนยัน/แก้ไข |
| กด ✅ ยืนยัน | บันทึกลง Google Sheets |
| กด ✏️ แก้ไข แล้วพิมพ์ `ยอด=120` | แก้ค่าแล้วให้ตรวจใหม่ |
| `สรุปวันนี้` | ยอดรวมของวันนี้ |
| `สรุปเดือนนี้` | ยอดรวมเดือนปัจจุบัน |
| `สรุป 7 วัน` | ย้อนหลัง 7 วัน |
| `สรุป 1/6/2026 ถึง 15/6/2026` | ช่วงวันที่ที่ระบุ |
| `ช่วยเหลือ` หรือ `เมนู` | แสดงวิธีใช้ |

**รูปแบบแก้ไข** (พิมพ์หลายอย่างพร้อมกันได้ คั่นด้วยขึ้นบรรทัดใหม่หรือคอมม่า):
```
ร้าน=7-Eleven
ยอด=120
วันที่=2026-06-10
หมวด=อาหารและเครื่องดื่ม
ภาษี=7.85
```

---

## รันทดสอบบนเครื่องตัวเอง (ไม่บังคับ)

```bash
cd line-bill-bot
npm install
cp .env.example .env   # แล้วแก้ค่าในไฟล์ .env
npm start
```
จากนั้นใช้ ngrok เปิด tunnel มาที่ port 3000 เพื่อเอา URL ไปใส่ใน LINE webhook

---

## หมายเหตุ / ข้อจำกัด

- **Render free tier จะ "หลับ" เมื่อไม่มีคนใช้** บิลใบแรกหลังหลับอาจตอบช้า ~30 วินาที (กำลังปลุกเซิร์ฟเวอร์) — ถัดไปจะเร็วปกติ
- บิลที่ "รอยืนยัน" เก็บในหน่วยความจำชั่วคราว ถ้าเซิร์ฟเวอร์รีสตาร์ทระหว่างที่ยังไม่ยืนยัน ต้องส่งรูปใหม่ (บิลที่ยืนยันแล้วอยู่ใน Sheets ปลอดภัย)
- ความแม่นยำการอ่านบิลขึ้นกับคุณภาพรูป ถ่ายให้ชัด ตรง ไม่เงาสะท้อน จะอ่านแม่นขึ้น — และมีปุ่มแก้ไขไว้เสมอ
- หมวดหมู่ปรับเพิ่ม/ลดได้ในไฟล์ `lib/gemini.js` (ตัวแปร `CATEGORIES`)

---

## โครงสร้างไฟล์

```
line-bill-bot/
├── index.js          # เซิร์ฟเวอร์หลัก + webhook + flow ยืนยัน/แก้ไข/สรุป
├── lib/
│   ├── gemini.js     # อ่านบิลจากรูปด้วย Gemini Vision
│   ├── sheets.js     # บันทึก/อ่าน/สรุป Google Sheets
│   └── parser.js     # แปลงคำสั่งสรุป + ข้อความแก้ไข
├── package.json
├── render.yaml       # config สำหรับ deploy Render
├── .env.example      # ตัวอย่างค่า environment
└── README.md
```
