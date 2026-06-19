// Headless smoke test for afd.js — runs the real AfdScreen against a tiny DOM
// stub so we can verify assemble→step→command→render without a browser.
//   node tests/afd_smoke.js
'use strict';
const fs = require('fs');
const path = require('path');

// Expose the engine classes as globals (afd.js expects them on the global scope).
const eng = require('../app.js');
global.CPU = eng.CPU; global.Parser = eng.Parser; global.Executor = eng.Executor;

// Minimal DOM/Window stubs.
const mkEl = () => ({ hidden: false, clientWidth: 1200, clientHeight: 800, style: {}, innerHTML: '', value: '', addEventListener() {}, focus() {}, blur() {} });
const editor = mkEl();
editor.value = '.data\nmsg DB "Hi$"\n.code\nMOV AX,5\nMOV BX,3\nADD AX,BX\nMOV AH,9\nMOV DX,msg\nINT 21h\nHLT';
const els = { 'afd-root': mkEl(), 'afd-screen': mkEl(), 'editor': editor, 'btn-afd': mkEl() };
let domReady = null;
global.document = { getElementById: id => els[id] || null, addEventListener: (ev, cb) => { if (ev === 'DOMContentLoaded') domReady = cb; }, activeElement: null };
global.window = { addEventListener() {}, _app: null };

// Load and boot afd.js.
eval(fs.readFileSync(path.join(__dirname, '..', 'afd.js'), 'utf8'));
domReady();
const afd = global.window._afd;

const plain = () => els['afd-screen'].innerHTML.replace(/<[^>]+>/g, '');
let fails = 0;
const ok = (cond, label) => { console.log((cond ? '  ok   ' : '  FAIL ') + label); if (!cond) fails++; };

afd.open();
ok(els['afd-root'].hidden === false, 'open() shows the AFD root');
ok(plain().includes('Registers'), 'renders the Registers region');
ok(plain().includes('Code'), 'renders the Code region');
ok(plain().includes('CS:0100'), 'code window lists CS:0100');
ok(plain().includes('m1') && plain().includes('m2'), 'renders both memory windows');

afd.trace(3);                                   // MOV AX,5 ; MOV BX,3 ; ADD AX,BX
ok(afd.cpu.getReg('AX') === 8, 'after 3 steps AX = 8 (5+3)');

afd.cmd = 'BX=20'; afd._runCmd();               // AFD-style register edit
ok(afd.cpu.getReg('BX') === 0x20, 'command "BX=20" sets BX=0x20');

afd.cmd = 'CF=1'; afd._runCmd();
ok(afd.cpu.flags.CF === 1, 'command "CF=1" sets the carry flag');

afd.cmd = 'm1 0200'; afd._runCmd();             // point window 1 at the data
ok(plain().includes('48 69 24'), 'm1 shows "Hi$" bytes (48 69 24) at DS:0200');

afd.go();                                       // run to completion
ok(afd.cpu.halted, 'go() runs the program to HLT');
afd._syncOut();
ok(afd.ex.output.join('').includes('Hi'), 'INT 21h/09h printed "Hi"');

afd.back();                                     // step-back history
ok(typeof els['afd-screen'].innerHTML === 'string' && els['afd-screen'].innerHTML.length > 0, 'back() re-renders without error');

console.log(`\n${fails === 0 ? '✓ AFD smoke PASSED' : '✗ ' + fails + ' AFD checks FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
