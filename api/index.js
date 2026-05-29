// Vercel serverless entry point.
//
// Vercel's static hosting doesn't run server.js on its own, so this file exposes
// the Express app in server.js as a serverless function. vercel.json routes every
// /api/* request here; the HTML/static files are still served directly by Vercel.
//
// An Express app is itself a valid (req, res) handler, so we can export it as-is.
module.exports = require('../server.js');
