var SHEET_NAMES = {
  students: "students",
  users: "users",
  grades: "grades",
  logs: "logs"
};

var SHEET_HEADERS = {
  students: ["id", "name", "class_name", "nfc_uid", "photo_url"],
  users: ["id", "username", "password", "role", "student_id", "assigned_class"],
  grades: ["id", "student_id", "subject", "score"],
  logs: ["log_id", "id", "student_name", "check_in_at", "check_in_date", "status", "method"]
};

function doGet(e) {
  return handleRequest_("GET", e);
}

function doPost(e) {
  return handleRequest_("POST", e);
}

function handleRequest_(method, e) {
  try {
    var payload = parsePayload_(e);
    authorize_(payload);

    var action = String(payload.action || "").trim();
    if (!action) {
      return jsonResponse_({ ok: false, message: "Missing action" }, 400);
    }

    ensureSheets_();

    var handlers = getHandlers_();
    var handler = handlers[action];

    if (!handler) {
      return jsonResponse_({ ok: false, message: "Unknown action: " + action }, 404);
    }

    var result = handler(payload, method);
    return jsonResponse_({ ok: true, action: action, data: result });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      message: error && error.message ? error.message : "Unexpected error"
    }, 500);
  }
}

function getHandlers_() {
  return {
    health: function () {
      return {
        status: "ok",
        spreadsheetId: getSpreadsheetId_(),
        sheets: listSheetNames_()
      };
    },
    setup: function () {
      ensureSheets_();
      return { message: "Sheets ready" };
    },
    importSnapshot: function (payload) {
      if (!payload.snapshot) {
        throw new Error("Missing snapshot");
      }

      var snapshot = typeof payload.snapshot === "string"
        ? JSON.parse(payload.snapshot)
        : payload.snapshot;

      writeTable_("students", snapshot.students || []);
      writeTable_("users", snapshot.users || []);
      writeTable_("grades", snapshot.grades || []);
      writeTable_("logs", snapshot.logs || []);

      return {
        imported: {
          students: (snapshot.students || []).length,
          users: (snapshot.users || []).length,
          grades: (snapshot.grades || []).length,
          logs: (snapshot.logs || []).length
        }
      };
    },
    exportSnapshot: function () {
      return {
        students: readTable_("students"),
        users: readTable_("users"),
        grades: readTable_("grades"),
        logs: readTable_("logs")
      };
    },
    listStudents: function (payload) {
      var rows = readTable_("students");
      if (payload.studentId) {
        rows = rows.filter(function (row) { return String(row.id) === String(payload.studentId); });
      }
      return rows;
    },
    getStudent: function (payload) {
      return findByField_("students", "id", payload.id);
    },
    upsertStudent: function (payload) {
      if (!payload.student) {
        throw new Error("Missing student payload");
      }
      return upsertRow_("students", payload.student, "id");
    },
    deleteStudent: function (payload) {
      deleteByField_("students", "id", payload.id);
      deleteByField_("users", "student_id", payload.id, true);
      deleteByField_("grades", "student_id", payload.id, true);
      deleteByField_("logs", "id", payload.id, true);
      return { id: payload.id };
    },
    listUsers: function () {
      return readTable_("users");
    },
    upsertUser: function (payload) {
      if (!payload.user) {
        throw new Error("Missing user payload");
      }
      return upsertRow_("users", payload.user, "id");
    },
    deleteUser: function (payload) {
      deleteByField_("users", "id", payload.id);
      return { id: payload.id };
    },
    getGrades: function (payload) {
      if (!payload.studentId) {
        throw new Error("Missing studentId");
      }
      return readTable_("grades").filter(function (row) {
        return String(row.student_id) === String(payload.studentId);
      });
    },
    saveGrades: function (payload) {
      if (!payload.studentId || !payload.grades) {
        throw new Error("Missing studentId or grades");
      }

      var table = readTable_("grades").filter(function (row) {
        return String(row.student_id) !== String(payload.studentId);
      });

      var subjects = Object.keys(payload.grades);
      for (var i = 0; i < subjects.length; i += 1) {
        var subject = subjects[i];
        table.push({
          id: nextNumericId_(table, "id"),
          student_id: String(payload.studentId),
          subject: subject,
          score: Number(payload.grades[subject])
        });
      }

      writeTable_("grades", table);
      return { studentId: payload.studentId, count: subjects.length };
    },
    addLog: function (payload) {
      if (!payload.log) {
        throw new Error("Missing log payload");
      }

      var rows = readTable_("logs");
      var log = cloneObject_(payload.log);
      if (!log.log_id) {
        log.log_id = nextNumericId_(rows, "log_id");
      }
      rows.push(log);
      writeTable_("logs", rows);
      return log;
    },
    listLogs: function (payload) {
      var rows = readTable_("logs");
      if (payload.date) {
        rows = rows.filter(function (row) {
          return String(row.check_in_date) === String(payload.date);
        });
      }
      if (payload.studentId) {
        rows = rows.filter(function (row) {
          return String(row.id) === String(payload.studentId);
        });
      }

      rows.sort(function (a, b) {
        return Number(b.log_id || 0) - Number(a.log_id || 0);
      });

      var limit = Number(payload.limit || 0);
      return limit > 0 ? rows.slice(0, limit) : rows;
    },
    dashboardSummary: function (payload) {
      var date = payload.date || todayKey_();
      var students = readTable_("students");
      var logs = readTable_("logs").filter(function (row) {
        return String(row.check_in_date) === String(date);
      });

      var unique = {};
      logs.forEach(function (row) {
        unique[String(row.id)] = true;
      });

      var uniqueCount = Object.keys(unique).length;
      return {
        date: date,
        totalStudents: students.length,
        todayCheckIns: logs.length,
        uniqueCheckIns: uniqueCount,
        absentCount: students.length - uniqueCount
      };
    },
    dashboardStudents: function (payload) {
      var date = payload.date || todayKey_();
      var students = readTable_("students");
      var logs = readTable_("logs").filter(function (row) {
        return String(row.check_in_date) === String(date);
      });

      var presentMap = {};
      logs.forEach(function (row) {
        presentMap[String(row.id)] = true;
      });

      return students.map(function (student) {
        var result = cloneObject_(student);
        result.attendanceStatus = presentMap[String(student.id)] ? "มาเรียน" : "ยังไม่เช็คชื่อ";
        return result;
      });
    },
    history: function (payload) {
      var date = payload.date || todayKey_();
      return {
        summary: getHandlers_().dashboardSummary({ date: date }),
        logs: getHandlers_().listLogs({ date: date })
      };
    }
  };
}

