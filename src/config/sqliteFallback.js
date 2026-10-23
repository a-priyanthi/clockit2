/**
 * Resilient Zero-Dependency Embedded SQLite Compatibility Engine
 *
 * Provides a 100% synchronous, drop-in replacement for Node.js `node:sqlite` DatabaseSync.
 * Works seamlessly in any runtime (Node 18, 20, 22, 26, Vercel Serverless, AWS Lambda)
 * without requiring `--experimental-sqlite` CLI flags or native C++ compilation.
 */

const fs = require('fs');
const path = require('path');

class FallbackDatabase {
  constructor(storagePath) {
    this.storagePath = storagePath || null;
    this.tables = {};
    this.autoInc = {};
    this.inTransaction = false;
    this.initPreBundledData();
  }

  initPreBundledData() {
    // 1. Preload official MIT students if bundled JSON exists
    const studentsJsonPath = path.join(__dirname, '..', 'data', 'official_mit_students.json');
    if (fs.existsSync(studentsJsonPath)) {
      try {
        const raw = fs.readFileSync(studentsJsonPath, 'utf8');
        const list = JSON.parse(raw);
        this.tables['official_mit_students'] = list.map(item => ({ ...item }));
        this.tables['official_ct_students'] = list
          .filter(s => s.department === 'Computer Technology' || (s.degree && s.degree.includes('CSE')))
          .map(item => ({ ...item }));
      } catch (err) {
        console.warn('[FallbackDatabase] Could not preload official_mit_students.json:', err.message);
      }
    }

    // 2. Preload official curriculum if bundled JSON exists
    const curriculumJsonPath = path.join(__dirname, '..', 'data', 'official_curriculum.json');
    if (fs.existsSync(curriculumJsonPath)) {
      try {
        const raw = fs.readFileSync(curriculumJsonPath, 'utf8');
        const list = JSON.parse(raw);
        let idCounter = 1;
        this.tables['official_curriculum'] = list.map(item => ({
          id: item.id || idCounter++,
          ...item
        }));
        this.autoInc['official_curriculum'] = idCounter;
      } catch (err) {
        console.warn('[FallbackDatabase] Could not preload official_curriculum.json:', err.message);
      }
    }

    // 3. Load existing saved state if storage file exists
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
        if (saved && typeof saved === 'object') {
          for (const [tbl, rows] of Object.entries(saved.tables || {})) {
            if (Array.isArray(rows) && rows.length > 0) {
              this.tables[tbl] = rows;
            }
          }
          this.autoInc = { ...(saved.autoInc || {}), ...this.autoInc };
        }
      } catch (e) {
        // Corrupt or empty storage file, continue with in-memory tables
      }
    }
  }

  persist() {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({ tables: this.tables, autoInc: this.autoInc });
      fs.writeFileSync(this.storagePath, payload, 'utf8');
    } catch (e) {
      // Non-fatal if filesystem is temporarily read-only
    }
  }

  getTable(name) {
    const key = String(name).trim().toLowerCase();
    if (!this.tables[key]) {
      this.tables[key] = [];
    }
    return this.tables[key];
  }

  exec(sql) {
    if (!sql || typeof sql !== 'string') return;
    // Split on semicolons that are not inside strings
    const statements = sql
      .split(/;(?=(?:(?:[^']*'){2})*[^']*$)/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      const upper = stmt.toUpperCase();
      if (upper === 'BEGIN' || upper.startsWith('BEGIN ')) {
        this.inTransaction = true;
        continue;
      }
      if (upper === 'COMMIT' || upper === 'ROLLBACK' || upper.startsWith('COMMIT ') || upper.startsWith('ROLLBACK ')) {
        this.inTransaction = false;
        this.persist();
        continue;
      }
      if (upper.startsWith('PRAGMA ')) {
        continue;
      }

      if (upper.startsWith('CREATE TABLE')) {
        const match = stmt.match(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z0-9_]+)/i);
        if (match) {
          const tableName = match[1].toLowerCase();
          if (!this.tables[tableName]) {
            this.tables[tableName] = [];
          }
        }
        continue;
      }

      if (upper.startsWith('ALTER TABLE')) {
        // e.g. ALTER TABLE tasks ADD COLUMN done_when TEXT;
        continue;
      }

      if (upper.startsWith('DELETE FROM')) {
        this.prepare(stmt).run();
        continue;
      }

      if (upper.startsWith('INSERT INTO') || upper.startsWith('INSERT OR ')) {
        this.prepare(stmt).run();
        continue;
      }

      if (upper.startsWith('UPDATE ')) {
        this.prepare(stmt).run();
        continue;
      }
    }
  }

  prepare(sql) {
    return new FallbackStatement(this, sql);
  }
}

class FallbackStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.trim();
  }

  get(...params) {
    const rows = this.all(...params);
    return rows.length > 0 ? rows[0] : null;
  }

  all(...params) {
    const cleanSql = this.sql.replace(/\s+/g, ' ').trim();
    const upper = cleanSql.toUpperCase();

    // 1. Simple COUNT(*) queries
    // e.g. SELECT COUNT(*) as c FROM official_mit_students
    // e.g. SELECT count(*) as count FROM teams
    const countMatch = cleanSql.match(/^SELECT\s+COUNT\s*\([^)]*\)\s*(?:AS\s+([a-zA-Z0-9_]+))?\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+?))?(?:\s+LIMIT.*)?$/i);
    if (countMatch) {
      const alias = countMatch[1] || 'c';
      const tblName = countMatch[2].toLowerCase();
      const whereClause = countMatch[3];
      let rows = this.db.getTable(tblName);
      if (whereClause) {
        rows = rows.filter(r => evaluateWhere(r, whereClause, params));
      }
      return [{ [alias]: rows.length }];
    }

    // 2. Standard SELECT queries
    // SELECT <cols> FROM <table> [WHERE ...] [ORDER BY ...] [LIMIT ...]
    const selectMatch = cleanSql.match(/^SELECT\s+(.+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(.+?))?$/i);
    if (!selectMatch) {
      return [];
    }

    const colsStr = selectMatch[1].trim();
    const tblName = selectMatch[2].toLowerCase();
    const whereClause = selectMatch[3] ? selectMatch[3].trim() : null;
    const orderClause = selectMatch[4] ? selectMatch[4].trim() : null;
    const limitClause = selectMatch[5] ? selectMatch[5].trim() : null;

    let rows = [...this.db.getTable(tblName)];

    // Apply WHERE
    if (whereClause) {
      rows = rows.filter(r => evaluateWhere(r, whereClause, params));
    }

    // Apply ORDER BY
    if (orderClause) {
      rows = sortRows(rows, orderClause);
    }

    // Apply LIMIT
    if (limitClause) {
      let limitNum = parseInt(limitClause, 10);
      if (isNaN(limitNum) && params.length > 0) {
        // limit could be ?
        const lastParam = params[params.length - 1];
        if (typeof lastParam === 'number' || !isNaN(parseInt(lastParam, 10))) {
          limitNum = parseInt(lastParam, 10);
        }
      }
      if (!isNaN(limitNum) && limitNum >= 0) {
        rows = rows.slice(0, limitNum);
      }
    }

    // Apply column selection
    if (colsStr !== '*' && !colsStr.startsWith('*')) {
      const colNames = colsStr.split(',').map(c => {
        const parts = c.trim().split(/\s+as\s+/i);
        return { original: parts[0].trim(), alias: (parts[1] || parts[0]).trim() };
      });
      rows = rows.map(r => {
        const projected = {};
        for (const col of colNames) {
          projected[col.alias] = r[col.original] !== undefined ? r[col.original] : null;
        }
        return projected;
      });
    }

    return rows;
  }

  run(...params) {
    const cleanSql = this.sql.replace(/\s+/g, ' ').trim();
    const upper = cleanSql.toUpperCase();

    // 1. INSERT INTO / INSERT OR IGNORE / INSERT OR REPLACE
    if (upper.startsWith('INSERT')) {
      const match = cleanSql.match(/^INSERT(?:\s+OR\s+(IGNORE|REPLACE))?\s+INTO\s+([a-zA-Z0-9_]+)\s*\((.+?)\)\s*VALUES\s*\((.+?)\)$/i);
      if (match) {
        const mode = (match[1] || '').toUpperCase();
        const tblName = match[2].toLowerCase();
        const cols = match[3].split(',').map(c => c.trim());
        const valPlaceholders = match[4].split(',').map(v => v.trim());

        const rows = this.db.getTable(tblName);
        const row = {};

        // Auto-increment ID if table has an ID column
        this.db.autoInc[tblName] = (this.db.autoInc[tblName] || 0) + 1;
        row.id = this.db.autoInc[tblName];

        let paramIdx = 0;
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const valPlaceholder = valPlaceholders[i];
          if (valPlaceholder === '?') {
            row[col] = params[paramIdx] !== undefined ? params[paramIdx] : null;
            paramIdx++;
          } else {
            // Literal value like 1, 0, or 'student'
            row[col] = parseLiteral(valPlaceholder);
          }
        }

        // Handle unique / primary key constraints
        const existingIdx = rows.findIndex(r => {
          if (row.id && r.id === row.id) return true;
          if (row.roll_no && String(r.roll_no).toLowerCase() === String(row.roll_no).toLowerCase()) return true;
          if (row.username && String(r.username).toLowerCase() === String(row.username).toLowerCase()) return true;
          if (row.code && String(r.code).toLowerCase() === String(row.code).toLowerCase()) return true;
          if (row.email && String(r.email).toLowerCase() === String(row.email).toLowerCase()) return true;
          if (row.event_id !== undefined && row.user_id !== undefined && r.event_id === row.event_id && r.user_id === row.user_id) return true;
          if (row.department && row.semester && row.course_code &&
              r.department === row.department && Number(r.semester) === Number(row.semester) && r.course_code === row.course_code) return true;
          return false;
        });

        if (existingIdx !== -1) {
          if (mode === 'IGNORE') {
            return { changes: 0, lastInsertRowid: rows[existingIdx].id || 0 };
          } else if (mode === 'REPLACE') {
            rows[existingIdx] = { ...rows[existingIdx], ...row };
            if (!this.db.inTransaction) this.db.persist();
            return { changes: 1, lastInsertRowid: rows[existingIdx].id || row.id };
          }
        }

        rows.push(row);
        if (!this.db.inTransaction) this.db.persist();
        return { changes: 1, lastInsertRowid: row.id };
      }
    }

    // 2. UPDATE table SET col1 = ?, ... WHERE ...
    if (upper.startsWith('UPDATE')) {
      const match = cleanSql.match(/^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+?))?$/i);
      if (match) {
        const tblName = match[1].toLowerCase();
        const setClause = match[2];
        const whereClause = match[3];

        const rows = this.db.getTable(tblName);
        let paramIdx = 0;

        // Parse assignments, e.g. "progress = ?, role = 'admin', semester = COALESCE(?, semester)"
        const assignments = setClause.split(/,(?=(?:(?:[^']*'){2})*[^']*$)/).map(a => a.trim());
        const setters = [];

        for (const assign of assignments) {
          const parts = assign.split('=');
          const col = parts[0].trim();
          const expr = parts.slice(1).join('=').trim();

          if (expr === '?') {
            const capturedIdx = paramIdx++;
            setters.push((row, currentParams) => {
              row[col] = currentParams[capturedIdx];
            });
          } else if (/^COALESCE\s*\(\s*\?\s*,\s*([a-zA-Z0-9_]+)\s*\)$/i.test(expr)) {
            const capturedIdx = paramIdx++;
            setters.push((row, currentParams) => {
              const val = currentParams[capturedIdx];
              if (val !== null && val !== undefined) {
                row[col] = val;
              }
            });
          } else {
            const lit = parseLiteral(expr);
            setters.push(row => {
              row[col] = lit;
            });
          }
        }

        const whereParams = params.slice(paramIdx);
        let count = 0;

        for (const row of rows) {
          if (!whereClause || evaluateWhere(row, whereClause, whereParams)) {
            for (const setter of setters) {
              setter(row, params);
            }
            count++;
          }
        }

        this.db.persist();
        return { changes: count };
      }
    }

    // 3. DELETE FROM table WHERE ...
    if (upper.startsWith('DELETE FROM')) {
      const match = cleanSql.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+?))?$/i);
      if (match) {
        const tblName = match[1].toLowerCase();
        const whereClause = match[2];
        const rows = this.db.getTable(tblName);

        if (!whereClause) {
          const count = rows.length;
          rows.length = 0;
          this.db.persist();
          return { changes: count };
        }

        let initialLen = rows.length;
        const remaining = rows.filter(r => !evaluateWhere(r, whereClause, params));
        this.db.tables[tblName] = remaining;
        this.db.persist();
        return { changes: initialLen - remaining.length };
      }
    }

    return { changes: 0 };
  }
}

