const os = require("os");
const path = require("path");
const fs = require("fs");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TIME_ZONE = "Asia/Bangkok";
const JWT_SECRET = process.env.JWT_SECRET || "nutcheck_super_secret_key_12345";
const dataDir = process.env.DATA_DIR || __dirname;
const uploadsDir = path.join(dataDir, "uploads");
const DB_PATH = path.join(dataDir, "attendance.db");
const GAS_WEB_APP_URL = String(process.env.GAS_WEB_APP_URL || "").trim();
const GAS_API_KEY = String(process.env.GAS_API_KEY || "").trim();
const DATA_PROVIDER = String(process.env.DATA_PROVIDER || ((GAS_WEB_APP_URL && GAS_API_KEY) ? "gas" : "sqlite")).trim().toLowerCase();
const USE_GAS = DATA_PROVIDER === "gas";
const adminSessions = new Map();
const activeCheckinSessions = new Map();

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

console.log(`📁 Data directory: ${dataDir}`);
console.log(`💾 Database path: ${DB_PATH}`);

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  }
  console.log('✅ Database connected successfully');
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA journal_mode = WAL");
});

function getLocalDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatCheckInTime(date = new Date()) {
  return date.toLocaleString("th-TH", {
    timeZone: TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function getLanAddress() {
  const networkInterfaces = os.networkInterfaces();

  for (const addresses of Object.values(networkInterfaces)) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function sendDbError(res, message, err) {
  console.error(message, err);
  res.status(500).json({ message });
}

async function gasRequest(action, payload = {}) {
  if (!GAS_WEB_APP_URL || !GAS_API_KEY) {
    throw new Error("Google Apps Script ยังไม่ได้ตั้งค่า GAS_WEB_APP_URL หรือ GAS_API_KEY");
  }

  const response = await fetch(GAS_WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: GAS_API_KEY,
      action,
      ...payload
    })
  });

  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(json.message || `Google Apps Script action ${action} failed`);
  }

  return json.data;
}

async function gasListStudents(options = {}) {
  const payload = {};
  if (options.studentId) {
    payload.studentId = options.studentId;
  }
  return gasRequest("listStudents", payload);
}

async function gasListUsers() {
  return gasRequest("listUsers");
}

async function gasGetGrades(studentId) {
  return gasRequest("getGrades", { studentId });
}

async function gasSaveGrades(studentId, grades) {
  return gasRequest("saveGrades", { studentId, grades });
}

async function gasListLogs(options = {}) {
  return gasRequest("listLogs", options);
}

async function gasAddLog(log) {
  return gasRequest("addLog", { log });
}

function normalizeStudentPayload(payload = {}) {
  return {
    id: String(payload.id || "").trim(),
    name: String(payload.name || "").trim(),
    className: String(payload.class_name || payload.className || "").trim(),
    nfcUid: String(payload.nfc_uid || payload.nfcUid || "").trim(),
    photoUrl: String(payload.photo_url || payload.photoUrl || "").trim()
  };
}

function validateStudentPayload(student, { requireId = true } = {}) {
  if (requireId && !student.id) {
    return "กรุณาระบุรหัสนักเรียน";
  }

  if (!student.name) {
    return "กรุณาระบุชื่อนักเรียน";
  }

  return null;
}

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