function parsePayload_(e) {
  var payload = {};

  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (key) {
      payload[key] = e.parameter[key];
    });
  }

  if (e && e.postData && e.postData.contents) {
    var body = JSON.parse(e.postData.contents);
    Object.keys(body).forEach(function (key) {
      payload[key] = body[key];
    });
  }

  return payload;
}

function authorize_(payload) {
  var expected = PropertiesService.getScriptProperties().getProperty("NUTCHECK_API_KEY");
  if (!expected) {
    throw new Error("Missing script property NUTCHECK_API_KEY");
  }

  if (String(payload.apiKey || "") !== String(expected)) {
    throw new Error("Unauthorized");
  }
}

function getSpreadsheetId_() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Missing script property SPREADSHEET_ID");
  }
  return spreadsheetId;
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(getSpreadsheetId_());
}

function listSheetNames_() {
  return getSpreadsheet_().getSheets().map(function (sheet) {
    return sheet.getName();
  });
}

function ensureSheets_() {
  var spreadsheet = getSpreadsheet_();

  Object.keys(SHEET_HEADERS).forEach(function (key) {
    var name = SHEET_NAMES[key];
    var sheet = spreadsheet.getSheetByName(name);

    if (!sheet) {
      sheet = spreadsheet.insertSheet(name);
    }

    var headers = SHEET_HEADERS[key];
    var currentHeaders = [];
    if (sheet.getLastRow() > 0) {
      currentHeaders = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    }

    if (currentHeaders.join("|") !== headers.join("|")) {
      sheet.clearContents();
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  });
}

function readTable_(tableName) {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES[tableName]);
  var headers = SHEET_HEADERS[tableName];
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return [];
  }

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row) {
    var item = {};
    headers.forEach(function (header, index) {
      item[header] = row[index];
    });
    return item;
  });
}

function writeTable_(tableName, rows) {
  var sheet = getSpreadsheet_().getSheetByName(SHEET_NAMES[tableName]);
  var headers = SHEET_HEADERS[tableName];

  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (!rows.length) {
    return;
  }

  var values = rows.map(function (row) {
    return headers.map(function (header) {
      return row[header] === undefined ? "" : row[header];
    });
  });

  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

function findByField_(tableName, fieldName, value) {
  var rows = readTable_(tableName);
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i][fieldName]) === String(value)) {
      return rows[i];
    }
  }
  return null;
}

function upsertRow_(tableName, row, keyField) {
  var rows = readTable_(tableName);
  var copy = cloneObject_(row);

  if (!copy[keyField]) {
    copy[keyField] = nextNumericId_(rows, keyField);
  }

  var replaced = false;
  rows = rows.map(function (item) {
    if (String(item[keyField]) === String(copy[keyField])) {
      replaced = true;
      return mergeRow_(item, copy);
    }
    return item;
  });

  if (!replaced) {
    rows.push(copy);
  }

  writeTable_(tableName, rows);
  return copy;
}

function deleteByField_(tableName, fieldName, value, allowMany) {
  var rows = readTable_(tableName);
  var filtered = rows.filter(function (row) {
    return String(row[fieldName]) !== String(value);
  });

  if (!allowMany && filtered.length === rows.length) {
    throw new Error("Record not found: " + value);
  }

  writeTable_(tableName, filtered);
}

function nextNumericId_(rows, fieldName) {
  var max = 0;
  rows.forEach(function (row) {
    max = Math.max(max, Number(row[fieldName] || 0));
  });
  return max + 1;
}

function mergeRow_(base, patch) {
  var merged = cloneObject_(base);
  Object.keys(patch).forEach(function (key) {
    merged[key] = patch[key];
  });
  return merged;
}

function cloneObject_(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function todayKey_() {
  return Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
}
