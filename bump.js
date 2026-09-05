#!/usr/bin/env node
// Stamps app.js / styles.css references in index.html with a fresh ?v= so browsers (and GitHub Pages'
// 10-minute cache) cannot serve a stale script alongside a new page. Run before committing: npm run bump
const fs = require('fs');
const v = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12); // YYYYMMDDHHMM
const html = fs.readFileSync('index.html', 'utf8')
  .replace(/href="styles\.css(\?v=[^"]*)?"/, `href="styles.css?v=${v}"`)
  .replace(/src="app\.js(\?v=[^"]*)?"/, `src="app.js?v=${v}"`);
fs.writeFileSync('index.html', html);
console.log(`index.html now references app.js?v=${v} and styles.css?v=${v}`);