async function migrateDatabase() {
  if (USE_GAS) {
    return;
  }

  await runQuery(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      student_name TEXT NOT NULL,
      check_in_at TEXT NOT NULL,
      check_in_date TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      student_id TEXT,
      FOREIGN KEY (student_id) REFERENCES students(id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      score INTEGER NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      UNIQUE(student_id, subject)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      target_audience TEXT DEFAULT 'all', -- 'all', 'students', 'teachers', or specific class
      target_class TEXT, -- specific class if target_audience is 'student'
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);

  await runQuery(`
    CREATE TABLE IF NOT EXISTS announcement_reads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      read_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (announcement_id) REFERENCES announcements(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(announcement_id, user_id)
    )
  `);

  const userCountRow = await getQuery("SELECT COUNT(*) AS count FROM users");
  if ((userCountRow?.count || 0) === 0) {
    const adminPasswordHash = await bcrypt.hash("1234", 10);
    await runQuery(
      `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
      ["admin", adminPasswordHash, "admin"]
    );
  }

  const studentColumns = [
    ["class_name", "TEXT DEFAULT ''"],
    ["nfc_uid", "TEXT"],
    ["photo_url", "TEXT DEFAULT ''"]
  ];

  for (const [columnName, definition] of studentColumns) {
    try {
      await runQuery(`ALTER TABLE students ADD COLUMN ${columnName} ${definition}`);
    } catch (err) {
      if (!String(err.message || "").includes("duplicate column name")) {
        throw err;
      }
    }
  }

  // Add indexes for faster queries
  const indexes = [
    "CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(check_in_date)",
    "CREATE INDEX IF NOT EXISTS idx_logs_id ON logs(id)",
    "CREATE INDEX IF NOT EXISTS idx_logs_date_id ON logs(check_in_date, id)",
    "CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_name)",
    "CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)"
  ];

  for (const indexSql of indexes) {
    try {
      await runQuery(indexSql);
    } catch (err) {
      // Index might already exist, that's fine
    }
  }

  const logColumns = [
    ["method", "TEXT DEFAULT 'manual'"]
  ];

  for (const [columnName, definition] of logColumns) {
    try {
      await runQuery(`ALTER TABLE logs ADD COLUMN ${columnName} ${definition}`);
    } catch (err) {
      if (!String(err.message || "").includes("duplicate column name")) {
        throw err;
      }
    }
  }

  const userColumns = [
    ["assigned_class", "TEXT"]
  ];

  for (const [columnName, definition] of userColumns) {
    try {
      await runQuery(`ALTER TABLE users ADD COLUMN ${columnName} ${definition}`);
    } catch (err) {
      if (!String(err.message || "").includes("duplicate column name")) {
        throw err;
      }
    }
  }

  await runQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_students_nfc_uid_unique
    ON students(nfc_uid)
    WHERE nfc_uid IS NOT NULL AND nfc_uid != ''
  `);

  await runQuery(`
    CREATE INDEX IF NOT EXISTS idx_students_name
    ON students(name)
  `);

  await runQuery(`
    CREATE INDEX IF NOT EXISTS idx_logs_check_in_date
    ON logs(check_in_date)
  `);

  await runQuery(`
    CREATE INDEX IF NOT EXISTS idx_logs_student_date
    ON logs(id, check_in_date)
  `);

  const studentCountRow = await getQuery("SELECT COUNT(*) AS count FROM students");
  if ((studentCountRow?.count || 0) === 0) {
    const sampleStudents = [
      ["65001", "Min", "", "", ""],
      ["65002", "Nina", "", "", ""],
      ["65003", "Boss", "", "", ""],
      ["65004", "Ploy", "", "", ""]
    ];

    for (const student of sampleStudents) {
      await runQuery(
        `
          INSERT INTO students (id, name, class_name, nfc_uid, photo_url)
          VALUES (?, ?, ?, ?, ?)
        `,
        student
      );
    }

    // Add sample grades for students
    const sampleGrades = [
      ["65001", "คณิตศาสตร์", 85],
      ["65001", "วิทยาศาสตร์", 78],
      ["65001", "ภาษาไทย", 90],
      ["65002", "คณิตศาสตร์", 92],
      ["65002", "วิทยาศาสตร์", 88],
      ["65002", "ภาษาไทย", 85],
      ["65003", "คณิตศาสตร์", 75],
      ["65003", "วิทยาศาสตร์", 80],
      ["65003", "ภาษาไทย", 88],
      ["65004", "คณิตศาสตร์", 88],
      ["65004", "วิทยาศาสตร์", 92],
      ["65004", "ภาษาไทย", 91]
    ];

    for (const [studentId, subject, score] of sampleGrades) {
      try {
        await runQuery(
          `INSERT INTO grades (student_id, subject, score) VALUES (?, ?, ?)`,
          [studentId, subject, score]
        );
      } catch (err) {
        // Ignore duplicates
      }
    }
  }

  // Add default teacher if no non-admin users exist
  const teacherCountRow = await getQuery("SELECT COUNT(*) AS count FROM users WHERE role = 'teacher'");
  if ((teacherCountRow?.count || 0) === 0) {
    const teacherPasswordHash = await bcrypt.hash("teacher123", 10);
    await runQuery(
      `INSERT INTO users (username, password, role, assigned_class) VALUES (?, ?, ?, ?)`,
      ["teacher1", teacherPasswordHash, "teacher", ""]
    );
    console.log('✅ Default teacher created: username=teacher1, password=teacher123');
  }

  // Add default student if no student users exist
  const studentUserCountRow = await getQuery("SELECT COUNT(*) AS count FROM users WHERE role = 'student'");
  if ((studentUserCountRow?.count || 0) === 0) {
    const studentPasswordHash = await bcrypt.hash("student123", 10);
    await runQuery(
      `INSERT INTO users (username, password, role, student_id) VALUES (?, ?, ?, ?)`,
      ["student1", studentPasswordHash, "student", "65001"]
    );
    console.log('✅ Default student created: username=student1, password=student123');
  }
}

async function getStudentById(id) {
  if (USE_GAS) {
    const student = await gasRequest("getStudent", { id });
    return student || null;
  }

  return getQuery(
    `
      SELECT id, name, class_name, nfc_uid, photo_url
      FROM students
      WHERE id = ?
    `,
    [id]
  );
}

async function saveAttendance(student, method = "manual") {
  const now = new Date();
  const checkInAt = formatCheckInTime(now);
  const checkInDate = getLocalDateKey(now);

  if (USE_GAS) {
    const existingLogs = await gasListLogs({
      date: checkInDate,
      studentId: student.id,
      limit: 1
    });

    if (existingLogs.length) {
      return {
        alreadyCheckedIn: true,
        message: `🟤 ${student.name} เช็คชื่อแล้ววันนี้ (${existingLogs[0].check_in_at})`,
        student
      };
    }

    await gasAddLog({
      id: student.id,
      student_name: student.name,
      check_in_at: checkInAt,
      check_in_date: checkInDate,
      status: "เข้าเรียน",
      method
    });

    return {
      alreadyCheckedIn: false,
      message: `✅ ${student.name} มาแล้ว (${checkInAt})`,
      student
    };
  }

  const existingLog = await getQuery(
    `
      SELECT log_id, check_in_at
      FROM logs
      WHERE id = ? AND check_in_date = ?
      ORDER BY log_id DESC
      LIMIT 1
    `,
    [student.id, checkInDate]
  );

  if (existingLog) {
    return {
      alreadyCheckedIn: true,
      message: `🟤 ${student.name} เช็คชื่อแล้ววันนี้ (${existingLog.check_in_at})`,
      student
    };
  }

  await runQuery(
    `
      INSERT INTO logs (
        id,
        student_name,
        check_in_at,
        check_in_date,
        status,
        method
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [student.id, student.name, checkInAt, checkInDate, "เข้าเรียน", method]
  );

  return {
    alreadyCheckedIn: false,
    message: `✅ ${student.name} มาแล้ว (${checkInAt})`,
    student
  };
}

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: "กรุณาเข้าสู่ระบบก่อนใช้งาน" });

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ message: "Token ไม่ถูกต้องหรือหมดอายุ" });

    try {
      if (user?.role === "student" && !user.studentId) {
        const linkedUser = USE_GAS
          ? (await gasListUsers()).find(item => String(item.id) === String(user.id) || String(item.username) === String(user.username))
          : await getQuery(
              `SELECT student_id FROM users WHERE id = ? OR username = ? LIMIT 1`,
              [user.id, user.username]
            );
        user.studentId = linkedUser?.student_id || null;
      }

      req.user = user;
      next();
    } catch (lookupError) {
      sendDbError(res, "ตรวจสอบสิทธิ์ผู้ใช้งานไม่สำเร็จ", lookupError);
    }
  });
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงส่วนนี้" });
    }
    next();
  };
}

function requireStudentSelfOrRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "กรุณาเข้าสู่ระบบก่อนใช้งาน" });
    }

    if (roles.includes(req.user.role)) {
      return next();
    }

    if (req.user.role === "student" && req.user.studentId === req.params.id) {
      return next();
    }

    return res.status(403).json({ message: "คุณไม่มีสิทธิ์เข้าถึงข้อมูลของนักเรียนคนนี้" });
  };
}

function ensureLinkedStudent(req, res) {
  // Admin และ Teacher ไม่ต้องมี studentId
  if (req.user?.role === "admin" || req.user?.role === "teacher") {
    return true;
  }

  // เฉพาะนักเรียนเท่านั้นที่ต้องมี studentId
  if (req.user?.role === "student" && !req.user.studentId) {
    res.status(403).json({ message: "บัญชีนักเรียนนี้ยังไม่ถูกผูกกับรหัสนักเรียน" });
    return false;
  }

  return true;
}

function buildLocalAiInsight(grades) {
  const entries = Object.entries(grades)
    .map(([subject, score]) => ({ subject, score: Number(score) || 0 }))
    .sort((a, b) => b.score - a.score);

  const topSubjects = entries.slice(0, 2);
  const average = entries.reduce((sum, item) => sum + item.score, 0) / Math.max(entries.length, 1);
  const strengths = topSubjects.map(item => item.subject);

  let careers = ["ผู้ประสานงานโครงการ", "เจ้าหน้าที่ธุรการ", "นักพัฒนาทักษะทั่วไป"];
  let explanation = "ผลคะแนนของคุณค่อนข้างสมดุลหลายด้าน เหมาะกับการต่อยอดผ่านการฝึกทักษะและการลองทำกิจกรรมหลายรูปแบบเพื่อค้นหาความถนัดที่ชัดขึ้น";

  if (strengths.includes("คณิตศาสตร์") && strengths.includes("วิทยาศาสตร์")) {
    careers = ["วิศวกร", "นักวิเคราะห์ข้อมูล", "นักพัฒนาซอฟต์แวร์"];
    explanation = "คุณเด่นด้านการคิดเป็นระบบและการแก้ปัญหาเชิงเหตุผล จึงเหมาะกับงานที่ใช้การวิเคราะห์ ตัวเลข และการออกแบบวิธีแก้ปัญหาที่ชัดเจน";
  } else if (strengths.includes("ภาษาต่างประเทศ") && strengths.includes("ศิลปะ/ความคิดสร้างสรรค์")) {
    careers = ["นักการตลาดคอนเทนต์", "นักออกแบบสื่อ", "ล่ามหรือผู้ประสานงานต่างประเทศ"];
    explanation = "คุณมีจุดแข็งด้านการสื่อสารและความคิดสร้างสรรค์ เหมาะกับงานที่ต้องใช้ภาษา การเล่าเรื่อง และการนำเสนอไอเดียให้น่าสนใจ";
  } else if (strengths.includes("คณิตศาสตร์")) {
    careers = ["นักบัญชี", "นักวิเคราะห์ธุรกิจ", "ผู้ช่วยวิศวกร"];
    explanation = "คุณทำได้ดีในด้านตัวเลขและความแม่นยำ จึงเหมาะกับงานที่ต้องใช้การคำนวณ วางแผน และตรวจสอบข้อมูลอย่างเป็นระบบ";
  } else if (strengths.includes("วิทยาศาสตร์")) {
    careers = ["ผู้ช่วยห้องแล็บ", "สายสุขภาพเบื้องต้น", "นักวิจัยรุ่นเริ่มต้น"];
    explanation = "คุณเด่นด้านการสังเกต ทดลอง และเข้าใจหลักการเชิงวิทยาศาสตร์ เหมาะกับสายงานที่ต้องใช้การค้นคว้าและความละเอียดรอบคอบ";
  } else if (strengths.includes("ภาษาต่างประเทศ")) {
    careers = ["พนักงานต้อนรับ", "เจ้าหน้าที่ประสานงาน", "ครูสอนภาษา"];
    explanation = "คุณมีพื้นฐานการสื่อสารที่ดี เหมาะกับงานที่ต้องพบปะผู้คน ใช้ภาษา และสร้างความเข้าใจระหว่างคนหลายกลุ่ม";
  } else if (strengths.includes("ศิลปะ/ความคิดสร้างสรรค์")) {
    careers = ["นักออกแบบกราฟิก", "ครีเอทีฟ", "ผู้ผลิตคอนเทนต์"];
    explanation = "คุณมีแนวโน้มเด่นด้านจินตนาการและการสร้างสรรค์ เหมาะกับงานที่ต้องคิดไอเดียใหม่และถ่ายทอดออกมาให้คนอื่นเห็นภาพ";
  } else if (strengths.includes("กีฬา/ร่างกาย")) {
    careers = ["ผู้ฝึกสอนกีฬา", "ผู้ช่วยกิจกรรม", "งานสายบริการที่ต้องเคลื่อนไหว"];
    explanation = "คุณมีความพร้อมด้านร่างกายและการลงมือทำ เหมาะกับงานที่ต้องใช้พลัง ความกระตือรือร้น และการทำงานร่วมกับผู้อื่น";
  }

  if (average < 50) {
    explanation += " ช่วงนี้คะแนนรวมยังต่ำอยู่เล็กน้อย แนะนำให้ค่อย ๆ อัปเกรดพื้นฐานวิชาหลักก่อน แล้วค่อยต่อยอดไปยังสายที่สนใจมากที่สุด";
  } else if (average >= 80) {
    explanation += " ภาพรวมคะแนนค่อนข้างแข็งแรงมาก จึงมีโอกาสต่อยอดสู่สายเรียนหรืออาชีพเฉพาะทางได้ดี";
  }

  return {
    suggestion: careers.join(", "),
    description: explanation
  };
}

// Auth Endpoints
app.post("/api/auth/register", async (req, res) => {
  const { username, password, role, studentId, assignedClass } = req.body;
  if (!username || !password || !role) return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบถ้วน" });
  if (!["admin", "teacher", "student"].includes(role)) return res.status(400).json({ message: "Role ไม่ถูกต้อง" });

  try {
    if (USE_GAS) {
      const users = await gasListUsers();
      if (users.some(user => String(user.username) === String(username))) {
        return res.status(409).json({ message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      await gasRequest("upsertUser", {
        user: {
          username,
          password: hashedPassword,
          role,
          student_id: studentId || "",
          assigned_class: assignedClass || ""
        }
      });

      return res.status(201).json({ message: "สมัครสมาชิกสำเร็จ" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await runQuery(
      `INSERT INTO users (username, password, role, student_id, assigned_class) VALUES (?, ?, ?, ?, ?)`,
      [username, hashedPassword, role, studentId || null, assignedClass || null]
    );
    res.status(201).json({ message: "สมัครสมาชิกสำเร็จ" });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) return res.status(409).json({ message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" });
    sendDbError(res, "สมัครสมาชิกไม่สำเร็จ", err);
  }
});

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$/.test(value);
}

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: "กรุณากรอก Username และ Password" });

  try {
    const user = USE_GAS
      ? (await gasListUsers()).find(item => String(item.username) === String(username))
      : await getQuery(`SELECT * FROM users WHERE username = ?`, [username]);
    if (!user || !user.password) return res.status(401).json({ message: "Username หรือ Password ไม่ถูกต้อง" });

    const isValid = isBcryptHash(user.password)
      ? await bcrypt.compare(password, user.password)
      : password === user.password;

    if (!isValid) return res.status(401).json({ message: "Username หรือ Password ไม่ถูกต้อง" });

    if (USE_GAS && !isBcryptHash(user.password)) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await gasRequest("upsertUser", {
        user: {
          id: user.id,
          username: user.username,
          password: hashedPassword,
          role: user.role,
          student_id: user.student_id || "",
          assigned_class: user.assigned_class || ""
        }
      });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, studentId: user.student_id, assignedClass: user.assigned_class },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({
      message: "เข้าสู่ระบบสำเร็จ",
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        studentId: user.student_id,
        assignedClass: user.assigned_class
      }
    });
  } catch (err) {
    sendDbError(res, "ล็อกอินไม่สำเร็จ", err);
  }
});

app.get("/api/auth/me", authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// User Management Endpoints (Admin only)
app.get("/api/users", authenticateToken, requireRole(["admin"]), async (req, res) => {
  try {
    const rows = USE_GAS
      ? await gasListUsers()
      : await allQuery(`SELECT id, username, role, student_id, assigned_class, email FROM users ORDER BY id`);
    res.json(rows.map(({ password, ...user }) => user));
  } catch (err) {
    sendDbError(res, "โหลดผู้ใช้งานไม่สำเร็จ", err);
  }
});

app.post("/api/users", authenticateToken, requireRole(["admin"]), async (req, res) => {
  const { username, password, role, studentId, assignedClass, email } = req.body;
  if (!username || !password || !role) return res.status(400).json({ message: "กรุณากรอกข้อมูลให้ครบถ้วน" });
  try {
    if (USE_GAS) {
      const users = await gasListUsers();
      if (users.some(user => String(user.username) === String(username))) {
        return res.status(409).json({ message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      await gasRequest("upsertUser", {
        user: {
          username,
          password: hashedPassword,
          role,
          student_id: studentId || "",
          assigned_class: assignedClass || "",
          email: email || ""
        }
      });
      return res.status(201).json({ message: "สร้างผู้ใช้สำเร็จ" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await runQuery(
      `INSERT INTO users (username, password, role, student_id, assigned_class, email) VALUES (?, ?, ?, ?, ?, ?)`,
      [username, hashedPassword, role, studentId || null, assignedClass || null, email || null]
    );
    res.status(201).json({ message: "สร้างผู้ใช้สำเร็จ" });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) return res.status(409).json({ message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" });
    if (String(err.message || "").includes("FOREIGN KEY")) return res.status(400).json({ message: "ไม่พบรหัสนักเรียนนี้ในระบบ" });
    sendDbError(res, "สร้างผู้ใช้ไม่สำเร็จ", err);
  }
});

app.put("/api/users/:id", authenticateToken, requireRole(["admin"]), async (req, res) => {
  const { username, password, role, studentId, assignedClass, email } = req.body;
  try {
    if (USE_GAS) {
      const users = await gasListUsers();
      const currentUser = users.find(user => String(user.id) === String(req.params.id));

      if (!currentUser) {
        return res.status(404).json({ message: "ไม่พบผู้ใช้งาน" });
      }

      if (users.some(user => String(user.username) === String(username) && String(user.id) !== String(req.params.id))) {
        return res.status(409).json({ message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" });
      }

      const nextPassword = password ? await bcrypt.hash(password, 10) : currentUser.password;
      await gasRequest("upsertUser", {
        user: {
          id: currentUser.id,
          username,
          password: nextPassword,
          role,
          student_id: studentId || "",
          assigned_class: assignedClass || "",
          email: email || currentUser.email || ""
        }
      });
      return res.json({ message: "อัปเดตผู้ใช้สำเร็จ" });
    }

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await runQuery(`UPDATE users SET username=?, password=?, role=?, student_id=?, assigned_class=?, email=? WHERE id=?`, [username, hashedPassword, role, studentId || null, assignedClass || null, email || null, req.params.id]);
    } else {
      await runQuery(`UPDATE users SET username=?, role=?, student_id=?, assigned_class=?, email=? WHERE id=?`, [username, role, studentId || null, assignedClass || null, email || null, req.params.id]);
    }
    res.json({ message: "อัปเดตผู้ใช้สำเร็จ" });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) return res.status(409).json({ message: "ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว" });
    if (String(err.message || "").includes("FOREIGN KEY")) return res.status(400).json({ message: "ไม่พบรหัสนักเรียนนี้ในระบบ" });
    sendDbError(res, "อัปเดตผู้ใช้ไม่สำเร็จ", err);
  }
});

app.delete("/api/users/:id", authenticateToken, requireRole(["admin"]), async (req, res) => {
  try {
    if (USE_GAS) {
      await gasRequest("deleteUser", { id: req.params.id });
      return res.json({ message: "ลบผู้ใช้สำเร็จ" });
    }

    await runQuery(`DELETE FROM users WHERE id=?`, [req.params.id]);
    res.json({ message: "ลบผู้ใช้สำเร็จ" });
  } catch (err) {
    sendDbError(res, "ลบผู้ใช้ไม่สำเร็จ", err);
  }
});

app.put("/api/users/:id/email", authenticateToken, requireRole(["admin"]), async (req, res) => {
  const { email } = req.body;
  if (email === undefined || email === null) {
    return res.status(400).json({ message: "กรุณากรอกอีเมล" });
  }
  try {
    if (USE_GAS) {
      await gasRequest("updateUserEmail", { userId: req.params.id, email });
      return res.json({ message: "อัปเดตอีเมลสำเร็จ" });
    }

    const result = await runQuery(`UPDATE users SET email=? WHERE id=?`, [email || null, req.params.id]);
    if (result.changes === 0) {
      return res.status(404).json({ message: "ไม่พบผู้ใช้งาน" });
    }
    res.json({ message: "อัปเดตอีเมลสำเร็จ" });
  } catch (err) {
    sendDbError(res, "อัปเดตอีเมลไม่สำเร็จ", err);
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    host: HOST,
    port: PORT,
    dbPath: DB_PATH,
    dataProvider: DATA_PROVIDER
  });
});

app.get("/api/database/status", async (req, res) => {
  try {
    if (USE_GAS) {
      const [students, logs, health] = await Promise.all([
        gasListStudents(),
        gasListLogs({ limit: 1 }),
        gasRequest("health")
      ]);

      return res.json({
        ok: true,
        database: {
          type: "google-apps-script",
          url: GAS_WEB_APP_URL
        },
        totals: {
          students: students.length,
          logs: Number((await gasListLogs()).length)
        },
        latestLog: logs[0] || null,
        gas: health
      });
    }

    const [studentCount, logCount, latestLog] = await Promise.all([
      getQuery("SELECT COUNT(*) AS total FROM students"),
      getQuery("SELECT COUNT(*) AS total FROM logs"),
      getQuery(
        `
          SELECT log_id, id, student_name, check_in_at, check_in_date, status, method
          FROM logs
          ORDER BY log_id DESC
          LIMIT 1
        `
      )
    ]);

    res.json({
      ok: true,
      database: {
        path: DB_PATH,
        type: "sqlite"
      },
      totals: {
        students: studentCount?.total || 0,
        logs: logCount?.total || 0
      },
      latestLog: latestLog || null
    });
  } catch (err) {
    sendDbError(res, "โหลดสถานะฐานข้อมูลไม่สำเร็จ", err);
  }
});

app.get("/api/students", authenticateToken, async (req, res) => {
  if (!ensureLinkedStudent(req, res)) {
    return;
  }

  try {
    if (USE_GAS) {
      let rows = await gasListStudents();

      if (req.user.role === "student" && req.user.studentId) {
        rows = rows.filter(row => String(row.id) === String(req.user.studentId));
      } else if (req.user.role === "teacher" && req.user.assignedClass) {
        rows = rows.filter(row => String(row.class_name) === String(req.user.assignedClass));
      }

      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return res.json(rows);
    }

    let query = `
        SELECT id, name, class_name, nfc_uid, photo_url
        FROM students
        WHERE 1 = 1
      `;
    const params = [];

    if (req.user.role === "student" && req.user.studentId) {
      query += " AND id = ?";
      params.push(req.user.studentId);
    } else if (req.user.role === "teacher" && req.user.assignedClass) {
      query += " AND class_name = ?";
      params.push(req.user.assignedClass);
    }

    query += " ORDER BY id ASC";

    const rows = await allQuery(query, params);

    res.json(rows);
  } catch (err) {
    sendDbError(res, "โหลดรายชื่อนักเรียนไม่สำเร็จ", err);
  }
});

app.get("/api/students/:id", authenticateToken, requireStudentSelfOrRole(["admin", "teacher"]), async (req, res) => {
  try {
    const student = await getStudentById(req.params.id);

    if (!student) {
      res.status(404).json({ message: "ไม่พบข้อมูลนักเรียน" });
      return;
    }

    res.json(student);
  } catch (err) {
    sendDbError(res, "โหลดข้อมูลนักเรียนไม่สำเร็จ", err);
  }
});

app.post("/api/students", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const student = normalizeStudentPayload(req.body);
  const validationMessage = validateStudentPayload(student);

  if (validationMessage) {
    res.status(400).json({ message: validationMessage });
    return;
  }

  try {
    if (USE_GAS) {
      const students = await gasListStudents();
      if (students.some(item => String(item.id) === String(student.id))) {
        return res.status(409).json({ message: "รหัสนักเรียนซ้ำในระบบ" });
      }
      if (student.nfcUid && students.some(item => String(item.nfc_uid || "") === String(student.nfcUid))) {
        return res.status(409).json({ message: "UID ซ้ำในระบบ" });
      }

      await gasRequest("upsertStudent", {
        student: {
          id: student.id,
          name: student.name,
          class_name: student.className,
          nfc_uid: student.nfcUid,
          photo_url: student.photoUrl
        }
      });

      return res.status(201).json({
        message: "เพิ่มนักเรียนสำเร็จ",
        student: await getStudentById(student.id)
      });
    }

    await runQuery(
      `
        INSERT INTO students (id, name, class_name, nfc_uid, photo_url)
        VALUES (?, ?, ?, ?, ?)
      `,
      [
        student.id,
        student.name,
        student.className,
        student.nfcUid || null,
        student.photoUrl
      ]
    );

    res.status(201).json({
      message: "เพิ่มนักเรียนสำเร็จ",
      student: await getStudentById(student.id)
    });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      res.status(409).json({ message: "รหัสนักเรียนหรือ UID ซ้ำในระบบ" });
      return;
    }

    sendDbError(res, "เพิ่มนักเรียนไม่สำเร็จ", err);
  }
});

app.put("/api/students/:id", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const student = normalizeStudentPayload(req.body);
  const validationMessage = validateStudentPayload(student, { requireId: false });

  if (validationMessage) {
    res.status(400).json({ message: validationMessage });
    return;
  }

  try {
    if (USE_GAS) {
      const students = await gasListStudents();
      const currentStudent = students.find(item => String(item.id) === String(req.params.id));
      if (!currentStudent) {
        return res.status(404).json({ message: "ไม่พบข้อมูลนักเรียน" });
      }
      if (student.nfcUid && students.some(item => String(item.id) !== String(req.params.id) && String(item.nfc_uid || "") === String(student.nfcUid))) {
        return res.status(409).json({ message: "UID ซ้ำในระบบ" });
      }

      await gasRequest("upsertStudent", {
        student: {
          id: currentStudent.id,
          name: student.name,
          class_name: student.className,
          nfc_uid: student.nfcUid,
          photo_url: student.photoUrl
        }
      });

      return res.json({
        message: "อัปเดตข้อมูลนักเรียนสำเร็จ",
        student: await getStudentById(req.params.id)
      });
    }

    const result = await runQuery(
      `
        UPDATE students
        SET name = ?, class_name = ?, nfc_uid = ?, photo_url = ?
        WHERE id = ?
      `,
      [
        student.name,
        student.className,
        student.nfcUid || null,
        student.photoUrl,
        req.params.id
      ]
    );

    if (result.changes === 0) {
      res.status(404).json({ message: "ไม่พบข้อมูลนักเรียน" });
      return;
    }

    res.json({
      message: "อัปเดตข้อมูลนักเรียนสำเร็จ",
      student: await getStudentById(req.params.id)
    });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      res.status(409).json({ message: "UID ซ้ำในระบบ" });
      return;
    }

    sendDbError(res, "อัปเดตข้อมูลนักเรียนไม่สำเร็จ", err);
  }
});

app.delete("/api/students/:id", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  try {
    if (USE_GAS) {
      await gasRequest("deleteStudent", { id: req.params.id });
      return res.json({ message: "ลบนักเรียนสำเร็จ" });
    }

    const result = await runQuery("DELETE FROM students WHERE id = ?", [req.params.id]);

    if (result.changes === 0) {
      res.status(404).json({ message: "ไม่พบข้อมูลนักเรียน" });
      return;
    }

    res.json({ message: "ลบนักเรียนสำเร็จ" });
  } catch (err) {
    sendDbError(res, "ลบนักเรียนไม่สำเร็จ", err);
  }
});

// Grades and Psychometric Behavior Endpoints
app.get("/api/students/:id/grades", authenticateToken, requireStudentSelfOrRole(["admin", "teacher"]), async (req, res) => {
  try {
    const rows = USE_GAS
      ? await gasGetGrades(req.params.id)
      : await allQuery(`SELECT subject, score FROM grades WHERE student_id = ?`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    sendDbError(res, "โหลดเกรดไม่สำเร็จ", err);
  }
});

app.post("/api/students/:id/grades", authenticateToken, requireStudentSelfOrRole(["admin", "teacher"]), async (req, res) => {
  const { grades } = req.body;
  const studentId = req.params.id;

  if (!grades || typeof grades !== "object") {
    res.status(400).json({ message: "กรุณากรอกคะแนนให้ครบถ้วน" });
    return;
  }

  try {
    if (USE_GAS) {
      for (const [subject, score] of Object.entries(grades)) {
        const numericScore = Number(score);
        if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100) {
          return res.status(400).json({ message: `คะแนนวิชา ${subject} ต้องอยู่ระหว่าง 0 ถึง 100` });
        }
      }
      await gasSaveGrades(studentId, grades);
      return res.json({ message: "บันทึกคะแนนสำเร็จ" });
    }

    await runQuery(`DELETE FROM grades WHERE student_id = ?`, [studentId]);
    for (const [subject, score] of Object.entries(grades)) {
      const numericScore = Number(score);

      if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100) {
        res.status(400).json({ message: `คะแนนวิชา ${subject} ต้องอยู่ระหว่าง 0 ถึง 100` });
        return;
      }

      await runQuery(
        `INSERT INTO grades (student_id, subject, score) VALUES (?, ?, ?)`,
        [studentId, subject, numericScore]
      );
    }
    res.json({ message: "บันทึกคะแนนสำเร็จ" });
  } catch (err) {
    sendDbError(res, "บันทึกคะแนนไม่สำเร็จ", err);
  }
});

// Psychometric Behavior Scoring Endpoints
app.get("/api/students/:id/behaviors", authenticateToken, requireStudentSelfOrRole(["admin", "teacher"]), async (req, res) => {
  try {
    const rows = USE_GAS
      ? await gasRequest("getBehaviors", { studentId: req.params.id })
      : await allQuery(`SELECT id, date, subject, score, notes FROM behaviors WHERE student_id = ? ORDER BY date DESC`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    sendDbError(res, "โหลดคะแนนจิตพิสัยไม่สำเร็จ", err);
  }
});

app.post("/api/students/:id/behaviors", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const { date, subject, score, notes } = req.body;
  const studentId = req.params.id;

  if (!date || !subject || score === undefined) {
    return res.status(400).json({ message: "กรุณากรอกวันที่ วิชา และคะแนนให้ครบถ้วน" });
  }

  const numericScore = Number(score);
  if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100) {
    return res.status(400).json({ message: "คะแนนจิตพิสัยต้องอยู่ระหว่าง 0 ถึง 100" });
  }

  try {
    if (USE_GAS) {
      await gasRequest("saveBehaviors", {
        studentId,
        behaviors: [{ date, subject, score: numericScore, notes: notes || "" }]
      });
      return res.status(201).json({ message: "บันทึกคะแนนจิตพิสัยสำเร็จ" });
    }

    await runQuery(
      `INSERT OR REPLACE INTO behaviors (student_id, date, subject, score, notes) VALUES (?, ?, ?, ?, ?)`,
      [studentId, date, subject, numericScore, notes || null]
    );
    res.status(201).json({ message: "บันทึกคะแนนจิตพิสัยสำเร็จ" });
  } catch (err) {
    sendDbError(res, "บันทึกคะแนนจิตพิสัยไม่สำเร็จ", err);
  }
});

app.put("/api/students/:id/behaviors/:behaviorId", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const { score, notes } = req.body;
  const studentId = req.params.id;
  const behaviorId = req.params.behaviorId;

  if (score === undefined) {
    return res.status(400).json({ message: "กรุณากรอกคะแนนจิตพิสัย" });
  }

  const numericScore = Number(score);
  if (!Number.isFinite(numericScore) || numericScore < 0 || numericScore > 100) {
    return res.status(400).json({ message: "คะแนนจิตพิสัยต้องอยู่ระหว่าง 0 ถึง 100" });
  }

  try {
    if (USE_GAS) {
      return res.status(501).json({ message: "ยังไม่สนับสนุนการแก้ไขในโหมด Google Apps Script" });
    }

    const result = await runQuery(
      `UPDATE behaviors SET score = ?, notes = ? WHERE id = ? AND student_id = ?`,
      [numericScore, notes || null, behaviorId, studentId]
    );

    if (result.changes === 0) {
      return res.status(404).json({ message: "ไม่พบบันทึกคะแนนจิตพิสัยนี้" });
    }

    res.json({ message: "อัปเดตคะแนนจิตพิสัยสำเร็จ" });
  } catch (err) {
    sendDbError(res, "อัปเดตคะแนนจิตพิสัยไม่สำเร็จ", err);
  }
});

app.get("/api/students/:id/analysis", authenticateToken, requireStudentSelfOrRole(["admin", "teacher"]), async (req, res) => {
  try {
    const student = await getStudentById(req.params.id);
    if (!student) return res.status(404).json({ message: "ไม่พบข้อมูลนักเรียน" });

    const rows = USE_GAS
      ? await gasGetGrades(req.params.id)
      : await allQuery(`SELECT subject, score FROM grades WHERE student_id = ?`, [req.params.id]);
    let grades = {};
    rows.forEach(r => grades[r.subject] = r.score);

    const subjects = ["คณิตศาสตร์", "วิทยาศาสตร์", "ภาษาต่างประเทศ", "ศิลปะ/ความคิดสร้างสรรค์", "กีฬา/ร่างกาย"];
    let isMocked = false;
    if (Object.keys(grades).length === 0) {
      subjects.forEach(s => {
        grades[s] = Math.floor(Math.random() * 41) + 60; // 60-100 random
      });
      isMocked = true;
    } else {
      subjects.forEach(s => {
        if (grades[s] === undefined) grades[s] = 0;
      });
    }

    const m = grades["คณิตศาสตร์"];
    const s = grades["วิทยาศาสตร์"];
    const l = grades["ภาษาต่างประเทศ"];
    const a = grades["ศิลปะ/ความคิดสร้างสรรค์"];
    const p = grades["กีฬา/ร่างกาย"];

    const prompt = `You are an expert career counselor. Analyze these student grades out of 100: Math: ${m}, Science: ${s}, Foreign Language: ${l}, Arts: ${a}, Physical Education: ${p}. 
Suggest 2-3 suitable careers for this student and give a brief 1-2 sentence explanation of why. 
Format your response exactly like this in Thai:
Career: [Career 1, Career 2, Career 3]
Explanation: [Explanation in Thai]`;

    let suggestion = "กำลังคิด...";
    let description = "AI NUTNUT กำลังเตรียมผลวิเคราะห์";
    let usedLocalFallback = false;

    try {
      const ollamaRes = await fetch(process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || "llama3",
          prompt: prompt,
          stream: false
        })
      });
      
      if (ollamaRes.ok) {
        const ollamaData = await ollamaRes.json();
        const text = ollamaData.response;
        const careerMatch = text.match(/Career:\s*(.+)/i);
        const explanationMatch = text.match(/Explanation:\s*([\s\S]+)/i);
        
        suggestion = careerMatch ? careerMatch[1].trim() : "หลากหลายอาชีพตามความถนัด";
        description = explanationMatch ? explanationMatch[1].trim() : text.trim();
      } else {
        usedLocalFallback = true;
      }
    } catch (e) {
      usedLocalFallback = true;
    }

    if (usedLocalFallback) {
      const fallback = buildLocalAiInsight(grades);
      suggestion = fallback.suggestion;
      description = `${fallback.description} (วิเคราะห์โดย AI NUTNUT โหมดสำรอง)`;
    }

    res.json({ grades, suggestion, description, isMocked });
  } catch (err) {
    sendDbError(res, "วิเคราะห์ผลไม่สำเร็จ", err);
  }
});

app.post("/api/checkin-sessions", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const { className, expiresMins } = req.body;
  const teacherId = req.user.id;
  const targetClass = className || req.user.assignedClass || "";
  
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + (expiresMins || 30) * 60000);
  
  activeCheckinSessions.set(code, {
    teacherId,
    targetClass,
    expiresAt,
    createdAt: new Date()
  });
  
  res.json({ code, expiresAt, targetClass });
});

app.post("/api/attendance/code", async (req, res) => {
  const { code, studentId } = req.body;
  if (!code || !studentId) return res.status(400).json({ message: "กรุณาระบุรหัสนักเรียนและรหัสเช็คชื่อ" });
  
  const session = activeCheckinSessions.get(String(code).trim());
  if (!session) return res.status(404).json({ message: "รหัสเช็คชื่อไม่ถูกต้องหรือหมดอายุแล้ว" });
  
  if (new Date() > session.expiresAt) {
    activeCheckinSessions.delete(String(code).trim());
    return res.status(400).json({ message: "รหัสเช็คชื่อหมดอายุแล้ว" });
  }
  
  try {
    const student = await getStudentById(studentId);
    if (!student) return res.status(404).json({ message: "ไม่พบข้อมูลนักเรียน" });
    
    if (session.targetClass && String(student.class_name).trim() !== String(session.targetClass).trim()) {
      return res.status(403).json({ message: "นักเรียนไม่ได้อยู่ในห้องเรียนที่กำหนดให้เช็คชื่อ" });
    }
    
    res.json(await saveAttendance(student, "qr_code"));
  } catch(err) {
    sendDbError(res, "เช็คชื่อไม่สำเร็จ", err);
  }
});

app.post("/api/check", async (req, res) => {
  const id = String(req.body?.id || "").trim();

  if (!id) {
    res.status(400).json({ message: "กรุณาระบุรหัสนักเรียน" });
    return;
  }

  try {
    const student = await getStudentById(id);

    if (!student) {
      res.status(404).json({ message: "❌ ไม่พบข้อมูลนักเรียน" });
      return;
    }

    res.json(await saveAttendance(student, "manual"));
  } catch (err) {
    sendDbError(res, "บันทึกเวลาเช็คชื่อไม่สำเร็จ", err);
  }
});

app.post("/api/check/nfc", async (req, res) => {
  const uid = String(req.body?.uid || "").trim();

  if (!uid) {
    res.status(400).json({ message: "กรุณาระบุ UID ของบัตร" });
    return;
  }

  try {
    const student = USE_GAS
      ? (await gasListStudents()).find(item => String(item.nfc_uid || "") === String(uid))
      : await getQuery(
          `
            SELECT id, name, class_name, nfc_uid, photo_url
            FROM students
            WHERE nfc_uid = ?
          `,
          [uid]
        );

    if (!student) {
      res.status(404).json({ message: "ไม่พบบัตรนี้ในระบบ" });
      return;
    }

    res.json(await saveAttendance(student, "nfc"));
  } catch (err) {
    sendDbError(res, "เช็คชื่อด้วยบัตรไม่สำเร็จ", err);
  }
});

app.get("/api/logs", authenticateToken, async (req, res) => {
  if (!ensureLinkedStudent(req, res)) {
    return;
  }

  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const date = String(req.query.date || "").trim();
  const isStudent = req.user.role === "student";
  const studentId = req.user.studentId;
  const isTeacher = req.user.role === "teacher" && req.user.assignedClass;

  if (USE_GAS) {
    try {
      let rows = await gasListLogs({ date, limit });

      if (isStudent && studentId) {
        rows = rows.filter(row => String(row.id) === String(studentId));
      } else if (isTeacher) {
        const students = await gasListStudents();
        const allowedIds = new Set(
          students
            .filter(student => String(student.class_name) === String(req.user.assignedClass))
            .map(student => String(student.id))
        );
        rows = rows.filter(row => allowedIds.has(String(row.id)));
      }

      return res.json(rows.slice(0, limit));
    } catch (err) {
      return sendDbError(res, "โหลดประวัติการเช็คชื่อไม่สำเร็จ", err);
    }
  }

  let query = "SELECT l.log_id, l.id, l.student_name, l.check_in_at, l.check_in_date, l.status, l.method FROM logs l";
  let params = [];

  if (isTeacher) {
    query += " JOIN students s ON l.id = s.id WHERE s.class_name = ?";
    params.push(req.user.assignedClass);
  } else {
    query += " WHERE 1 = 1";
  }

  if (date) {
    query += " AND l.check_in_date = ?";
    params.push(date);
  }

  if (isStudent && studentId) {
    query += " AND l.id = ?";
    params.push(studentId);
  }

  query += " ORDER BY l.log_id DESC LIMIT ?";
  params.push(limit);

  try {
    const rows = await allQuery(query, params);

    res.json(rows);
  } catch (err) {
    sendDbError(res, "โหลดประวัติการเช็คชื่อไม่สำเร็จ", err);
  }
});

app.get("/api/dashboard/summary", authenticateToken, async (req, res) => {
  if (!ensureLinkedStudent(req, res)) {
    return;
  }

  const today = String(req.query.date || getLocalDateKey()).trim();
  const isTeacher = req.user.role === "teacher" && req.user.assignedClass;

  try {
    if (USE_GAS) {
      const [students, logs] = await Promise.all([
        gasListStudents(),
        gasListLogs({ date: today })
      ]);

      if (req.user.role === "student" && req.user.studentId) {
        const myLogs = logs.filter(row => String(row.id) === String(req.user.studentId));
        const hasCheckedIn = myLogs.length > 0;
        return res.json({
          date: today,
          totalStudents: 1,
          todayCheckIns: myLogs.length,
          uniqueCheckIns: hasCheckedIn ? 1 : 0,
          absentCount: hasCheckedIn ? 0 : 1
        });
      }

      let filteredStudents = students;
      let filteredLogs = logs;
      if (isTeacher) {
        filteredStudents = students.filter(student => String(student.class_name) === String(req.user.assignedClass));
        const allowedIds = new Set(filteredStudents.map(student => String(student.id)));
        filteredLogs = logs.filter(log => allowedIds.has(String(log.id)));
      }

      const uniqueIds = new Set(filteredLogs.map(log => String(log.id)));
      return res.json({
        date: today,
        totalStudents: filteredStudents.length,
        todayCheckIns: filteredLogs.length,
        uniqueCheckIns: uniqueIds.size,
        absentCount: Math.max(filteredStudents.length - uniqueIds.size, 0)
      });
    }

    if (req.user.role === "student" && req.user.studentId) {
      const logRow = await getQuery(
        `
          SELECT COUNT(*) AS todayCheckIns,
                 COUNT(DISTINCT id) AS uniqueCheckIns
          FROM logs
          WHERE check_in_date = ? AND id = ?
        `,
        [today, req.user.studentId]
      );

      const hasCheckedIn = (logRow?.uniqueCheckIns || 0) > 0;
      res.json({
        date: today,
        totalStudents: 1,
        todayCheckIns: logRow?.todayCheckIns || 0,
        uniqueCheckIns: logRow?.uniqueCheckIns || 0,
        absentCount: hasCheckedIn ? 0 : 1
      });
      return;
    }

    let studentQuery = "SELECT COUNT(*) AS totalStudents FROM students";
    let studentParams = [];
    let logQuery = `
        SELECT COUNT(*) AS todayCheckIns,
               COUNT(DISTINCT l.id) AS uniqueCheckIns
        FROM logs l
      `;
    let logParams = [today];

    if (isTeacher) {
      studentQuery += " WHERE class_name = ?";
      studentParams.push(req.user.assignedClass);
      
      logQuery += " JOIN students s ON l.id = s.id WHERE l.check_in_date = ? AND s.class_name = ?";
      logParams.push(req.user.assignedClass);
    } else {
      logQuery += " WHERE l.check_in_date = ?";
    }

    const studentRow = await getQuery(studentQuery, studentParams);
    const logRow = await getQuery(logQuery, logParams);

    res.json({
      date: today,
      totalStudents: studentRow?.totalStudents || 0,
      todayCheckIns: logRow?.todayCheckIns || 0,
      uniqueCheckIns: logRow?.uniqueCheckIns || 0,
      absentCount: (studentRow?.totalStudents || 0) - (logRow?.uniqueCheckIns || 0)
    });
  } catch (err) {
    sendDbError(res, "โหลดสรุปข้อมูลไม่สำเร็จ", err);
  }
});

app.get("/api/dashboard/logs", authenticateToken, async (req, res) => {
  if (!ensureLinkedStudent(req, res)) {
    return;
  }

  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const date = String(req.query.date || "").trim();
  const isStudent = req.user.role === "student";
  const studentId = req.user.studentId;
  const isTeacher = req.user.role === "teacher" && req.user.assignedClass;

  if (USE_GAS) {
    try {
      let rows = await gasListLogs({ date, limit });

      if (isStudent && studentId) {
        rows = rows.filter(row => String(row.id) === String(studentId));
      } else if (isTeacher) {
        const students = await gasListStudents();
        const allowedIds = new Set(
          students
            .filter(student => String(student.class_name) === String(req.user.assignedClass))
            .map(student => String(student.id))
        );
        rows = rows.filter(row => allowedIds.has(String(row.id)));
      }

      return res.json(rows.slice(0, limit));
    } catch (err) {
      return sendDbError(res, "โหลดรายการเช็คชื่อไม่สำเร็จ", err);
    }
  }

  let query = "SELECT l.log_id, l.id, l.student_name, l.check_in_at, l.check_in_date, l.status, l.method FROM logs l";
  let params = [];

  if (isTeacher) {
    query += " JOIN students s ON l.id = s.id WHERE s.class_name = ?";
    params.push(req.user.assignedClass);
  } else {
    query += " WHERE 1 = 1";
  }

  if (date) {
    query += " AND l.check_in_date = ?";
    params.push(date);
  }

  if (isStudent && studentId) {
    query += " AND l.id = ?";
    params.push(studentId);
  }

  query += " ORDER BY l.log_id DESC LIMIT ? OFFSET ?";
  params.push(limit);
  params.push(offset);

  try {
    const rows = await allQuery(query, params);
    res.json(rows);
  } catch (err) {
    sendDbError(res, "โหลดรายการเช็คชื่อไม่สำเร็จ", err);
  }
});

app.get("/api/dashboard/students", authenticateToken, async (req, res) => {
  if (!ensureLinkedStudent(req, res)) {
    return;
  }

  const date = String(req.query.date || getLocalDateKey()).trim();
  const isStudent = req.user.role === "student";
  const studentId = req.user.studentId;
  const isTeacher = req.user.role === "teacher" && req.user.assignedClass;

  if (USE_GAS) {
    try {
      let students = await gasListStudents();
      const logs = await gasListLogs({ date });
      const presentIds = new Set(logs.map(log => String(log.id)));

      if (isStudent && studentId) {
        students = students.filter(student => String(student.id) === String(studentId));
      } else if (isTeacher) {
        students = students.filter(student => String(student.class_name) === String(req.user.assignedClass));
      }

      const rows = students
        .map(student => ({
          ...student,
          attendanceStatus: presentIds.has(String(student.id)) ? "มาเรียน" : "ยังไม่เช็คชื่อ"
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));

      return res.json(rows);
    } catch (err) {
      return sendDbError(res, "โหลดสถานะนักเรียนไม่สำเร็จ", err);
    }
  }

  let query = `
        SELECT
          s.id,
          s.name,
          s.class_name,
          s.nfc_uid,
          s.photo_url,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM logs l
              WHERE l.id = s.id AND l.check_in_date = ?
            ) THEN 'มาเรียน'
            ELSE 'ยังไม่เช็คชื่อ'
          END AS attendanceStatus
        FROM students s
        WHERE 1 = 1
      `;
  const params = [date];

  if (isStudent && studentId) {
    query += " AND s.id = ?";
    params.push(studentId);
  } else if (isTeacher) {
    query += " AND s.class_name = ?";
    params.push(req.user.assignedClass);
  }

  query += " ORDER BY s.id ASC";

  try {
    const rows = await allQuery(query, params);

    res.json(rows);
  } catch (err) {
    sendDbError(res, "โหลดสถานะนักเรียนไม่สำเร็จ", err);
  }
});

app.get("/api/history", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const date = String(req.query.date || getLocalDateKey()).trim();
  const isTeacher = req.user.role === "teacher" && req.user.assignedClass;

  try {
    if (USE_GAS) {
      const [students, logs] = await Promise.all([
        gasListStudents(),
        gasListLogs({ date })
      ]);

      let filteredStudents = students;
      let filteredLogs = logs;

      if (isTeacher) {
        filteredStudents = students.filter(student => String(student.class_name) === String(req.user.assignedClass));
        const allowedIds = new Set(filteredStudents.map(student => String(student.id)));
        filteredLogs = logs.filter(log => allowedIds.has(String(log.id)));
      }

      const uniqueIds = new Set(filteredLogs.map(log => String(log.id)));
      return res.json({
        date,
        summary: {
          totalCheckIns: filteredLogs.length,
          uniqueCheckIns: uniqueIds.size
        },
        logs: filteredLogs
      });
    }

    let summaryQuery = `
          SELECT COUNT(*) AS totalCheckIns,
                 COUNT(DISTINCT l.id) AS uniqueCheckIns
          FROM logs l
        `;
    let logsQuery = `
          SELECT l.log_id, l.id, l.student_name, l.check_in_at, l.check_in_date, l.status, l.method
          FROM logs l
        `;
    let params = [date];

    if (isTeacher) {
      const classJoin = " JOIN students s ON l.id = s.id WHERE l.check_in_date = ? AND s.class_name = ?";
      summaryQuery += classJoin;
      logsQuery += classJoin + " ORDER BY l.log_id DESC";
      params.push(req.user.assignedClass);
    } else {
      summaryQuery += " WHERE l.check_in_date = ?";
      logsQuery += " WHERE l.check_in_date = ? ORDER BY l.log_id DESC";
    }

    const [summary, logs] = await Promise.all([
      getQuery(summaryQuery, params),
      allQuery(logsQuery, params)
    ]);

    res.json({
      date,
      summary,
      logs
    });
  } catch (err) {
    sendDbError(res, "โหลดประวัติย้อนหลังไม่สำเร็จ", err);
  }
});

// Announcements API
app.get("/api/announcements", authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    let whereClause = "";
    let params = [req.user.id];

    // Filter announcements based on user role and target audience
    if (user.role === "student") {
      whereClause = "(a.target_audience = 'all' OR a.target_audience = 'students'";
      if (user.studentId) {
        const student = await getStudentById(user.studentId);
        if (student?.class_name) {
          whereClause += " OR a.target_class = ?";
          params.push(student.class_name);
        }
      }
      whereClause += ")";
    } else if (user.role === "teacher" && user.assignedClass) {
      whereClause = "(a.target_audience = 'all' OR a.target_audience = 'teachers' OR a.target_class = ?)";
      params.push(user.assignedClass);
    }
    // Admin can see all announcements

    const announcements = await allQuery(`
      SELECT a.id, a.title, a.content, a.target_audience, a.target_class, 
             a.created_at, a.created_by,
             u.username as created_by_name,
             CASE WHEN ar.read_at IS NULL THEN 1 ELSE 0 END as is_new
      FROM announcements a
      LEFT JOIN users u ON a.created_by = u.id
      LEFT JOIN announcement_reads ar ON a.id = ar.announcement_id AND ar.user_id = ?
      ${whereClause ? "WHERE " + whereClause : ""}
      ORDER BY a.created_at DESC LIMIT 50
    `, params);
    res.json(announcements);
  } catch (err) {
    sendDbError(res, "โหลดประกาศไม่สำเร็จ", err);
  }
});

app.post("/api/announcements", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const { title, content, targetAudience } = req.body;

  if (!title || !content) {
    return res.status(400).json({ message: "กรุณากรอกหัวข้อและเนื้อหาประกาศ" });
  }

  try {
    const result = await runQuery(
      `INSERT INTO announcements (title, content, target_audience, created_by) VALUES (?, ?, ?, ?)`,
      [title, content, targetAudience || "all", req.user.id]
    );

    res.status(201).json({
      message: "สร้างประกาศสำเร็จ",
      id: result.lastID
    });
  } catch (err) {
    sendDbError(res, "สร้างประกาศไม่สำเร็จ", err);
  }
});

app.delete("/api/announcements/:id", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  const announcementId = Number(req.params.id);

  try {
    // Check if user can delete this announcement (only creator or admin)
    const announcement = await getQuery(
      "SELECT created_by FROM announcements WHERE id = ?",
      [announcementId]
    );

    if (!announcement) {
      return res.status(404).json({ message: "ไม่พบประกาศนี้" });
    }

    if (req.user.role !== "admin" && announcement.created_by !== req.user.id) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ลบประกาศนี้" });
    }

    await runQuery("DELETE FROM announcements WHERE id = ?", [announcementId]);
    res.json({ message: "ลบประกาศสำเร็จ" });
  } catch (err) {
    sendDbError(res, "ลบประกาศไม่สำเร็จ", err);
  }
});

// Mark announcement as read API
app.post("/api/announcements/:id/read", authenticateToken, async (req, res) => {
  try {
    const announcementId = req.params.id;

    // Check if announcement exists and user can see it
    const announcement = await getQuery(`
      SELECT a.*, u.role as user_role, u.assigned_class
      FROM announcements a
      JOIN users u ON u.id = ?
      WHERE a.id = ?
    `, [req.user.id, announcementId]);

    if (!announcement) {
      return res.status(404).json({ message: "ไม่พบประกาศ" });
    }

    // Check permissions
    if (req.user.role === 'student') {
      if (announcement.target_audience === 'teachers') {
        return res.status(403).json({ message: "ไม่มีสิทธิ์เข้าถึงประกาศนี้" });
      }
      if (announcement.target_audience === 'student' && announcement.target_class) {
        const studentClass = await getQuery("SELECT class_name FROM students WHERE id = ?", [req.user.studentId]);
        if (!studentClass || studentClass.class_name !== announcement.target_class) {
          return res.status(403).json({ message: "ไม่มีสิทธิ์เข้าถึงประกาศนี้" });
        }
      }
    }

    // Mark as read
    await runQuery(`
      INSERT OR REPLACE INTO announcement_reads (announcement_id, user_id, read_at)
      VALUES (?, ?, datetime('now'))
    `, [announcementId, req.user.id]);

    res.json({ message: "ทำเครื่องหมายว่าอ่านแล้ว" });
  } catch (err) {
    sendDbError(res, "ทำเครื่องหมายไม่สำเร็จ", err);
  }
});
app.post("/api/notifications/send-absent-reminders", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ message: "กรุณาระบุข้อความแจ้งเตือน" });
    }

    // Get today's absent students
    const today = new Date().toISOString().split('T')[0];
    const absentStudents = await allQuery(`
      SELECT s.id, s.name, s.class_name, u.username as teacher_username
      FROM students s
      LEFT JOIN check_ins c ON s.id = c.student_id AND DATE(c.check_in_at) = ?
      LEFT JOIN users u ON u.student_id = s.id
      WHERE c.student_id IS NULL
      ORDER BY s.class_name, s.name
    `, [today]);

    if (absentStudents.length === 0) {
      return res.status(200).json({ message: "ไม่มีนักเรียนขาดเรียนวันนี้", sent: 0 });
    }

    // Create announcements for absent students
    const announcements = absentStudents.map(student => ({
      title: `แจ้งเตือนการขาดเรียน - ${student.name}`,
      content: `${message}\n\nนักเรียน: ${student.name}\nชั้น: ${student.class_name}\nวันที่: ${new Date().toLocaleDateString('th-TH')}`,
      target_audience: 'student',
      target_class: student.class_name,
      created_by: req.user.id
    }));

    // Insert announcements
    for (const announcement of announcements) {
      await runQuery(
        `INSERT INTO announcements (title, content, target_audience, target_class, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [announcement.title, announcement.content, announcement.target_audience, announcement.target_class, announcement.created_by]
      );
    }

    res.json({
      message: `ส่งการแจ้งเตือนสำเร็จให้ ${absentStudents.length} คน`,
      sent: absentStudents.length,
      students: absentStudents.map(s => ({ id: s.id, name: s.name, class: s.class_name }))
    });

  } catch (err) {
    sendDbError(res, "ส่งการแจ้งเตือนไม่สำเร็จ", err);
  }
});

