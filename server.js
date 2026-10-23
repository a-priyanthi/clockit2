const app = require('./src/app');
const config = require('./src/config');
const { initDatabase } = require('./src/config/db');
const { seedDatabase, seedAcademicClock } = require('./src/config/seed');
const { seedAllMitStudents, seedAllMitStudentsSync } = require('./src/config/seed_all_mit_students');
const { seedAllMitCurricula, seedAllMitCurriculaSync } = require('./src/config/seed_all_mit_curricula');
const { extractAllDetailedSyllabi } = require('./src/config/extract_all_detailed_syllabi');

// Initialize database schema and seed defaults synchronously from pre-bundled datasets
initDatabase();
seedDatabase();
seedAcademicClock();
seedAllMitStudentsSync();
seedAllMitCurriculaSync();

// Optional background syllabus re-extraction only if explicitly requested
if (process.env.RE_EXTRACT_SYLLABI === 'true') {
  seedAllMitStudents().catch(e => console.error('[MIT Roster Init Error]:', e.message));
  seedAllMitCurricula().then(() => extractAllDetailedSyllabi()).catch(e => console.error('[MIT Curricula Init Error]:', e.message));
}

// Start Express Server
const server = app.listen(config.PORT, () => {
  console.log(`=================================================`);
  console.log(`⚡ ClockIt Academic Student Workspace Server`);
  console.log(`⚡ URL: http://localhost:${config.PORT}`);
  console.log(`⚡ Environment: ${config.NODE_ENV}`);
  console.log(`⚡ Database: ${config.DB_PATH}`);
  console.log(`⚡ Uploads: ${config.UPLOAD_DIR}`);
  console.log(`=================================================`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ [ClockIt] Port ${config.PORT} is already in use by another running instance.`);
    console.error(`👉 Either use the already running server at http://localhost:${config.PORT}, or stop the running process before starting a new one.\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
  }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
