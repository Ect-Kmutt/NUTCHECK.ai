INSERT OR IGNORE INTO students (id, name, class_name, nfc_uid, photo_url)
VALUES
  ('65001', 'Min', '', '', ''),
  ('65002', 'Nina', '', '', ''),
  ('65003', 'Boss', '', '', ''),
  ('65004', 'Ploy', '', '', '');

-- Create default admin/teacher/student accounts
-- Passwords are pre-hashed with bcrypt. For demo purposes only!
-- admin password: admin123
-- teacher password: teacher123
-- student password: student123
INSERT OR IGNORE INTO users (username, password, role, student_id, assigned_class)
VALUES
  ('admin', '$2a$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'admin', NULL, ''),
  ('teacher1', '$2a$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'teacher', NULL, ''),
  ('student1', '$2a$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'student', '65001', '');

INSERT OR IGNORE INTO grades (student_id, subject, score)
VALUES
  ('65001', 'คณิตศาสตร์', 85),
  ('65001', 'วิทยาศาสตร์', 78),
  ('65001', 'ภาษาไทย', 90),
  ('65002', 'คณิตศาสตร์', 92),
  ('65002', 'วิทยาศาสตร์', 88),
  ('65002', 'ภาษาไทย', 85);
