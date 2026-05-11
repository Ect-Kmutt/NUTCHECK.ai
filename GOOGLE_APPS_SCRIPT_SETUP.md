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

```bash
curl -X POST "YOUR_WEB_APP_URL" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'EOF'
{
  "apiKey": "nutcheck-secret-2026",
  "action": "importSnapshot",
  "snapshot": REPLACE_WITH_JSON
}
EOF
```

ง่ายที่สุดคือเปิดไฟล์ `nutcheck-snapshot.json` แล้ววางค่า object ทั้งก้อนลงในฟิลด์ `snapshot`

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

สิ่งที่ยังไม่ได้สลับให้โดยอัตโนมัติ:

- [server.js](/Users/machd/Nutcheck/server.js) ยังใช้ SQLite โดยตรงอยู่

ถ้าต้องการก้าวต่อไป ฉันแนะนำ 2 ทาง:

1. ทำ `ปุ่ม sync SQLite -> Google Apps Script`
2. สลับ backend ของ [server.js](/Users/machd/Nutcheck/server.js) ให้ใช้ GAS เป็นตัวเก็บข้อมูลหลักแทน SQLite
