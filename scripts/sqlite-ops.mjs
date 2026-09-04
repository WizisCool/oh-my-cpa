import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-sqlite-ops-'));

try {
  const dbPath = path.join(tempDir, 'test.db');
  const backupPath = path.join(tempDir, 'backup.db');

  const goScript = `package main
import (
	"database/sql"
	"fmt"
	_ "modernc.org/sqlite"
)
func main() {
	db, err := sql.Open("sqlite", "${dbPath.replace(/\\/g, '/')}")
	if err != nil { panic(err) }
	defer db.Close()
	_, _ = db.Exec("PRAGMA journal_mode = WAL;")
	_, _ = db.Exec("CREATE TABLE test_items (id INTEGER PRIMARY KEY, name TEXT);")
	_, _ = db.Exec("INSERT INTO test_items (name) VALUES ('item-1'), ('item-2');")
	_, err = db.Exec("VACUUM INTO '${backupPath.replace(/\\/g, '/')}';")
	if err != nil { panic(err) }
	fmt.Println("VACUUM_INTO_SUCCESS")
}`;

  const goFile = path.join(tempDir, 'ops_main.go');
  fs.writeFileSync(goFile, goScript, 'utf8');

  const out = execFileSync('go', ['run', goFile], { cwd: root, encoding: 'utf8' });
  if (!out.includes('VACUUM_INTO_SUCCESS')) {
    throw new Error('VACUUM INTO failed: ' + out);
  }
  console.log('PASS: Online WAL backup via VACUUM INTO succeeded.');

  // 2. Compute SHA-256 of backup
  const backupBytes = fs.readFileSync(backupPath);
  const hash = crypto.createHash('sha256').update(backupBytes).digest('hex');
  console.log(`PASS: Backup SHA-256 calculated: ${hash.slice(0, 16)}...`);

  // 3. Verify backup file integrity
  const verifyScript = `package main
import (
	"database/sql"
	"fmt"
	_ "modernc.org/sqlite"
)
func main() {
	db, err := sql.Open("sqlite", "${backupPath.replace(/\\/g, '/')}")
	if err != nil { panic(err) }
	defer db.Close()
	var result string
	err = db.QueryRow("PRAGMA integrity_check;").Scan(&result)
	if err != nil || result != "ok" { panic("integrity check failed: " + result) }
	var count int
	_ = db.QueryRow("SELECT COUNT(*) FROM test_items;").Scan(&count)
	if count != 2 { panic("data mismatch") }
	fmt.Println("INTEGRITY_CHECK_OK")
}`;
  const verifyFile = path.join(tempDir, 'verify_main.go');
  fs.writeFileSync(verifyFile, verifyScript, 'utf8');

  const verifyOut = execFileSync('go', ['run', verifyFile], { cwd: root, encoding: 'utf8' });
  if (!verifyOut.includes('INTEGRITY_CHECK_OK')) {
    throw new Error('Backup integrity verification failed: ' + verifyOut);
  }
  console.log('PASS: Backup PRAGMA integrity_check verified cleanly.');

  console.log('All SQLite operations & restore verification tests passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
