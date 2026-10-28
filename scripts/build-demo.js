// Copies public/ into docs/ for GitHub Pages and switches it to demo mode (data stays in each visitor's browser).
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), src = path.join(root, "public"), out = path.join(root, "docs");
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
fs.writeFileSync(path.join(out, "config.js"), 'window.PLK_CONFIG={mode:"demo"};\n');
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log("demo written to docs/ — enable GitHub Pages from the /docs folder of the main branch");
