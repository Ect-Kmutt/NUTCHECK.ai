INSERT OR IGNORE INTO students (id, name, class_name, nfc_uid, photo_url)
VALUES
  ('65001', 'Min', '', '04b43262cd2a81', ''),
  ('65002', 'Nina', '', '04cdef63cd2a81', ''),
  ('65003', 'Boss', '', '04cb746fcc2a81', ''),
  ('65004', 'Ploy', '', '04261664cd2a81', '');

-- Create default admin/teacher/student accounts
-- Passwords are pre-hashed with bcrypt. For demo purposes only!
-- admin password: admin123
-- teacher password: teacher123
-- student password: student123
INSERT OR IGNORE INTO users (username, password, role, student_id, assigned_class)
VALUES
  ('admin', '$2b$10$ixxU2Us67FG8su/j7qLVyO4ZtUUbQ3OrM3YPaLW0vIrHjoFOjaEJW', 'admin', NULL, ''),
  ('teacher1', '$2b$10$iGjmMms7NvRHXp4hHi/7c.5FkM9BmrhaEDuAnUEie2ZLDLnBe.u9y', 'teacher', NULL, ''),
  ('student1', '$2b$10$zmGrQrh.IcJrd4KGqkxOx.zKw8kfEQCaWPdOt3G7lF7l/BAy75DD2', 'student', '65001', '');

INSERT OR IGNORE INTO grades (student_id, subject, score)
VALUES
  ('65001', 'คณิตศาสตร์', 85),
  ('65001', 'วิทยาศาสตร์', 78),
  ('65001', 'ภาษาไทย', 90),
  ('65002', 'คณิตศาสตร์', 92),
  ('65002', 'วิทยาศาสตร์', 88),
  ('65002', 'ภาษาไทย', 85);