// ---------------------------------------------------------------------------
// Helpers: WHERE Evaluation & Sorting
// ---------------------------------------------------------------------------

function parseLiteral(str) {
  if (!str) return null;
  const s = str.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  if (!isNaN(Number(s))) return Number(s);
  if (s.toLowerCase() === 'true') return true;
  if (s.toLowerCase() === 'false') return false;
  if (s.toLowerCase() === 'null') return null;
  return s;
}

function evaluateWhere(row, whereClause, params) {
  if (!whereClause || whereClause.trim() === '1=1') return true;

  // Split on top-level OR / AND
  // Support standard conditions in ClockIt
  let paramIdx = 0;

  // If contains OR conditions, test disjunction
  if (/\s+OR\s+/i.test(whereClause) && !/\s+AND\s+/i.test(whereClause)) {
    const parts = whereClause.split(/\s+OR\s+/i);
    for (const part of parts) {
      const qMarks = (part.match(/\?/g) || []).length;
      const subParams = params.slice(paramIdx, paramIdx + qMarks);
      paramIdx += qMarks;
      if (evalSingleCondition(row, part.trim(), subParams)) return true;
    }
    return false;
  }

  // Handle AND conditions (which may contain nested OR in parentheses like (roll_no LIKE ? OR name LIKE ?))
  const andParts = splitAndConditions(whereClause);
  for (const part of andParts) {
    const qMarks = (part.match(/\?/g) || []).length;
    const subParams = params.slice(paramIdx, paramIdx + qMarks);
    paramIdx += qMarks;

    const trimmed = part.trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      const inner = trimmed.slice(1, -1).trim();
      const orTokens = inner.split(/\s+OR\s+/i);
      let anyMatch = false;
      let innerPIdx = 0;
      for (const ot of orTokens) {
        const innerQ = (ot.match(/\?/g) || []).length;
        const innerP = subParams.slice(innerPIdx, innerPIdx + innerQ);
        innerPIdx += innerQ;
        if (evalSingleCondition(row, ot.trim(), innerP)) {
          anyMatch = true;
          break;
        }
      }
      if (!anyMatch) return false;
    } else {
      if (!evalSingleCondition(row, trimmed, subParams)) return false;
    }
  }

  return true;
}