// Photo Upload Endpoints
const multer = require('multer');
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const studentUploadDir = path.join(uploadsDir, req.params.id);
    fs.mkdirSync(studentUploadDir, { recursive: true });
    cb(null, studentUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `photo${ext}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('ประเภทไฟล์ไม่ถูกต้อง (ต้องเป็น JPEG, PNG, GIF, WebP)'));
    }
  }
});

app.post("/api/students/:id/photo", authenticateToken, requireRole(["admin", "teacher"]), upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "กรุณาเลือกไฟล์รูปภาพ" });
  }

  try {
    const photoUrl = `/uploads/${req.params.id}/${req.file.filename}`;
    
    // Update student's photo_url in database
    await runQuery(
      "UPDATE students SET photo_url = ? WHERE id = ?",
      [photoUrl, req.params.id]
    );

    res.json({
      message: "อัพโหลดรูปภาพสำเร็จ",
      photoUrl: photoUrl
    });
  } catch (err) {
    sendDbError(res, "อัพโหลดรูปภาพไม่สำเร็จ", err);
  }
});

app.delete("/api/students/:id/photo", authenticateToken, requireRole(["admin", "teacher"]), async (req, res) => {
  try {
    const student = await getStudentById(req.params.id);
    if (!student) {
      return res.status(404).json({ message: "ไม่พบข้อมูลนักเรียน" });
    }

    // Delete photo file if exists
    if (student.photo_url) {
      const photoPath = path.join(__dirname, "public", student.photo_url);
      if (fs.existsSync(photoPath)) {
        fs.unlinkSync(photoPath);
      }
    }

    // Clear photo_url from database
    await runQuery(
      "UPDATE students SET photo_url = '' WHERE id = ?",
      [req.params.id]
    );

    res.json({ message: "ลบรูปภาพสำเร็จ" });
  } catch (err) {
    sendDbError(res, "ลบรูปภาพไม่สำเร็จ", err);
  }
});

// Attendance Calendar Endpoints
app.get("/api/calendar/:year/:month", authenticateToken, async (req, res) => {
  if (!ensureLinkedStudent(req, res)) {
    return;
  }

  const year = Number(req.params.year);
  const month = Number(req.params.month);

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return res.status(400).json({ message: "ปี หรือ เดือนไม่ถูกต้อง" });
  }

  try {
    const studentId = req.user.studentId;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    let query = `
      SELECT check_in_date as date, COUNT(*) as count
      FROM logs
      WHERE check_in_date >= ? AND check_in_date <= ?
    `;
    let params = [startDateStr, endDateStr];

    if (req.user.role === "student" && studentId) {
      query += " AND id = ?";
      params.push(studentId);
    } else if (req.user.role === "teacher" && req.user.assignedClass) {
      query += " AND id IN (SELECT id FROM students WHERE class_name = ?)";
      params.push(req.user.assignedClass);
    }

    query += " GROUP BY check_in_date ORDER BY date ASC";

    const attendance = await allQuery(query, params);
    const calendar = {};

    // Initialize all days to 0
    for (let i = 1; i <= endDate.getDate(); i++) {
      const date = new Date(year, month - 1, i);
      const dateStr = date.toISOString().split('T')[0];
      calendar[dateStr] = 0;
    }

    // Fill in attendance
    attendance.forEach(record => {
      calendar[record.date] = record.count;
    });

    res.json({
      year,
      month,
      calendar
    });
  } catch (err) {
    sendDbError(res, "โหลดปฏิทินการเช็คชื่อไม่สำเร็จ", err);
  }
});

// Get monthly summary
app.get("/api/calendar/:year/:month/summary", authenticateToken, async (req, res) => {
  if (!ensureLinkedStudent(req, res)) {
    return;
  }

  const year = Number(req.params.year);
  const month = Number(req.params.month);

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return res.status(400).json({ message: "ปี หรือ เดือนไม่ถูกต้อง" });
  }

  try {
    const studentId = req.user.studentId;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    const totalDays = endDate.getDate();

    let studentCountQuery = "SELECT COUNT(DISTINCT id) as total FROM students WHERE 1 = 1";
    let attendanceQuery = `
      SELECT COUNT(DISTINCT id) as attended
      FROM logs
      WHERE check_in_date >= ? AND check_in_date <= ?
    `;
    let attendanceParams = [startDateStr, endDateStr];
    let studentCountParams = [];

    if (req.user.role === "teacher" && req.user.assignedClass) {
      studentCountQuery += " AND class_name = ?";
      studentCountParams.push(req.user.assignedClass);
      attendanceQuery += " AND id IN (SELECT id FROM students WHERE class_name = ?)";
      attendanceParams.push(req.user.assignedClass);
    }

    const [studentCount, attendanceCount] = await Promise.all([
      getQuery(studentCountQuery, studentCountParams),
      getQuery(attendanceQuery, attendanceParams)
    ]);

    res.json({
      year,
      month,
      totalDays,
      totalStudents: studentCount?.total || 0,
      studentsAttended: attendanceCount?.attended || 0,
      attendancePercentage: studentCount?.total ? Math.round((attendanceCount?.attended || 0) / studentCount.total * 100) : 0
    });
  } catch (err) {
    sendDbError(res, "โหลดสรุปปฏิทินไม่สำเร็จ", err);
  }
});

// Serve uploaded photos
app.use("/uploads", express.static(uploadsDir));

migrateDatabase()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`NutCheck server running at http://127.0.0.1:${PORT}`);

      const lanAddress = getLanAddress();
      if (lanAddress) {
        console.log(`Share on your Wi-Fi: http://${lanAddress}:${PORT}`);
      }

      // Schedule automatic absent reminders at 8:00 AM daily
      scheduleAbsentReminders();
    });
  })
  .catch((err) => {
    console.error("Database migration failed", err);
    process.exit(1);
  });

