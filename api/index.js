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
      seedAcademicClock();
    } catch (err) {
      console.warn('Vercel serverless database initialization notice:', err.message);
    }
    isInitialized = true;
  }
}

function normalizeRequestUrl(req) {
  // If req.url already has the subpath (e.g. /api/academic/...), nothing to rewrite
  if (req.url && req.url.startsWith('/api/') && !req.url.startsWith('/api?') && !req.url.startsWith('/api/index.js')) {
    return;
  }

  let targetPath = null;

  // 1. Check if req.query has catch-all path or slug parameter
  if (req.query && (req.query.path || req.query.slug)) {
    const raw = req.query.path || req.query.slug;
    targetPath = Array.isArray(raw) ? raw.join('/') : raw;
  }

  // 2. Check if rewrite added ?path=... or &path=...
  if (!targetPath && req.url && (req.url.includes('path=') || req.url.includes('?path='))) {
    try {
      const u = new URL(req.url, 'http://localhost');
      targetPath = u.searchParams.get('path');
      u.searchParams.delete('path');
      const cleanSearch = u.search ? u.search : '';
      if (targetPath) {
        req.url = '/api/' + targetPath.replace(/^\//, '') + cleanSearch;
        req.originalUrl = req.url;
        return;
      }
    } catch (e) {}
  }

  // 3. Check Vercel routing headers
  if (!targetPath) {
    const orig = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-original-url'] || req.headers['x-vercel-matched-path'];
    if (orig && orig !== '/api' && orig !== '/api/' && orig !== '/api/index.js' && orig.startsWith('/api/')) {
      targetPath = orig.replace(/^\/api\//, '');
    }
  }

  if (targetPath) {
    const cleanSearch = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    req.url = '/api/' + targetPath.replace(/^\//, '') + cleanSearch;
    req.originalUrl = req.url;
  }
}

// Export serverless handler for Vercel
module.exports = (req, res) => {
  ensureInitialized();
  normalizeRequestUrl(req);
  return app(req, res);
};
