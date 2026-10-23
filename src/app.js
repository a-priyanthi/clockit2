const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Global Middleware
app.use(cors());
app.use((req, res, next) => {
  // 1. Check if rewrite added ?path=... or &path=...
  if (req.url && (req.url.includes('path=') || req.url.includes('?path='))) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const targetPath = u.searchParams.get('path');
      u.searchParams.delete('path');
      const cleanSearch = u.search ? u.search : '';
      if (targetPath) {
        req.url = '/api/' + targetPath.replace(/^\//, '') + cleanSearch;
        req.originalUrl = req.url;
        return next();
      }
    } catch (e) {}
  }

  // 2. Check Vercel routing headers
  const orig = req.headers['x-matched-path'] || req.headers['x-forwarded-uri'] || req.headers['x-original-url'] || req.headers['x-vercel-matched-path'];
  if (orig && orig !== '/api' && orig !== '/api/' && orig !== '/api/index.js' && orig.startsWith('/api/')) {
    const qIdx = req.url.indexOf('?');
    const qPart = (qIdx !== -1 && !orig.includes('?')) ? req.url.slice(qIdx) : '';
    req.url = orig + qPart;
    req.originalUrl = req.url;
  }
  next();
});
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Serve frontend static assets
app.use(express.static(config.PUBLIC_DIR));

// Serve uploaded user files securely
app.use('/uploads', express.static(config.UPLOAD_DIR));

const academicRoutes = require('./routes/academicRoutes');

// Mount REST API (support all prefix variations across local & serverless cloud environments)
app.use('/api/academic', academicRoutes);
app.use('/academic', academicRoutes);
app.use('/api', academicRoutes);
app.use('/api', apiRoutes);
app.use(apiRoutes);

// Root route fallback to serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(config.PUBLIC_DIR, 'index.html'));
});

// Catch unknown API requests
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

module.exports = app;
