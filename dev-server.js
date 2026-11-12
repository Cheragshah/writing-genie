'use strict';

const app = require('./app');

const PORT = process.env.PORT || 4173;

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  ✨ Writing Genie is awake at http://localhost:${PORT}\n`);
});
