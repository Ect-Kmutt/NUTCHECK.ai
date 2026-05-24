const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

const dbPath = process.argv[2] || path.join(__dirname, "..", "attendance.db");
const outPath = process.argv[3] || path.join(__dirname, "..", "google-apps-script", "nutcheck-snapshot.json");

const db = new sqlite3.Database(dbPath);

function all(sql, params = []) {
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

async function main() {
  const [students, users, grades, logs, behaviors] = await Promise.all([
    all("SELECT id, name, class_name, nfc_uid, photo_url FROM students ORDER BY id ASC"),
    all("SELECT id, username, password, role, student_id, assigned_class FROM users ORDER BY id ASC"),
    all("SELECT id, student_id, subject, score FROM grades ORDER BY id ASC"),
    all("SELECT log_id, id, student_name, check_in_at, check_in_date, status, method FROM logs ORDER BY log_id ASC"),
    all("SELECT id, student_id, date, subject, score, notes FROM behaviors ORDER BY id ASC")
  ]);

  const snapshot = { students, users, grades, logs, behaviors };

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`Exported snapshot to ${outPath}`);
  console.log(`students=${students.length} users=${users.length} grades=${grades.length} logs=${logs.length} behaviors=${behaviors.length}`);
}

main()
  .catch((error) => {
    console.error("Failed to export snapshot", error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
  });
