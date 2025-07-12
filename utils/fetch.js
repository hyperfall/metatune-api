// utils/fetch.js

// Dynamically import node-fetch (ESM) into CommonJS
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

module.exports = fetch;
