const app = require('./app');

// Never let one failed promise take the whole server down.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException',  (err) => console.error('Uncaught exception:', err));

// On Vercel the app is imported by api/index.js; elsewhere (Render, local) we listen.
if (require.main === module) {
  const port = process.env.PORT || 5000;
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;
