const app = require('../src/app');
const { initDatabase } = require('../src/config/db');
const { seedDatabase, seedAcademicClock } = require('../src/config/seed');
const { seedAllMitStudentsSync } = require('../src/config/seed_all_mit_students');
const { seedAllMitCurriculaSync } = require('../src/config/seed_all_mit_curricula');

let isInitialized = false;

function ensureInitialized() {
  if (!isInitialized) {
    try {
      initDatabase();
      seedDatabase(true);
      seedAcademicClock();
      seedAllMitStudentsSync();
      seedAllMitCurriculaSync();
    } catch (err) {
      console.warn('Vercel serverless database initialization notice:', err.message);
    }
    isInitialized = true;
  }
}

function normalizeRequestUrl(req) {
  // 1. If req.query.slug is present (from api/[...slug].js catch-all)
  if (req.query && req.query.slug) {
    const slug = Array.isArray(req.query.slug) ? req.query.slug.join('/') : req.query.slug;
    const qIndex = req.url ? req.url.indexOf('?') : -1;
    const cleanSearch = qIndex !== -1 ? req.url.slice(qIndex) : '';
    req.url = '/api/' + String(slug).replace(/^\//, '') + cleanSearch;
    req.originalUrl = req.url;
    return;
  }

  // 2. If req.query.path is present (from vercel.json rewrite ?path=$1)
  if (req.query && req.query.path) {
    const p = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
    const qIndex = req.url ? req.url.indexOf('?') : -1;
    const cleanSearch = qIndex !== -1 ? req.url.slice(qIndex) : '';
    req.url = '/api/' + String(p).replace(/^\//, '') + cleanSearch;
    req.originalUrl = req.url;
    return;
  }

  // 3. If req.url already has the subpath (e.g. /api/academic/...), nothing to rewrite
  if (req.url && req.url.startsWith('/api/') && !req.url.startsWith('/api?') && !req.url.startsWith('/api/index.js')) {
    return;
  }

  // 4. Check Vercel routing headers
  const orig = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-original-url'] || req.headers['x-vercel-matched-path'];
  if (orig && orig.startsWith('/api/') && orig !== '/api' && orig !== '/api/' && orig !== '/api/index.js') {
    const qIndex = req.url ? req.url.indexOf('?') : -1;
    const cleanSearch = (qIndex !== -1 && !orig.includes('?')) ? req.url.slice(qIndex) : '';
    req.url = orig + cleanSearch;
    req.originalUrl = req.url;
  }
}

// Export serverless handler for Vercel
module.exports = (req, res) => {
  ensureInitialized();
  normalizeRequestUrl(req);
  return app(req, res);
};
