// ================================================================
//  Engine test runner  —  node tests/run.js  [filter]
//  Loads every tests/cases/*.cases.js, runs each case against the
//  headless engine exported by app.js, and reports pass/fail.
//
//  CASE SCHEMA (one object per test; only `name` + `code` required):
//  {
//    name:   "ADD AL: 0F + 1 sets AF",        // unique-ish label
//    code:   "MOV AL,0Fh\nADD AL,1\nHLT",     // 8086 asm our parser accepts
//    regs:   { AL:0x10, AX:0x0010 },           // expected register values
//    flags:  { AF:1, CF:0, ZF:0, OF:0 },       // expected flag bits (0/1)
//    output: "Hello, World!",                  // exact INT-21h output string
//    mem:    [ {addr:0x0200, size:16, val:1} ],// expected memory words/bytes
//    maxSteps: 200000,                         // optional step cap
//    expectError: true                         // optional: parse/runtime error expected
//  }
//  Only assert flags/regs that are DEFINED by the 8086 spec for that
//  instruction — omit "undefined" results (e.g. SF/ZF/AF/PF after MUL).
// ================================================================
'use strict';
const fs   = require('fs');
const path = require('path');
const { CPU, Parser, Executor } = require('../app.js');

function execute(code, maxSteps = 300000, input) {
  const cpu = new CPU();
  if (input !== undefined) cpu.inputBuffer = [...input].map(ch => ch.charCodeAt(0));
  const parser = new Parser();
  const parsed = parser.parse(code);
  const ex = new Executor(cpu, parsed);
  let steps = 0, error = null;
  try {
    while (!cpu.halted && cpu.ip < ex.instrs.length && steps++ < maxSteps) ex.step();
    if (steps >= maxSteps) error = new Error('step cap exceeded (possible infinite loop)');
  } catch (e) { error = e; }
  return { cpu, ex, parsed, steps, error };
}

const h = (v) => (v < 0 ? v >>> 0 : v).toString(16).toUpperCase();

function checkCase(c) {
  const res = execute(c.code, c.maxSteps, c.input);
  const problems = [];

  if (c.expectError) {
    if (!res.error && res.parsed.errors.length === 0)
      problems.push('expected a parse/runtime error, but none occurred');
    return problems;
  }

  if (res.parsed.errors.length)
    problems.push('parse errors: ' + res.parsed.errors.map(e => e.message).join(' | '));
  if (res.error)
    problems.push('runtime error: ' + res.error.message);

  for (const [r, exp] of Object.entries(c.regs || {})) {
    const got = res.cpu.getReg(r);
    if (got !== (exp & (['AL','AH','BL','BH','CL','CH','DL','DH'].includes(r.toUpperCase()) ? 0xFF : 0xFFFF)))
      problems.push(`reg ${r}: got ${h(got)} expected ${h(exp)}`);
  }
  for (const [f, exp] of Object.entries(c.flags || {})) {
    const got = res.cpu.flags[f];
    if (got !== exp) problems.push(`flag ${f}: got ${got} expected ${exp}`);
  }
  if (c.output !== undefined) {
    const got = res.ex.output.join('');
    if (got !== c.output) problems.push(`output: got ${JSON.stringify(got)} expected ${JSON.stringify(c.output)}`);
  }
  for (const m of c.mem || []) {
    const got = res.cpu.memRead(m.addr, m.size || 16);
    if (got !== m.val) problems.push(`mem[${h(m.addr)}/${m.size||16}]: got ${h(got)} expected ${h(m.val)}`);
  }
  return problems;
}

// ── Load case files ──
const dir = path.join(__dirname, 'cases');
const filter = process.argv[2] || '';
let files = [];
try { files = fs.readdirSync(dir).filter(f => f.endsWith('.cases.js')).sort(); }
catch { console.error('No tests/cases directory yet.'); process.exit(1); }

let total = 0, passed = 0;
const allFails = [];
const byFile = [];

for (const file of files) {
  let cases;
  try { cases = require(path.join(dir, file)); }
  catch (e) { console.error(`!! failed to load ${file}: ${e.message}`); continue; }
  if (!Array.isArray(cases)) { console.error(`!! ${file} did not export an array`); continue; }
  let fPass = 0, fTotal = 0;
  for (const c of cases) {
    if (filter && !(`${file} ${c.name}`).toLowerCase().includes(filter.toLowerCase())) continue;
    total++; fTotal++;
    const problems = checkCase(c);
    if (problems.length === 0) { passed++; fPass++; }
    else allFails.push({ file, name: c.name, problems });
  }
  if (fTotal) byFile.push(`  ${file.padEnd(28)} ${fPass}/${fTotal}`);
}

console.log('\n── Engine test results ──');
console.log(byFile.join('\n'));
if (allFails.length) {
  console.log(`\n✗ ${allFails.length} FAILED:`);
  for (const f of allFails) {
    console.log(`\n  [${f.file}] ${f.name}`);
    for (const p of f.problems) console.log(`      - ${p}`);
  }
}
console.log(`\n${passed === total ? '✓' : '✗'} ${passed}/${total} passed${total ? ` (${(100*passed/total).toFixed(1)}%)` : ''}\n`);
process.exit(passed === total ? 0 : 1);
