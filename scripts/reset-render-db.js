#!/usr/bin/env node
/**
 * Reset Render database by forcing re-initialization
 * Usage: node scripts/reset-render-db.js
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || __dirname.split('/scripts')[0];
const dbPath = path.join(dataDir, 'attendance.db');

console.log('🗑️  Resetting Render database...');
console.log(`📁 Database path: ${dbPath}`);

// Remove old database files
try {
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log('✅ Deleted attendance.db');
  }
  if (fs.existsSync(dbPath + '-shm')) {
    fs.unlinkSync(dbPath + '-shm');
    console.log('✅ Deleted attendance.db-shm');
  }
  if (fs.existsSync(dbPath + '-wal')) {
    fs.unlinkSync(dbPath + '-wal');
    console.log('✅ Deleted attendance.db-wal');
  }
} catch (err) {
  console.error('❌ Error deleting database:', err.message);
  process.exit(1);
}

console.log('✨ Database reset complete!');
console.log('💡 Restart server to re-initialize with seed data');
process.exit(0);
