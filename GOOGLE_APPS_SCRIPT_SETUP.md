# NutCheck + Google Apps Script

ไฟล์ชุดนี้ช่วยย้ายฐานข้อมูล NutCheck จาก SQLite ไปเก็บบน Google Sheets ผ่าน Google Apps Script

## โครงข้อมูลที่รองรับ

- `students`
- `users`
- `grades`
- `logs`

## ไฟล์ที่เพิ่ม

- [google-apps-script/Code.gs](/Users/machd/Nutcheck/google-apps-script/Code.gs)
- [google-apps-script/appsscript.json](/Users/machd/Nutcheck/google-apps-script/appsscript.json)
- [scripts/export-gas-snapshot.js](/Users/machd/Nutcheck/scripts/export-gas-snapshot.js)

## ขั้นตอนใช้งาน

### 1. export ข้อมูลปัจจุบันจาก SQLite

```bash
cd "/Users/machd/Nutcheck"
node scripts/export-gas-snapshot.js
```

ไฟล์ snapshot จะถูกสร้างที่:

- [google-apps-script/nutcheck-snapshot.json](/Users/machd/Nutcheck/google-apps-script/nutcheck-snapshot.json)

### 2. สร้าง Google Spreadsheet

สร้างชีตใหม่ 1 ไฟล์ แล้วคัดลอก `Spreadsheet ID` จาก URL

ตัวอย่าง:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

### 3. เปิด Google Apps Script

1. ไปที่ [script.new](https://script.new)
2. วางโค้ดจาก [google-apps-script/Code.gs](/Users/machd/Nutcheck/google-apps-script/Code.gs)
3. วาง JSON จาก [google-apps-script/appsscript.json](/Users/machd/Nutcheck/google-apps-script/appsscript.json)

### 4. ตั้ง Script Properties

ใน Apps Script ไปที่:

`Project Settings` -> `Script Properties`

เพิ่ม 2 ค่า:

- `SPREADSHEET_ID` = ไอดีของ Google Sheet
- `NUTCHECK_API_KEY` = รหัสลับของคุณ เช่น `nutcheck-secret-2026`

### 5. Deploy เป็น Web App

1. กด `Deploy`
2. เลือก `New deployment`
3. เลือก `Web app`
4. `Execute as` = `Me`
5. `Who has access` = `Anyone`
6. Deploy

จะได้ URL ของ Web App

### 6. สร้างชีตเริ่มต้น

เปิด URL แบบ POST หรือใช้ Apps Script editor เรียกฟังก์ชัน `setup`

ตัวอย่างผ่าน `curl`:

```bash
curl -X POST "YOUR_WEB_APP_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "nutcheck-secret-2026",
    "action": "setup"
  }'
```

### 7. import ข้อมูล snapshot เข้า Google Sheets

ใช้สคริปต์ที่เตรียมไว้ให้ได้เลย:

```bash
cd "/Users/machd/Nutcheck"
GAS_WEB_APP_URL="YOUR_WEB_APP_URL" \
GAS_API_KEY="nutcheck-secret-2026" \
npm run import:gas
```

## 7.1 ทดสอบว่า GAS ตอบกลับได้จริง

```bash
cd "/Users/machd/Nutcheck"
GAS_WEB_APP_URL="YOUR_WEB_APP_URL" \
GAS_API_KEY="nutcheck-secret-2026" \
npm run test:gas
```

## endpoint actions ที่มีให้

- `health`
- `setup`
- `importSnapshot`
- `exportSnapshot`
- `listStudents`
- `getStudent`
- `upsertStudent`
- `deleteStudent`
- `listUsers`
- `upsertUser`
- `deleteUser`
- `getGrades`
- `saveGrades`
- `addLog`
- `listLogs`
- `dashboardSummary`
- `dashboardStudents`
- `history`

## สถานะตอนนี้

ตอนนี้ฉันทำให้ `ฝั่ง Google Apps Script พร้อมรับข้อมูล` แล้ว

สถานะตอนนี้:

- [server.js](/Users/machd/Nutcheck/server.js) รองรับทั้ง `SQLite` และ `Google Apps Script`
- ถ้าไม่ตั้ง env เพิ่ม ระบบจะยังใช้ `SQLite` ตามเดิม

## 8. สลับ NutCheck ให้ใช้ Google Apps Script จริง

เพิ่ม environment variables เหล่านี้ในเครื่องหรือบน Render:

- `DATA_PROVIDER=gas`
- `GAS_WEB_APP_URL=URL ของ Web App ที่ deploy แล้ว`
- `GAS_API_KEY=ค่าเดียวกับ NUTCHECK_API_KEY ใน Apps Script`

ตัวอย่างตอนรัน local:

```bash
DATA_PROVIDER=gas \
GAS_WEB_APP_URL="YOUR_WEB_APP_URL" \
GAS_API_KEY="nutcheck-secret-2026" \
node server.js
```

หรือคัดลอกจากไฟล์ [/.env.gas.example](/Users/machd/Nutcheck/.env.gas.example) แล้วแทนค่าจริงของคุณ

เมื่อเปิดโหมดนี้ `server.js` จะอ่านข้อมูลหลักจาก Google Sheets ผ่าน Apps Script สำหรับ:

- login / users
- students
- grades
- check-in logs
- dashboard summary
- history

ถ้าต้องการก้าวต่อไป ฉันแนะนำ 2 ทาง:

1. ทำ `ปุ่ม sync SQLite -> Google Apps Script`
2. สลับ backend ของ [server.js](/Users/machd/Nutcheck/server.js) ให้ใช้ GAS เป็นตัวเก็บข้อมูลหลักแทน SQLite