// Schedule automatic absent reminders
function scheduleAbsentReminders() {
  const now = new Date();
  const targetTime = new Date();
  targetTime.setHours(8, 0, 0, 0); // 8:00 AM

  // If it's already past 8 AM today, schedule for tomorrow
  if (now > targetTime) {
    targetTime.setDate(targetTime.getDate() + 1);
  }

  const timeUntilTarget = targetTime - now;

  setTimeout(() => {
    sendAutomaticAbsentReminders();
    // Schedule next reminder for tomorrow
    setInterval(sendAutomaticAbsentReminders, 24 * 60 * 60 * 1000); // 24 hours
  }, timeUntilTarget);

  console.log(`Automatic absent reminders scheduled for ${targetTime.toLocaleString()}`);
}

async function sendAutomaticAbsentReminders() {
  try {
    console.log('Sending automatic absent reminders...');

    // Get yesterday's absent students (since reminders are sent in the morning)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const absentStudents = await allQuery(`
      SELECT s.id, s.name, s.class_name
      FROM students s
      LEFT JOIN check_ins c ON s.id = c.student_id AND DATE(c.check_in_at) = ?
      WHERE c.student_id IS NULL
      ORDER BY s.class_name, s.name
    `, [yesterdayStr]);

    if (absentStudents.length === 0) {
      console.log('No absent students yesterday, skipping reminders');
      return;
    }

    // Create automatic announcements for absent students
    const message = `เรียนนักเรียนที่ขาดเรียนเมื่อวาน (${yesterday.toLocaleDateString('th-TH')}) กรุณาแจ้งเหตุผลการขาดเรียนให้ครูทราบโดยเร็วที่สุด และเตรียมตัวมาเรียนให้ครบถ้วน`;

    // Get admin user for creating announcements
    const adminUser = await getQuery("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (!adminUser) {
      console.error('No admin user found for automatic reminders');
      return;
    }

    for (const student of absentStudents) {
      await runQuery(
        `INSERT INTO announcements (title, content, target_audience, target_class, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [
          `แจ้งเตือนการขาดเรียน - ${student.name}`,
          `${message}\n\nนักเรียน: ${student.name}\nชั้น: ${student.class_name}\nวันที่ขาด: ${yesterday.toLocaleDateString('th-TH')}`,
          'student',
          student.class_name,
          adminUser.id
        ]
      );
    }

    console.log(`Sent automatic reminders to ${absentStudents.length} absent students`);
  } catch (error) {
    console.error('Error sending automatic absent reminders:', error);
  }
}
