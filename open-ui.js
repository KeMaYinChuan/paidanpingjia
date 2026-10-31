'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { uiScript } = require('./ego-driver');

const address = process.argv[2] || 'http://127.0.0.1:4321';
const runDir = path.join(__dirname, 'data', 'ego-runs');
fs.mkdirSync(runDir, { recursive: true });
const space = `paidan-ui-${Date.now()}`;
const scriptPath = path.join(runDir, `${space}.mjs`);
fs.writeFileSync(scriptPath, uiScript({ space, url: address }));

const ego = process.env.EGO_BROWSER || 'ego-browser';
const child = spawn(
  ego,
  ['nodejs', '-e', `await import(${JSON.stringify(`file:///${scriptPath.replace(/\\/g, '/')}`)})`],
  { detached: true, stdio: 'ignore', windowsHide: true },
);
child.unref();
