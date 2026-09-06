const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, exec, execSync, execFile } = require('child_process');

const PORT = process.env.PORT || 8086;
const ROOT = __dirname;
const TOOLCHAIN = path.join(ROOT, 'afd-toolchain');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function getDosboxPath() {
  const candidates = [
    process.env.DOSBOX_PATH,
    'C:\\Program Files (x86)\\DOSBox-0.74-3\\DOSBox.exe',
    'C:\\Program Files\\DOSBox-0.74-3\\DOSBox.exe',
    'C:\\Program Files (x86)\\DOSBox-0.74\\DOSBox.exe',
    'C:\\Program Files\\DOSBox-0.74\\DOSBox.exe',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function prepareNasmCode(raw) {
  const lines = raw.split(/\r?\n/);
  const dataLines = [];
  const codeLines = [];
  let inData = false;
  let hasOrg = false;

  for (let line of lines) {
    const trimmed = line.trim();
    if (/^(org\s+100h|\[org\s+0x100\]|\[org\s+100h\])/i.test(trimmed)) {
      hasOrg = true;
    }

    // Skip MASM-specific directives
    if (/^\.(model|stack|386|486|586|assume)\b/i.test(trimmed) ||
        /^(model|assume)\b/i.test(trimmed) ||
        /^\w+\s+(segment|ends|proc|endp)\b/i.test(trimmed) ||
        /^(end|proc|endp)\b/i.test(trimmed)) {
      continue;
    }

    // Convert DUP to NASM times syntax:  var DW 5 DUP (?) -> var: times 5 dw 0
    line = line.replace(/(\w+)\s+(DB|DW)\s+(\d+)\s+DUP\s*\((.+)\)/i, (m, name, type, count, val) => {
      const t = type.toLowerCase();
      const v = val.trim() === '?' ? '0' : val.trim();
      return `${name}: times ${count} ${t} ${v}`;
    });

    if (/^\.data\b/i.test(trimmed)) {
      inData = true;
      continue;
    }
    if (/^\.code\b/i.test(trimmed)) {
      inData = false;
      continue;
    }

    if (inData) {
      dataLines.push(line);
    } else {
      codeLines.push(line);
    }
  }

  // If already has org or no .data separation:
  if (hasOrg || (dataLines.length === 0 && codeLines.length > 0)) {
    let result = lines.filter(l => !/^\.(model|stack|assume)\b/i.test(l.trim())).join('\n');
    if (!hasOrg) {
      result = '[org 0x100]\n' + result;
    }
    return result;
  }

  // If data was specified before code, jump around data to __start__
  let out = '[org 0x100]\n';
  if (dataLines.length > 0) {
    out += 'jmp __start__\n';
    out += '; --- Data Section ---\n' + dataLines.join('\n') + '\n';
    out += '__start__:\n';
    out += '; --- Code Section ---\n' + codeLines.join('\n') + '\n';
  } else {
    out += codeLines.join('\n') + '\n';
  }
  return out;
}

function compileAndRunDosbox(code, res) {
  const dosbox = getDosboxPath();
  if (!dosbox) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'DOSBox executable not found. Please install DOSBox or set DOSBOX_PATH.' }));
    return;
  }

  const nasmCode = prepareNasmCode(code);
  const asmPath = path.join(TOOLCHAIN, 'USERPROG.ASM');
  const comPath = path.join(TOOLCHAIN, 'USERPROG.COM');
  const errPath = path.join(TOOLCHAIN, 'USERPROG.ERR');
  const compileConf = path.join(TOOLCHAIN, 'compile.conf');
  const runConf = path.join(TOOLCHAIN, 'run_afd.conf');

  fs.writeFileSync(asmPath, nasmCode, 'utf8');
  try { if (fs.existsSync(comPath)) fs.unlinkSync(comPath); } catch (_) {}
  try { if (fs.existsSync(errPath)) fs.unlinkSync(errPath); } catch (_) {}

  // 1. Headless compile config
  const compileConfContent = [
    '[sdl]',
    'fullscreen=false',
    'autolock=false',
    '[autoexec]',
    'mount c "' + TOOLCHAIN + '"',
    'c:',
    'nasm.exe USERPROG.ASM -fbin -o USERPROG.COM -EUSERPROG.ERR',
    'exit'
  ].join('\n') + '\n';
  fs.writeFileSync(compileConf, compileConfContent, 'utf8');

  try {
    execFileSync(dosbox, ['-conf', compileConf, '-noconsole'], { timeout: 15000 });
  } catch (err) {
    // Check errPath below
  }

  const errText = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8').trim() : '';
  const success = fs.existsSync(comPath);

  if (!success || (errText && errText.includes('error:'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: errText || 'NASM assembly failed to generate USERPROG.COM',
      preparedCode: nasmCode
    }));
    return;
  }

  // 2. Interactive run config
  const runConfContent = [
    '[sdl]',
    'fullscreen=false',
    'autolock=false',
    'windowresolution=1024x768',
    'output=surface',
    '[autoexec]',
    'mount c "' + TOOLCHAIN + '"',
    'c:',
    'cls',
    'afd.exe USERPROG.COM'
  ].join('\n') + '\n';
  fs.writeFileSync(runConf, runConfContent, 'utf8');

  // Launch DOSBox via dedicated interactive PowerShell launcher
  // This guarantees an active, visible desktop window with non-zero HWND in the interactive user session.
  const ps1Path = path.join(TOOLCHAIN, 'launch_interactive.ps1');
  execFile('powershell.exe', [
    '-ExecutionPolicy', 'Bypass',
    '-NoProfile',
    '-File', ps1Path,
    dosbox,
    runConf
  ], (err, stdout, stderr) => {
    if (err) console.error('DOSBox launch error:', err);
    if (stdout) console.log('DOSBox launch stdout:', stdout.trim());
    if (stderr) console.error('DOSBox launch stderr:', stderr.trim());
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    message: 'Compiled successfully! Real AFD is now open in DOSBox.',
    preparedCode: nasmCode
  }));
}

const server = http.createServer((req, res) => {
  // Handle API routes
  if (req.method === 'POST' && req.url === '/api/run-dosbox') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
        return;
      }
      try {
        compileAndRunDosbox(data.code || '', res);
      } catch (err) {
        console.error('Execution error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/dosbox-status') {
    const p = getDosboxPath();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !!p, path: p }));
    return;
  }

  // Static file serving
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, reqPath));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/ (DOSBox bridge enabled)`);
});