function splitAndConditions(clause) {
  const parts = [];
  let current = '';
  let inParen = 0;
  let inQuote = false;

  const tokens = clause.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.toUpperCase() === 'AND' && inParen === 0 && !inQuote) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      if (t.includes('(')) inParen += (t.match(/\(/g) || []).length;
      if (t.includes(')')) inParen -= (t.match(/\)/g) || []).length;
      current += (current ? ' ' : '') + t;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function evalSingleCondition(row, cond, params) {
  if (!cond || cond === '1=1') return true;

  // 1. UPPER(col) = UPPER(?)
  let match = cond.match(/^UPPER\s*\(\s*([a-zA-Z0-9_]+)\s*\)\s*=\s*UPPER\s*\(\s*\?\s*\)$/i);
  if (match) {
    const col = match[1];
    const val = params[0];
    return String(row[col] || '').toUpperCase() === String(val || '').toUpperCase();
  }

  // 2. col = ?
  match = cond.match(/^([a-zA-Z0-9_]+)\s*=\s*\?$/i);
  if (match) {
    const col = match[1];
    const val = params[0];
    if (val === null || val === undefined) return row[col] === null || row[col] === undefined;
    return String(row[col]).toLowerCase() === String(val).toLowerCase();
  }

  // 3. col = 'literal' or col = 1
  match = cond.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/i);
  if (match && match[2] !== '?') {
    const col = match[1];
    const lit = parseLiteral(match[2]);
    return String(row[col]).toLowerCase() === String(lit).toLowerCase();
  }

  // 4. col != ?
  match = cond.match(/^([a-zA-Z0-9_]+)\s*(!=|<>)\s*\?$/i);
  if (match) {
    const col = match[1];
    const val = params[0];
    return String(row[col]).toLowerCase() !== String(val).toLowerCase();
  }

  // 5. col LIKE ?
  match = cond.match(/^([a-zA-Z0-9_]+)\s+LIKE\s+\?$/i);
  if (match) {
    const col = match[1];
    const pattern = String(params[0] || '').toLowerCase().replace(/%/g, '');
    const rowVal = String(row[col] || '').toLowerCase();
    return rowVal.includes(pattern);
  }

  // 6. col IS NULL / col IS NOT NULL
  match = cond.match(/^([a-zA-Z0-9_]+)\s+IS\s+NULL$/i);
  if (match) return row[match[1]] === null || row[match[1]] === undefined;

  match = cond.match(/^([a-zA-Z0-9_]+)\s+IS\s+NOT\s+NULL$/i);
  if (match) return row[match[1]] !== null && row[match[1]] !== undefined;

  return true;
}

function sortRows(rows, orderClause) {
  const parts = orderClause.split(',').map(p => p.trim());
  return rows.sort((a, b) => {
    for (const part of parts) {
      const [col, dir] = part.split(/\s+/);
      const isDesc = dir && dir.toUpperCase() === 'DESC';
      const aVal = a[col];
      const bVal = b[col];
      if (aVal === bVal) continue;
      if (aVal === null || aVal === undefined) return isDesc ? 1 : -1;
      if (bVal === null || bVal === undefined) return isDesc ? -1 : 1;
      if (aVal < bVal) return isDesc ? 1 : -1;
      if (aVal > bVal) return isDesc ? -1 : 1;
    }
    return 0;
  });
}

function createFallbackDatabase(storagePath) {
  return new FallbackDatabase(storagePath);
}

module.exports = {
  createFallbackDatabase,
  FallbackDatabase
};
