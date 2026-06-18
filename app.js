// ================================================================
//  Assembly Dry Run Tool — 8086 Interpreter
//  Supports: MOV, ADD, SUB, MUL, DIV, INC, DEC, NEG, AND, OR,
//            XOR, NOT, CMP, TEST, SHL, SHR, SAR, ROL, ROR,
//            PUSH, POP, CALL, RET, JMP + all conditionals,
//            LOOP, INT 21h (output), HLT, NOP, CBW, CWD, XCHG,
//            LEA, .DATA / .CODE / DB / DW directives
// ================================================================

'use strict';

// ── CPU State ──────────────────────────────────────────────────
class CPU {
  constructor() { this.reset(); }

  reset() {
    this.regs  = { AX:0, BX:0, CX:0, DX:0, SI:0, DI:0, SP:0xFFFE, BP:0, CS:0, DS:0, ES:0, SS:0 };
    this.flags = { OF:0, DF:0, IF:1, TF:0, SF:0, ZF:0, AF:0, PF:0, CF:0 };
    this.mem   = new Uint8Array(65536);
    this.ports = new Uint8Array(65536);   // simulated I/O port space (IN/OUT)
    this.inputBuffer = [];                 // queued keyboard input (char codes)
    this.ip    = 0;
    this.halted = false;
  }

  snapshot() {
    return {
      regs:   { ...this.regs },
      flags:  { ...this.flags },
      mem:    this.mem.slice(),
      ports:  this.ports.slice(),
      inputBuffer: this.inputBuffer.slice(),
      ip:     this.ip,
      halted: this.halted,
    };
  }

  restore(snap) {
    this.regs   = { ...snap.regs };
    this.flags  = { ...snap.flags };
    this.mem    = snap.mem.slice();
    if (snap.ports)       this.ports = snap.ports.slice();
    if (snap.inputBuffer) this.inputBuffer = snap.inputBuffer.slice();
    this.ip     = snap.ip;
    this.halted = snap.halted;
  }

  // ── Register accessors ──
  static REG8  = ['AL','AH','BL','BH','CL','CH','DL','DH'];
  static REG16 = ['AX','BX','CX','DX','SI','DI','SP','BP'];
  static SEG   = ['CS','DS','ES','SS'];

  isReg(n)  { n = n.toUpperCase(); return CPU.REG8.includes(n) || CPU.REG16.includes(n) || CPU.SEG.includes(n); }
  isReg8(n) { return CPU.REG8.includes(n.toUpperCase()); }
  isReg16(n){ n = n.toUpperCase(); return CPU.REG16.includes(n) || CPU.SEG.includes(n); }
  regSize(n){ return this.isReg8(n) ? 8 : 16; }

  getReg(n) {
    switch (n.toUpperCase()) {
      case 'AL': return  this.regs.AX & 0xFF;
      case 'AH': return (this.regs.AX >> 8) & 0xFF;
      case 'BL': return  this.regs.BX & 0xFF;
      case 'BH': return (this.regs.BX >> 8) & 0xFF;
      case 'CL': return  this.regs.CX & 0xFF;
      case 'CH': return (this.regs.CX >> 8) & 0xFF;
      case 'DL': return  this.regs.DX & 0xFF;
      case 'DH': return (this.regs.DX >> 8) & 0xFF;
      default:   return this.regs[n.toUpperCase()] ?? null;
    }
  }

  setReg(n, v) {
    switch (n.toUpperCase()) {
      case 'AL': this.regs.AX = (this.regs.AX & 0xFF00) | (v & 0xFF);         return;
      case 'AH': this.regs.AX = (this.regs.AX & 0x00FF) | ((v & 0xFF) << 8);  return;
      case 'BL': this.regs.BX = (this.regs.BX & 0xFF00) | (v & 0xFF);         return;
      case 'BH': this.regs.BX = (this.regs.BX & 0x00FF) | ((v & 0xFF) << 8);  return;
      case 'CL': this.regs.CX = (this.regs.CX & 0xFF00) | (v & 0xFF);         return;
      case 'CH': this.regs.CX = (this.regs.CX & 0x00FF) | ((v & 0xFF) << 8);  return;
      case 'DL': this.regs.DX = (this.regs.DX & 0xFF00) | (v & 0xFF);         return;
      case 'DH': this.regs.DX = (this.regs.DX & 0x00FF) | ((v & 0xFF) << 8);  return;
      default:
        if (n.toUpperCase() in this.regs) this.regs[n.toUpperCase()] = v & 0xFFFF;
    }
  }

  // ── Flags ──
  updateFlags(result, size, kind, a, b) {
    const mask    = size === 8 ? 0xFF : 0xFFFF;
    const signBit = size === 8 ? 0x80 : 0x8000;
    const res     = ((result % 0x10000) + 0x10000) % 0x10000 & mask;

    this.flags.ZF = res === 0 ? 1 : 0;
    this.flags.SF = (res & signBit) ? 1 : 0;

    // Parity of low byte
    let p = res & 0xFF;
    p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
    this.flags.PF = (~p & 1);

    if (kind === 'ADD') {
      this.flags.CF = result > mask ? 1 : 0;
      this.flags.AF = ((a ^ b ^ result) & 0x10) ? 1 : 0;
      const sa = a & signBit, sb = b & signBit, sr = res & signBit;
      this.flags.OF = (sa === sb && sr !== sa) ? 1 : 0;
    } else if (kind === 'SUB') {
      this.flags.CF = a < b ? 1 : 0;
      this.flags.AF = ((a ^ b ^ result) & 0x10) ? 1 : 0;
      const sa = a & signBit, sb = b & signBit, sr = res & signBit;
      this.flags.OF = (sa !== sb && sr !== sa) ? 1 : 0;
    } else {
      this.flags.CF = 0;
      this.flags.OF = 0;
      this.flags.AF = 0;
    }
  }

  // ── Memory ──
  memRead(addr, size = 16) {
    addr &= 0xFFFF;
    return size === 8 ? this.mem[addr] : (this.mem[addr] | (this.mem[(addr + 1) & 0xFFFF] << 8));
  }
  memWrite(addr, val, size = 16) {
    addr &= 0xFFFF;
    if (size === 8) {
      this.mem[addr] = val & 0xFF;
    } else {
      this.mem[addr]              = val & 0xFF;
      this.mem[(addr + 1) & 0xFFFF] = (val >> 8) & 0xFF;
    }
  }

  // ── Stack ──
  push(val) {
    this.regs.SP = (this.regs.SP - 2) & 0xFFFF;
    this.memWrite(this.regs.SP, val, 16);
  }
  pop() {
    const val = this.memRead(this.regs.SP, 16);
    this.regs.SP = (this.regs.SP + 2) & 0xFFFF;
    return val;
  }
}

// ── Parser ─────────────────────────────────────────────────────
class Parser {
  parse(code) {
    this.instrs  = [];
    this.labels  = {};
    this.vars    = {};
    this.errors  = [];
    this._nextAddr = 0x0200;

    const lines = code.split('\n');
    let inData = false;
    let idx    = 0;

    // Pass 1: labels + variables
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/;.*$/, '').trim();
      if (!stripped) continue;

      if (this._isSegDir(stripped, 'DATA'))  { inData = true;  continue; }
      if (this._isSegDir(stripped, 'CODE'))  { inData = false; continue; }

      let rest = stripped;

      // Label — peel BEFORE skip-line check so labels named like directives
      // (end:, proc:, code:) are still registered, not swallowed.
      const lm = rest.match(/^(\w+):\s*(.*)/);
      if (lm) {
        const lname = lm[1].toUpperCase();
        if (!inData) this.labels[lname] = idx;
        rest = lm[2].trim();
        if (!rest) continue;
      }

      if (this._skipLine(rest)) continue;

      if (inData) {
        this._parseVar(rest, i + 1);
      } else {
        idx++;
      }
    }

    // Pass 2: instructions
    inData = false; idx = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw      = lines[i];
      const stripped = raw.replace(/;.*$/, '').trim();
      if (!stripped) continue;

      if (this._isSegDir(stripped, 'DATA'))  { inData = true;  continue; }
      if (this._isSegDir(stripped, 'CODE'))  { inData = false; continue; }

      let rest = stripped;

      const lm = rest.match(/^(\w+):\s*(.*)/);
      if (lm) { rest = lm[2].trim(); if (!rest) continue; }

      if (this._skipLine(rest)) continue;

      if (inData) continue;

      const instr = this._parseInstr(rest, i + 1, idx);
      if (instr) { this.instrs.push(instr); idx++; }
    }

    return { instrs: this.instrs, labels: this.labels, vars: this.vars, errors: this.errors };
  }

  _isSegDir(s, name) {
    return new RegExp(`^\\.${name}\\b`, 'i').test(s);
  }

  _skipLine(s) {
    return /^\.(MODEL|STACK|ASSUME|TEXT|BSS)\b/i.test(s)
        || /^(ASSUME|MODEL)\b/i.test(s)
        || /^END\b/i.test(s)
        || /^\w+\s+(SEGMENT|ENDS)\b/i.test(s)
        || /^\w+\s+(PROC|ENDP)\b/i.test(s)
        || /^(PROC|ENDP)\b/i.test(s);
  }

  _parseVar(text, lineNum) {
    const m = text.match(/^(\w+)\s+(DB|DW)\s+(.+)/i);
    if (!m) return;
    const name = m[1].toUpperCase();
    const type = m[2].toUpperCase();
    const size = type === 'DB' ? 1 : 2;
    const addr = this._nextAddr;
    let valStr = m[3].trim();

    // String literal DB 'hello', '$'
    if (type === 'DB' && /^['"]/.test(valStr)) {
      const sm = valStr.match(/^['"]([^'"]*)['"](.*)/);
      if (sm) {
        const str   = sm[1];
        const extra = sm[2].replace(/\s*,\s*/, '').trim();
        const bytes = [...str].map(c => c.charCodeAt(0));
        if (extra === '$' || extra === "'$'") bytes.push(0x24);
        else if (extra === '0Dh' || extra === '13') bytes.push(13, 10);
        this.vars[name] = { addr, size: 1, bytes };
        this._nextAddr += bytes.length;
        return;
      }
    }

    // DUP
    const dup = valStr.match(/^(\d+)\s+DUP\s*\((.+)\)/i);
    if (dup) {
      const count = parseInt(dup[1]);
      const val   = dup[2].trim() === '?' ? 0 : (this._parseImm(dup[2].trim()) ?? 0);
      this.vars[name] = { addr, size, count, value: val };
      this._nextAddr += count * size;
      return;
    }

    // Comma list
    const parts = valStr.split(',').map(v => v.trim());
    if (parts.length > 1) {
      const values = parts.map(p => p === '?' ? 0 : (this._parseImm(p) ?? 0));
      this.vars[name] = { addr, size, values };
      this._nextAddr += parts.length * size;
      return;
    }

    const val = valStr === '?' ? 0 : (this._parseImm(valStr) ?? 0);
    this.vars[name] = { addr, size, value: val };
    this._nextAddr += size;
  }

  _parseInstr(text, lineNum, idx) {
    const m = text.match(/^(\w+)\s*(.*)/);
    if (!m) return null;
    const op   = m[1].toUpperCase();
    const args = this._splitArgs(m[2].trim());
    return { op, args, lineNum, idx, raw: text };
  }

  _splitArgs(s) {
    if (!s) return [];
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  _parseImm(s) {
    if (!s) return null;
    s = s.trim();
    if (/^[0-9A-Fa-f]+[hH]$/.test(s))  return parseInt(s.slice(0, -1), 16);
    if (/^0[xX][0-9A-Fa-f]+$/.test(s)) return parseInt(s, 16);
    if (/^[01]+[bB]$/.test(s))          return parseInt(s.slice(0, -1), 2);
    if (/^-?\d+$/.test(s))              return parseInt(s, 10);
    if (/^'.'$/.test(s))                return s.charCodeAt(1);
    return null;
  }
}

// ── Executor ───────────────────────────────────────────────────
class Executor {
  constructor(cpu, parsed) {
    this.cpu    = cpu;
    this.instrs = parsed.instrs;
    this.labels = parsed.labels;
    this.vars   = parsed.vars;
    this.errors = [...parsed.errors];
    this.output = [];
    this.trace  = [];
    this._initMemory();
  }

  _initMemory() {
    for (const v of Object.values(this.vars)) {
      let addr = v.addr;
      if (v.bytes) {
        for (const b of v.bytes) this.cpu.mem[addr++] = b & 0xFF;
      } else if (v.values) {
        for (const val of v.values) {
          if (v.size === 1) { this.cpu.mem[addr] = val & 0xFF; addr++; }
          else { this.cpu.mem[addr] = val & 0xFF; this.cpu.mem[(addr+1)&0xFFFF] = (val>>8)&0xFF; addr+=2; }
        }
      } else {
        const count = v.count ?? 1;
        for (let i = 0; i < count; i++) {
          if (v.size === 1) { this.cpu.mem[addr] = (v.value ?? 0) & 0xFF; addr++; }
          else { this.cpu.mem[addr]=(v.value??0)&0xFF; this.cpu.mem[(addr+1)&0xFFFF]=((v.value??0)>>8)&0xFF; addr+=2; }
        }
      }
    }
  }

  // ── Operand resolution ──
  _stripPtr(arg) {
    let size = null;
    if (/^BYTE\s+PTR\b/i.test(arg)) { size = 8;  arg = arg.replace(/^BYTE\s+PTR\s*/i, ''); }
    if (/^WORD\s+PTR\b/i.test(arg)) { size = 16; arg = arg.replace(/^WORD\s+PTR\s*/i, ''); }
    return { arg: arg.trim(), size };
  }

  resolve(raw) {
    const { arg, size: ptrSize } = this._stripPtr(raw);

    // Register
    if (this.cpu.isReg(arg)) {
      const size = ptrSize ?? this.cpu.regSize(arg);
      return { value: this.cpu.getReg(arg), size, isReg: true, name: arg.toUpperCase() };
    }

    // Memory [...]
    if (arg.startsWith('[')) {
      const addr = this._resolveAddr(arg);
      const size = ptrSize ?? 16;
      return { value: this.cpu.memRead(addr, size), size, isMem: true, addr };
    }

    // Bare data symbol → its OFFSET (NASM semantics; use [sym] for contents).
    const vn = arg.toUpperCase();
    if (this.vars[vn]) {
      return { value: this.vars[vn].addr, size: 16, isImm: true, varName: vn };
    }

    // Immediate
    const imm = this._parseImm(arg);
    if (imm !== null) {
      const size = ptrSize ?? (imm > 0xFF ? 16 : 8);
      return { value: imm, size, isImm: true };
    }

    // Label (used as immediate address for LEA etc.)
    const lu = arg.toUpperCase();
    if (this.labels[lu] !== undefined) return { value: this.labels[lu], size: 16, isLabel: true };

    throw new Error(`Unknown operand: ${raw}`);
  }

  set(raw, value) {
    const { arg } = this._stripPtr(raw);
    if (this.cpu.isReg(arg)) {
      const mask = this.cpu.regSize(arg) === 8 ? 0xFF : 0xFFFF;
      this.cpu.setReg(arg, value & mask);
      return;
    }
    if (arg.startsWith('[')) {
      this.cpu.memWrite(this._resolveAddr(arg), value);
      return;
    }
    const vn = arg.toUpperCase();
    if (this.vars[vn]) {
      const v = this.vars[vn];
      this.cpu.memWrite(v.addr, value, v.size * 8);
      return;
    }
    throw new Error(`Cannot write to: ${raw}`);
  }

  _resolveAddr(expr) {
    const inner = expr.match(/\[(.+)\]/)?.[1]?.trim();
    if (!inner) throw new Error(`Bad memory ref: ${expr}`);
    const vn = inner.toUpperCase();
    if (this.vars[vn]) return this.vars[vn].addr;
    return this._evalAddr(inner);
  }

  _evalAddr(expr) {
    let s = expr;
    // Numeric literals → decimal, BEFORE identifier substitution.
    s = s.replace(/\b([0-9][0-9A-Fa-f]*)[hH]\b/g, (_, n) => parseInt(n, 16).toString(10)); // 1234h / 0FFh
    s = s.replace(/\b0[xX]([0-9A-Fa-f]+)\b/g,     (_, n) => parseInt(n, 16).toString(10)); // 0x1234
    s = s.replace(/\b([01]+)[bB]\b/g,             (_, n) => parseInt(n, 2).toString(10));  // 1010b
    // Registers & data symbols → their numeric value / offset.
    s = s.replace(/\b([A-Za-z_]\w*)\b/g, (_, r) => {
      if (this.cpu.isReg(r)) return this.cpu.getReg(r);
      const vv = this.vars[r.toUpperCase()];
      if (vv) return vv.addr;
      return _;
    });
    if (!/^[\d\s\+\-\*\/\(\)]+$/.test(s)) throw new Error(`Bad address: ${expr}`);
    // eslint-disable-next-line no-new-func
    return (Function('"use strict";return(' + s + ')'))() & 0xFFFF;
  }

  _parseImm(s) {
    if (!s) return null;
    s = s.trim();
    if (/^[0-9A-Fa-f]+[hH]$/.test(s))  return parseInt(s.slice(0, -1), 16);
    if (/^0[xX][0-9A-Fa-f]+$/.test(s)) return parseInt(s, 16);
    if (/^[01]+[bB]$/.test(s))          return parseInt(s.slice(0, -1), 2);
    if (/^-?\d+$/.test(s))              return parseInt(s, 10);
    if (/^'.'$/.test(s))                return s.charCodeAt(1);
    return null;
  }

  _jumpTarget(label) {
    const u = label.toUpperCase();
    if (this.labels[u] !== undefined) return this.labels[u];
    const imm = this._parseImm(label);
    if (imm !== null) return imm;
    throw new Error(`Unknown label: ${label}`);
  }

  _sign(v, size) { return size === 8 ? (v > 0x7F ? v - 0x100 : v) : (v > 0x7FFF ? v - 0x10000 : v); }

  _condJump(target, cond) {
    if (cond) { this.cpu.ip = this._jumpTarget(target); return true; }
    return false;
  }

  // ── Step ──
  step() {
    if (this.cpu.halted)                      throw new Error('CPU halted (HLT)');
    if (this.cpu.ip >= this.instrs.length)    throw new Error('End of program');

    const instr   = this.instrs[this.cpu.ip];
    const { op, args } = instr;
    let jumped    = false;
    let note      = '';

    try {
      switch (op) {
        case 'NOP': break;
        case 'HLT': this.cpu.halted = true; note = 'HALTED'; break;

        // ── Data transfer ──
        case 'MOV': {
          if (!args[0] || !args[1]) throw new Error('MOV needs 2 operands');
          const src = this.resolve(args[1]);
          this.set(args[0], src.value);
          note = `→ ${this._fmtOp(args[0])} = ${hex(src.value)}`;
          break;
        }

        case 'XCHG': {
          const a = this.resolve(args[0]);
          const b = this.resolve(args[1]);
          this.set(args[0], b.value);
          this.set(args[1], a.value);
          note = `${this._fmtOp(args[0])}↔${this._fmtOp(args[1])}`;
          break;
        }

        case 'LEA': {
          const addr = this._addrOf(args[1]);
          this.set(args[0], addr);
          note = `→ ${this._fmtOp(args[0])} = ${hex(addr)}`;
          break;
        }

        case 'CBW': {
          const al = this.cpu.getReg('AL');
          this.cpu.setReg('AX', al > 0x7F ? (al | 0xFF00) : al);
          break;
        }
        case 'CWD': {
          const ax = this.cpu.getReg('AX');
          this.cpu.setReg('DX', ax > 0x7FFF ? 0xFFFF : 0);
          break;
        }

        case 'XLAT': case 'XLATB': {
          const addr = (this.cpu.getReg('BX') + this.cpu.getReg('AL')) & 0xFFFF;
          this.cpu.setReg('AL', this.cpu.mem[addr]);
          break;
        }

        // ── Arithmetic ──
        case 'ADD': case 'ADC': {
          const carry = op === 'ADC' ? this.cpu.flags.CF : 0;
          const a = this.resolve(args[0]);
          const b = this.resolve(args[1]);
          const result = a.value + b.value + carry;
          this.cpu.updateFlags(result, a.size, 'ADD', a.value, b.value);
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result & (a.size===8?0xFF:0xFFFF))}`;
          break;
        }

        case 'SUB': case 'SBB': {
          const borrow = op === 'SBB' ? this.cpu.flags.CF : 0;
          const a = this.resolve(args[0]);
          const b = this.resolve(args[1]);
          const result = a.value - b.value - borrow;
          this.cpu.updateFlags(result, a.size, 'SUB', a.value, b.value + borrow);
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result & (a.size===8?0xFF:0xFFFF))}`;
          break;
        }

        case 'INC': {
          const a = this.resolve(args[0]);
          const result = a.value + 1;
          const cf = this.cpu.flags.CF;
          this.cpu.updateFlags(result, a.size, 'ADD', a.value, 1);
          this.cpu.flags.CF = cf;
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result & (a.size===8?0xFF:0xFFFF))}`;
          break;
        }

        case 'DEC': {
          const a = this.resolve(args[0]);
          const result = a.value - 1;
          const cf = this.cpu.flags.CF;
          this.cpu.updateFlags(result, a.size, 'SUB', a.value, 1);
          this.cpu.flags.CF = cf;
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result & (a.size===8?0xFF:0xFFFF))}`;
          break;
        }

        case 'NEG': {
          const a = this.resolve(args[0]);
          const result = 0 - a.value;
          this.cpu.flags.CF = a.value !== 0 ? 1 : 0;
          this.cpu.updateFlags(result, a.size, 'SUB', 0, a.value);
          this.set(args[0], result);
          break;
        }

        case 'MUL': {
          const src = this.resolve(args[0]);
          if (src.size === 8) {
            const r = this.cpu.getReg('AL') * src.value;
            this.cpu.setReg('AX', r & 0xFFFF);
            this.cpu.flags.CF = this.cpu.flags.OF = r > 0xFF ? 1 : 0;
            note = `AX = ${hex(r & 0xFFFF)}`;
          } else {
            const r = this.cpu.getReg('AX') * src.value;
            this.cpu.setReg('AX', r & 0xFFFF);
            this.cpu.setReg('DX', (r >>> 16) & 0xFFFF);
            this.cpu.flags.CF = this.cpu.flags.OF = r > 0xFFFF ? 1 : 0;
            note = `DX:AX = ${hex((r>>>16)&0xFFFF)}:${hex(r&0xFFFF)}`;
          }
          break;
        }

        case 'IMUL': {
          const src = this.resolve(args[0]);
          if (src.size === 8) {
            const r = this._sign(this.cpu.getReg('AL'), 8) * this._sign(src.value, 8);
            this.cpu.setReg('AX', r & 0xFFFF);
            const al = r & 0xFF, ah = (r >> 8) & 0xFF, ext = (al & 0x80) ? 0xFF : 0x00;
            this.cpu.flags.CF = this.cpu.flags.OF = (ah === ext) ? 0 : 1; // set iff result ≠ sign-extension of low half
            note = `AX = ${hex(r & 0xFFFF)}`;
          } else {
            const r = this._sign(this.cpu.getReg('AX'), 16) * this._sign(src.value, 16);
            const ax = r & 0xFFFF, dx = (r >> 16) & 0xFFFF, ext = (ax & 0x8000) ? 0xFFFF : 0x0000;
            this.cpu.setReg('AX', ax);
            this.cpu.setReg('DX', dx);
            this.cpu.flags.CF = this.cpu.flags.OF = (dx === ext) ? 0 : 1;
            note = `DX:AX = ${hex(dx)}:${hex(ax)}`;
          }
          break;
        }

        case 'DIV': {
          const src = this.resolve(args[0]);
          if (src.value === 0) throw new Error('Division by zero');
          if (src.size === 8) {
            const ax = this.cpu.getReg('AX');
            this.cpu.setReg('AL', Math.floor(ax / src.value) & 0xFF);
            this.cpu.setReg('AH', (ax % src.value) & 0xFF);
            note = `AL=${hex(Math.floor(ax/src.value)&0xFF)} AH=${hex(ax%src.value&0xFF)}`;
          } else {
            const dxax = (this.cpu.getReg('DX') * 0x10000 + this.cpu.getReg('AX'));
            this.cpu.setReg('AX', Math.floor(dxax / src.value) & 0xFFFF);
            this.cpu.setReg('DX', (dxax % src.value) & 0xFFFF);
            note = `AX=${hex(Math.floor(dxax/src.value)&0xFFFF)} DX=${hex(dxax%src.value&0xFFFF)}`;
          }
          break;
        }

        case 'IDIV': {
          const src = this.resolve(args[0]);
          if (src.value === 0) throw new Error('Division by zero');
          if (src.size === 8) {
            const ax = this._sign(this.cpu.getReg('AX'), 16);
            const sv = this._sign(src.value, 8);
            this.cpu.setReg('AL', Math.trunc(ax / sv) & 0xFF);
            this.cpu.setReg('AH', ((ax % sv) + 0x100) & 0xFF);
          } else {
            const dxax = this._sign(this.cpu.getReg('DX'), 16) * 0x10000 + this.cpu.getReg('AX');
            const sv   = this._sign(src.value, 16);
            this.cpu.setReg('AX', Math.trunc(dxax / sv) & 0xFFFF);
            this.cpu.setReg('DX', ((dxax % sv) + 0x10000) & 0xFFFF);
          }
          break;
        }

        // ── Logic ──
        case 'AND': case 'OR': case 'XOR': case 'TEST': {
          const a = this.resolve(args[0]);
          const b = this.resolve(args[1]);
          const result = op === 'AND' || op === 'TEST' ? a.value & b.value
                       : op === 'OR'                   ? a.value | b.value
                       :                                  a.value ^ b.value;
          this.cpu.updateFlags(result, a.size, 'LOG', a.value, b.value);
          if (op !== 'TEST') this.set(args[0], result);
          note = `result = ${hex(result)}`;
          break;
        }

        case 'NOT': {
          const a = this.resolve(args[0]);
          const mask = a.size === 8 ? 0xFF : 0xFFFF;
          this.set(args[0], (~a.value) & mask);
          break;
        }

        case 'CMP': {
          const a = this.resolve(args[0]);
          const b = this.resolve(args[1]);
          const result = a.value - b.value;
          this.cpu.updateFlags(result, a.size, 'SUB', a.value, b.value);
          note = `${this._fmtOp(args[0])}(${hex(a.value)}) - ${hex(b.value)} → flags`;
          break;
        }

        // ── Shifts & Rotates ──
        case 'SHL': case 'SAL': {
          const a = this.resolve(args[0]);
          const cnt = this._shiftCount(args[1]);
          if (cnt === 0) break;                       // count 0 leaves flags & value unchanged
          const mask = a.size === 8 ? 0xFF : 0xFFFF;
          const result = (a.value << cnt) & mask;
          this.cpu.updateFlags(result, a.size, 'LOG', result, result); // ZF/SF/PF only
          this.cpu.flags.CF = cnt <= a.size ? (a.value >> (a.size - cnt)) & 1 : 0;
          if (cnt === 1) this.cpu.flags.OF = (((result >> (a.size - 1)) & 1) ^ this.cpu.flags.CF) ? 1 : 0;
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result)}`;
          break;
        }

        case 'SHR': {
          const a = this.resolve(args[0]);
          const cnt = this._shiftCount(args[1]);
          if (cnt === 0) break;
          const result = a.value >>> cnt;
          this.cpu.updateFlags(result, a.size, 'LOG', result, result); // ZF/SF/PF only
          this.cpu.flags.CF = (a.value >> (cnt - 1)) & 1;
          if (cnt === 1) this.cpu.flags.OF = ((a.value >> (a.size - 1)) & 1) ? 1 : 0;
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result)}`;
          break;
        }

        case 'SAR': {
          const a = this.resolve(args[0]);
          const cnt = this._shiftCount(args[1]);
          if (cnt === 0) break;
          const signed = this._sign(a.value, a.size);
          const result = (signed >> cnt) & (a.size === 8 ? 0xFF : 0xFFFF);
          this.cpu.updateFlags(result, a.size, 'LOG', result, result); // ZF/SF/PF only
          this.cpu.flags.CF = (a.value >> (cnt - 1)) & 1;
          if (cnt === 1) this.cpu.flags.OF = 0;
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result)}`;
          break;
        }

        case 'ROL': {
          const a = this.resolve(args[0]);
          const raw = this._shiftCount(args[1]);
          if (raw === 0) break;
          const mask = a.size === 8 ? 0xFF : 0xFFFF;
          const cnt = raw % a.size;
          const result = cnt === 0 ? (a.value & mask)
                       : ((a.value << cnt) | (a.value >>> (a.size - cnt))) & mask;
          this.cpu.flags.CF = result & 1;
          if (raw === 1) this.cpu.flags.OF = (((result >> (a.size - 1)) & 1) ^ (result & 1)) ? 1 : 0;
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result)}`;
          break;
        }

        case 'ROR': {
          const a = this.resolve(args[0]);
          const raw = this._shiftCount(args[1]);
          if (raw === 0) break;
          const mask = a.size === 8 ? 0xFF : 0xFFFF;
          const cnt = raw % a.size;
          const result = cnt === 0 ? (a.value & mask)
                       : ((a.value >>> cnt) | (a.value << (a.size - cnt))) & mask;
          this.cpu.flags.CF = (result >> (a.size - 1)) & 1;
          if (raw === 1) this.cpu.flags.OF = (((result >> (a.size - 1)) & 1) ^ ((result >> (a.size - 2)) & 1)) ? 1 : 0;
          this.set(args[0], result);
          note = `${this._fmtOp(args[0])} = ${hex(result)}`;
          break;
        }

        case 'RCL': {
          const a = this.resolve(args[0]);
          const raw = this._shiftCount(args[1]);
          if (raw === 0) break;
          const mask = a.size === 8 ? 0xFF : 0xFFFF;
          const cnt = raw % (a.size + 1);          // rotate through carry: 9-bit / 17-bit
          let cf = this.cpu.flags.CF, val = a.value & mask;
          for (let i = 0; i < cnt; i++) {
            const newCf = (val >> (a.size - 1)) & 1;
            val = ((val << 1) | cf) & mask;
            cf = newCf;
          }
          this.cpu.flags.CF = cf;
          if (raw === 1) this.cpu.flags.OF = (((val >> (a.size - 1)) & 1) ^ cf) ? 1 : 0;
          this.set(args[0], val);
          note = `${this._fmtOp(args[0])} = ${hex(val)}`;
          break;
        }

        case 'RCR': {
          const a = this.resolve(args[0]);
          const raw = this._shiftCount(args[1]);
          if (raw === 0) break;
          const mask = a.size === 8 ? 0xFF : 0xFFFF;
          const cnt = raw % (a.size + 1);
          let cf = this.cpu.flags.CF, val = a.value & mask;
          if (raw === 1) this.cpu.flags.OF = (((val >> (a.size - 1)) & 1) ^ cf) ? 1 : 0; // before rotate
          for (let i = 0; i < cnt; i++) {
            const newCf = val & 1;
            val = ((val >>> 1) | (cf << (a.size - 1))) & mask;
            cf = newCf;
          }
          this.cpu.flags.CF = cf;
          this.set(args[0], val);
          note = `${this._fmtOp(args[0])} = ${hex(val)}`;
          break;
        }

        // ── Stack ──
        case 'PUSH': {
          const src = this.resolve(args[0]);
          this.cpu.push(src.value);
          note = `SP=${hex(this.cpu.regs.SP)} ← ${hex(src.value)}`;
          break;
        }
        case 'POP': {
          const val = this.cpu.pop();
          this.set(args[0], val);
          note = `${this._fmtOp(args[0])} = ${hex(val)}`;
          break;
        }
        case 'PUSHF': this.cpu.push(this._flagsWord()); break;
        case 'POPF':  this._setFlagsWord(this.cpu.pop()); break;

        // ── Control flow ──
        case 'JMP':
          this.cpu.ip = this._jumpTarget(args[0]);
          jumped = true;
          note = `→ ${args[0]}`;
          break;

        case 'JE':  case 'JZ':   jumped = this._condJump(args[0], this.cpu.flags.ZF===1); break;
        case 'JNE': case 'JNZ':  jumped = this._condJump(args[0], this.cpu.flags.ZF===0); break;
        case 'JL':  case 'JNGE': jumped = this._condJump(args[0], this.cpu.flags.SF!==this.cpu.flags.OF); break;
        case 'JLE': case 'JNG':  jumped = this._condJump(args[0], this.cpu.flags.ZF===1||this.cpu.flags.SF!==this.cpu.flags.OF); break;
        case 'JG':  case 'JNLE': jumped = this._condJump(args[0], this.cpu.flags.ZF===0&&this.cpu.flags.SF===this.cpu.flags.OF); break;
        case 'JGE': case 'JNL':  jumped = this._condJump(args[0], this.cpu.flags.SF===this.cpu.flags.OF); break;
        case 'JA':  case 'JNBE': jumped = this._condJump(args[0], this.cpu.flags.CF===0&&this.cpu.flags.ZF===0); break;
        case 'JAE': case 'JNB': case 'JNC': jumped = this._condJump(args[0], this.cpu.flags.CF===0); break;
        case 'JB':  case 'JNAE': case 'JC': jumped = this._condJump(args[0], this.cpu.flags.CF===1); break;
        case 'JBE': case 'JNA':  jumped = this._condJump(args[0], this.cpu.flags.CF===1||this.cpu.flags.ZF===1); break;
        case 'JS':               jumped = this._condJump(args[0], this.cpu.flags.SF===1); break;
        case 'JNS':              jumped = this._condJump(args[0], this.cpu.flags.SF===0); break;
        case 'JO':               jumped = this._condJump(args[0], this.cpu.flags.OF===1); break;
        case 'JNO':              jumped = this._condJump(args[0], this.cpu.flags.OF===0); break;
        case 'JP': case 'JPE':   jumped = this._condJump(args[0], this.cpu.flags.PF===1); break;
        case 'JNP': case 'JPO':  jumped = this._condJump(args[0], this.cpu.flags.PF===0); break;
        case 'JCXZ':             jumped = this._condJump(args[0], this.cpu.getReg('CX')===0); break;

        case 'LOOP': {
          const cx = (this.cpu.getReg('CX') - 1) & 0xFFFF;
          this.cpu.setReg('CX', cx);
          note = `CX=${hex(cx)}`;
          if (cx !== 0) { this.cpu.ip = this._jumpTarget(args[0]); jumped = true; }
          break;
        }

        case 'LOOPE': case 'LOOPZ': {
          const cx = (this.cpu.getReg('CX') - 1) & 0xFFFF;
          this.cpu.setReg('CX', cx);
          if (cx !== 0 && this.cpu.flags.ZF === 1) { this.cpu.ip = this._jumpTarget(args[0]); jumped = true; }
          break;
        }

        case 'LOOPNE': case 'LOOPNZ': {
          const cx = (this.cpu.getReg('CX') - 1) & 0xFFFF;
          this.cpu.setReg('CX', cx);
          if (cx !== 0 && this.cpu.flags.ZF === 0) { this.cpu.ip = this._jumpTarget(args[0]); jumped = true; }
          break;
        }

        case 'CALL': {
          this.cpu.push(this.cpu.ip + 1);
          this.cpu.ip = this._jumpTarget(args[0]);
          jumped = true;
          note = `ret→${this.cpu.ip-1}`;
          break;
        }

        case 'RET': {
          if (this.cpu.regs.SP >= 0xFFFE) { this.cpu.halted = true; note='HALTED (no ret addr)'; break; }
          this.cpu.ip = this.cpu.pop();
          jumped = true;
          note = `→ IP=${hex(this.cpu.ip)}`;
          break;
        }

        // ── Flags ──
        case 'CLC': this.cpu.flags.CF = 0; break;
        case 'STC': this.cpu.flags.CF = 1; break;
        case 'CMC': this.cpu.flags.CF ^= 1; break;
        case 'CLD': this.cpu.flags.DF = 0; break;
        case 'STD': this.cpu.flags.DF = 1; break;
        case 'CLI': break;
        case 'STI': break;

        // ── INT ──
        case 'INT': {
          const num = this._parseImm(args[0]);
          if (num === 0x20) {                       // terminate program
            this.cpu.halted = true; note = 'EXIT (INT 20h)';
          } else if (num === 0x21) {
            const ah = this.cpu.getReg('AH');
            switch (ah) {
              case 0x01: {                          // read char, with echo
                const c = this._readChar(); this.cpu.setReg('AL', c & 0xFF);
                if (c) this.output.push(String.fromCharCode(c));
                note = `input '${c ? String.fromCharCode(c) : ''}'`; break;
              }
              case 0x06: {                          // direct console I/O
                const dl = this.cpu.getReg('DL');
                if (dl === 0xFF) { const c = this._readChar(); this.cpu.setReg('AL', c & 0xFF); this.cpu.flags.ZF = c ? 0 : 1; }
                else this.output.push(String.fromCharCode(dl & 0xFF));
                break;
              }
              case 0x07: case 0x08: {               // read char, no echo
                const c = this._readChar(); this.cpu.setReg('AL', c & 0xFF);
                note = 'input (no echo)'; break;
              }
              case 0x02: {                          // print char in DL
                const ch = String.fromCharCode(this.cpu.getReg('DL') & 0xFF);
                this.output.push(ch); note = `output '${ch}'`; break;
              }
              case 0x09: {                          // print '$'-terminated string at DS:DX
                const addr = this.cpu.getReg('DX'); let str = '';
                for (let i = 0; i < 1024; i++) { const b = this.cpu.mem[(addr + i) & 0xFFFF]; if (b === 0x24) break; str += String.fromCharCode(b); }
                this.output.push(str); note = `output "${str.replace(/\r\n|\n/g,'↵')}"`; break;
              }
              case 0x0A: {                          // buffered keyboard input → DS:DX
                const addr = this.cpu.getReg('DX'), max = this.cpu.mem[addr & 0xFFFF];
                let n = 0, str = '';
                while (n < max - 1) {
                  const c = this._readChar();
                  if (!c || c === 13) break;
                  this.cpu.mem[(addr + 2 + n) & 0xFFFF] = c; n++; str += String.fromCharCode(c);
                }
                this.cpu.mem[(addr + 2 + n) & 0xFFFF] = 13;   // CR terminator
                this.cpu.mem[(addr + 1) & 0xFFFF] = n;        // char count
                this.output.push(str); note = `buffered input "${str}" (${n})`; break;
              }
              case 0x2A: {                          // get system date
                const d = new Date();
                this.cpu.setReg('CX', d.getFullYear()); this.cpu.setReg('DH', d.getMonth() + 1);
                this.cpu.setReg('DL', d.getDate());   this.cpu.setReg('AL', d.getDay()); break;
              }
              case 0x2C: {                          // get system time
                const d = new Date();
                this.cpu.setReg('CH', d.getHours());  this.cpu.setReg('CL', d.getMinutes());
                this.cpu.setReg('DH', d.getSeconds()); this.cpu.setReg('DL', Math.floor(d.getMilliseconds() / 10)); break;
              }
              case 0x30: {                          // get DOS version (report 6.22)
                this.cpu.setReg('AL', 6); this.cpu.setReg('AH', 22);
                this.cpu.setReg('BX', 0); this.cpu.setReg('CX', 0); break;
              }
              case 0x4C: {                          // terminate with return code
                this.cpu.halted = true; note = `EXIT code=${hex(this.cpu.getReg('AL'))}`; break;
              }
              default: note = `INT 21h AH=${hex(ah, 2)} (unhandled)`;
            }
          } else if (num === 0x10) {                // BIOS video
            const ah = this.cpu.getReg('AH');
            if (ah === 0x0E || ah === 0x09 || ah === 0x0A)
              this.output.push(String.fromCharCode(this.cpu.getReg('AL') & 0xFF));
          } else if (num === 0x16) {                // BIOS keyboard
            const ah = this.cpu.getReg('AH');
            if (ah === 0x00 || ah === 0x10) { const c = this._readChar(); this.cpu.setReg('AL', c & 0xFF); this.cpu.setReg('AH', 0); }
            else if (ah === 0x01 || ah === 0x11) { const has = this.cpu.inputBuffer.length > 0; this.cpu.flags.ZF = has ? 0 : 1; if (has) this.cpu.setReg('AL', this.cpu.inputBuffer[0] & 0xFF); }
          } else {
            note = `INT ${hex(num, 2)}h (no-op)`;
          }
          break;
        }

        // ── String instructions ──
        case 'MOVSB': case 'MOVSW': case 'STOSB': case 'STOSW':
        case 'LODSB': case 'LODSW': case 'SCASB': case 'SCASW':
        case 'CMPSB': case 'CMPSW':
          this._strOp(op);
          note = op;
          break;

        case 'REP': case 'REPE': case 'REPZ': case 'REPNE': case 'REPNZ': {
          const sop = (args[0] || '').toUpperCase();
          const checkZF = op !== 'REP';
          const wantZF  = (op === 'REPE' || op === 'REPZ') ? 1 : 0;
          let cx = this.cpu.getReg('CX'), guard = 0;
          while (cx !== 0) {
            this._strOp(sop);
            cx = (cx - 1) & 0xFFFF;
            this.cpu.setReg('CX', cx);
            if (checkZF && (sop.startsWith('SCAS') || sop.startsWith('CMPS')) && this.cpu.flags.ZF !== wantZF) break;
            if (guard++ > 300000) throw new Error('REP exceeded step limit');
          }
          note = `${op} ${sop} → CX=${hex(cx)}`;
          break;
        }

        // ── BCD adjust ──
        case 'DAA': {
          const al = this.cpu.getReg('AL'), oldCF = this.cpu.flags.CF;
          let AL = al, CF = 0;
          if ((AL & 0x0F) > 9 || this.cpu.flags.AF) { const s = AL + 6; CF = oldCF | (s > 0xFF ? 1 : 0); AL = s & 0xFF; this.cpu.flags.AF = 1; }
          else this.cpu.flags.AF = 0;
          if (al > 0x99 || oldCF) { AL = (AL + 0x60) & 0xFF; CF = 1; }
          this.cpu.flags.CF = CF; this.cpu.setReg('AL', AL); this._setSZP(AL);
          break;
        }
        case 'DAS': {
          const al = this.cpu.getReg('AL'), oldCF = this.cpu.flags.CF;
          let AL = al, CF = 0;
          if ((AL & 0x0F) > 9 || this.cpu.flags.AF) { const borrow = AL < 6 ? 1 : 0; AL = (AL - 6) & 0xFF; CF = oldCF | borrow; this.cpu.flags.AF = 1; }
          else this.cpu.flags.AF = 0;
          if (al > 0x99 || oldCF) { AL = (AL - 0x60) & 0xFF; CF = 1; }
          this.cpu.flags.CF = CF; this.cpu.setReg('AL', AL); this._setSZP(AL);
          break;
        }
        case 'AAA': {
          if ((this.cpu.getReg('AL') & 0x0F) > 9 || this.cpu.flags.AF) {
            this.cpu.setReg('AX', (this.cpu.getReg('AX') + 0x106) & 0xFFFF);
            this.cpu.flags.AF = 1; this.cpu.flags.CF = 1;
          } else { this.cpu.flags.AF = 0; this.cpu.flags.CF = 0; }
          this.cpu.setReg('AL', this.cpu.getReg('AL') & 0x0F);
          break;
        }
        case 'AAS': {
          if ((this.cpu.getReg('AL') & 0x0F) > 9 || this.cpu.flags.AF) {
            this.cpu.setReg('AX', (this.cpu.getReg('AX') - 6) & 0xFFFF);
            this.cpu.setReg('AH', (this.cpu.getReg('AH') - 1) & 0xFF);
            this.cpu.flags.AF = 1; this.cpu.flags.CF = 1;
          } else { this.cpu.flags.AF = 0; this.cpu.flags.CF = 0; }
          this.cpu.setReg('AL', this.cpu.getReg('AL') & 0x0F);
          break;
        }
        case 'AAM': {
          const base = args[0] ? (this._parseImm(args[0]) ?? 10) : 10;
          const al = this.cpu.getReg('AL');
          this.cpu.setReg('AH', Math.floor(al / base) & 0xFF);
          this.cpu.setReg('AL', (al % base) & 0xFF);
          this._setSZP(this.cpu.getReg('AL'));
          break;
        }
        case 'AAD': {
          const base = args[0] ? (this._parseImm(args[0]) ?? 10) : 10;
          const al = this.cpu.getReg('AL'), ah = this.cpu.getReg('AH');
          this.cpu.setReg('AL', (al + ah * base) & 0xFF);
          this.cpu.setReg('AH', 0);
          this._setSZP(this.cpu.getReg('AL'));
          break;
        }

        // ── Stack push/pop all (186) ──
        case 'PUSHA': case 'PUSHAW': {
          const sp = this.cpu.getReg('SP');
          this.cpu.push(this.cpu.getReg('AX')); this.cpu.push(this.cpu.getReg('CX'));
          this.cpu.push(this.cpu.getReg('DX')); this.cpu.push(this.cpu.getReg('BX'));
          this.cpu.push(sp);
          this.cpu.push(this.cpu.getReg('BP')); this.cpu.push(this.cpu.getReg('SI'));
          this.cpu.push(this.cpu.getReg('DI'));
          break;
        }
        case 'POPA': case 'POPAW': {
          this.cpu.setReg('DI', this.cpu.pop()); this.cpu.setReg('SI', this.cpu.pop());
          this.cpu.setReg('BP', this.cpu.pop()); this.cpu.pop(); // discard saved SP
          this.cpu.setReg('BX', this.cpu.pop()); this.cpu.setReg('DX', this.cpu.pop());
          this.cpu.setReg('CX', this.cpu.pop()); this.cpu.setReg('AX', this.cpu.pop());
          break;
        }

        // ── Flag <-> AH transfer ──
        case 'LAHF': {
          const f = this.cpu.flags;
          this.cpu.setReg('AH', (f.CF | (1 << 1) | (f.PF << 2) | (f.AF << 4) | (f.ZF << 6) | (f.SF << 7)) & 0xFF);
          break;
        }
        case 'SAHF': {
          const ah = this.cpu.getReg('AH');
          this.cpu.flags.CF = ah & 1; this.cpu.flags.PF = (ah >> 2) & 1;
          this.cpu.flags.AF = (ah >> 4) & 1; this.cpu.flags.ZF = (ah >> 6) & 1;
          this.cpu.flags.SF = (ah >> 7) & 1;
          break;
        }

        // ── Load far pointer: reg ← [m], DS/ES ← [m+2] ──
        case 'LDS': case 'LES': {
          const addr = this._addrOf(args[1]);
          this.set(args[0], this.cpu.memRead(addr, 16));
          this.cpu.setReg(op === 'LDS' ? 'DS' : 'ES', this.cpu.memRead((addr + 2) & 0xFFFF, 16));
          note = `${this._fmtOp(args[0])} ${op === 'LDS' ? 'DS' : 'ES'} loaded`;
          break;
        }

        // ── Stack frame (186) ──
        case 'ENTER': {
          const size = this._parseImm(args[0]) ?? 0;  // nesting level ignored (level 0)
          this.cpu.push(this.cpu.getReg('BP'));
          this.cpu.setReg('BP', this.cpu.getReg('SP'));
          this.cpu.setReg('SP', (this.cpu.getReg('SP') - size) & 0xFFFF);
          break;
        }
        case 'LEAVE': {
          this.cpu.setReg('SP', this.cpu.getReg('BP'));
          this.cpu.setReg('BP', this.cpu.pop());
          break;
        }

        // ── Port I/O (simulated port space) ──
        case 'IN': {
          const port = this.cpu.isReg(args[1]) ? this.cpu.getReg(args[1]) : (this._parseImm(args[1]) ?? 0);
          if (args[0].toUpperCase() === 'AL') this.cpu.setReg('AL', this.cpu.ports[port & 0xFFFF]);
          else this.cpu.setReg('AX', this.cpu.ports[port & 0xFFFF] | (this.cpu.ports[(port + 1) & 0xFFFF] << 8));
          note = `IN ${this._fmtOp(args[0])} ← port ${hex(port)}`;
          break;
        }
        case 'OUT': {
          const port = this.cpu.isReg(args[0]) ? this.cpu.getReg(args[0]) : (this._parseImm(args[0]) ?? 0);
          if (args[1].toUpperCase() === 'AL') this.cpu.ports[port & 0xFFFF] = this.cpu.getReg('AL');
          else { const v = this.cpu.getReg('AX'); this.cpu.ports[port & 0xFFFF] = v & 0xFF; this.cpu.ports[(port + 1) & 0xFFFF] = (v >> 8) & 0xFF; }
          note = `OUT port ${hex(port)} ← ${this._fmtOp(args[1])}`;
          break;
        }

        // ── Interrupt return / overflow trap ──
        case 'IRET': case 'IRETW': {
          if (this.cpu.regs.SP >= 0xFFFE) { this.cpu.halted = true; note = 'HALTED (no IRET frame)'; break; }
          this.cpu.ip = this.cpu.pop();
          this.cpu.setReg('CS', this.cpu.pop());
          this._setFlagsWord(this.cpu.pop());
          jumped = true;
          note = `→ IP=${hex(this.cpu.ip)}`;
          break;
        }
        case 'INTO': {
          note = this.cpu.flags.OF ? 'INTO (OF set)' : 'INTO (no trap)';
          break;
        }

        // ── Accepted no-ops ──
        case 'WAIT': case 'FWAIT': case 'LOCK': case 'ESC': case 'HNT':
          break;

        default:
          throw new Error(`Unsupported instruction: ${op}`);
      }
    } catch (e) {
      const err = new Error(e.message);
      err.lineNum = instr.lineNum;
      err.instr   = instr.raw;
      throw err;
    }

    const entry = {
      ip: this.cpu.ip,
      lineNum: instr.lineNum,
      instr:   instr.raw,
      note,
      jumped,
    };
    this.trace.push(entry);

    if (!jumped) this.cpu.ip++;
    return entry;
  }

  _shiftCount(arg) {
    if (!arg) return 1;
    if (arg.toUpperCase() === 'CL') return this.cpu.getReg('CL') & 0x1F;
    return (this._parseImm(arg) ?? 1) & 0x1F;
  }

  // Effective address from either `[expr]` or a bare data symbol.
  _addrOf(arg) {
    const { arg: a } = this._stripPtr(arg);
    if (a.startsWith('[')) return this._resolveAddr(a);
    const v = this.vars[a.toUpperCase()];
    if (v) return v.addr;
    return this._evalAddr(a);
  }

  // Consume one queued input char code (0 if none queued).
  _readChar() {
    return this.cpu.inputBuffer.length ? this.cpu.inputBuffer.shift() : 0;
  }

  // Set SF/ZF/PF from an 8-bit result (used by BCD adjust ops).
  _setSZP(v) {
    const r = v & 0xFF;
    this.cpu.flags.ZF = r === 0 ? 1 : 0;
    this.cpu.flags.SF = (r & 0x80) ? 1 : 0;
    let p = r; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
    this.cpu.flags.PF = (~p) & 1;
  }

  // One iteration of a string instruction (flat segments). DF picks direction.
  _strOp(op) {
    const d  = this.cpu.flags.DF ? -1 : 1;
    const si = this.cpu.getReg('SI'), di = this.cpu.getReg('DI');
    const adv = (reg, n) => this.cpu.setReg(reg, (this.cpu.getReg(reg) + n) & 0xFFFF);
    switch (op) {
      case 'MOVSB': this.cpu.memWrite(di, this.cpu.memRead(si, 8), 8);  adv('SI', d);   adv('DI', d);   break;
      case 'MOVSW': this.cpu.memWrite(di, this.cpu.memRead(si, 16), 16); adv('SI', 2*d); adv('DI', 2*d); break;
      case 'STOSB': this.cpu.memWrite(di, this.cpu.getReg('AL'), 8);  adv('DI', d);   break;
      case 'STOSW': this.cpu.memWrite(di, this.cpu.getReg('AX'), 16); adv('DI', 2*d); break;
      case 'LODSB': this.cpu.setReg('AL', this.cpu.memRead(si, 8));  adv('SI', d);   break;
      case 'LODSW': this.cpu.setReg('AX', this.cpu.memRead(si, 16)); adv('SI', 2*d); break;
      case 'SCASB': { const a = this.cpu.getReg('AL'), b = this.cpu.memRead(di, 8);  this.cpu.updateFlags(a - b, 8, 'SUB', a, b);  adv('DI', d);   break; }
      case 'SCASW': { const a = this.cpu.getReg('AX'), b = this.cpu.memRead(di, 16); this.cpu.updateFlags(a - b, 16, 'SUB', a, b); adv('DI', 2*d); break; }
      case 'CMPSB': { const a = this.cpu.memRead(si, 8),  b = this.cpu.memRead(di, 8);  this.cpu.updateFlags(a - b, 8, 'SUB', a, b);  adv('SI', d);   adv('DI', d);   break; }
      case 'CMPSW': { const a = this.cpu.memRead(si, 16), b = this.cpu.memRead(di, 16); this.cpu.updateFlags(a - b, 16, 'SUB', a, b); adv('SI', 2*d); adv('DI', 2*d); break; }
      default: throw new Error(`Unknown string op: ${op}`);
    }
  }

  _fmtOp(s) {
    return s.toUpperCase().replace(/\s+/g, '');
  }

  _flagsWord() {
    const f = this.cpu.flags;
    return f.CF | (f.PF << 2) | (f.AF << 4) | (f.ZF << 6) | (f.SF << 7)
         | (f.TF << 8) | (f.IF << 9) | (f.DF << 10) | (f.OF << 11);
  }
  _setFlagsWord(w) {
    this.cpu.flags.CF = w & 1;
    this.cpu.flags.PF = (w >> 2) & 1;
    this.cpu.flags.AF = (w >> 4) & 1;
    this.cpu.flags.ZF = (w >> 6) & 1;
    this.cpu.flags.SF = (w >> 7) & 1;
    this.cpu.flags.TF = (w >> 8) & 1;
    this.cpu.flags.IF = (w >> 9) & 1;
    this.cpu.flags.DF = (w >> 10) & 1;
    this.cpu.flags.OF = (w >> 11) & 1;
  }
}

// ── Helpers ────────────────────────────────────────────────────
function hex(v, digits = 4) {
  if (v < 0) v = v + (digits === 2 ? 0x100 : 0x10000);
  return v.toString(16).toUpperCase().padStart(digits, '0') + 'h';
}
function hex2(v) { return hex(v, 2); }
function dec(v, size) {
  const s = size === 8 ? (v > 0x7F ? v - 0x100 : v) : (v > 0x7FFF ? v - 0x10000 : v);
  return s.toString(10);
}

// ── Example programs ──
const EXAMPLES = [
  {
    name: 'Sum 1..10',
    code: `; Sum of numbers 1 to 10
; Result in AX

    MOV CX, 10      ; loop counter
    MOV AX, 0       ; accumulator
    MOV BX, 1       ; current number

loop_start:
    ADD AX, BX      ; AX += BX
    INC BX          ; next number
    LOOP loop_start ; CX--, repeat if CX != 0

    HLT             ; AX = 55 (0037h)
`,
  },
  {
    name: 'Factorial 5',
    code: `; Factorial of 5 → result in AX

    MOV AX, 1       ; product
    MOV CX, 5       ; counter

fact_loop:
    MUL CX          ; AX = AX * CX
    LOOP fact_loop  ; CX--, repeat

    HLT             ; AX = 120 (0078h)
`,
  },
  {
    name: 'Max of two numbers',
    code: `; Find maximum of BX and CX, store in AX

    MOV BX, 25      ; first number
    MOV CX, 42      ; second number

    MOV AX, BX
    CMP AX, CX      ; compare AX and CX
    JGE done        ; jump if AX >= CX
    MOV AX, CX      ; AX = CX (larger)

done:
    HLT             ; AX = 42 (002Ah)
`,
  },
  {
    name: 'INT 21h Output',
    code: `; Print a string using INT 21h

.data
    msg DB 'Hello, World!', '$'

.code
    MOV AH, 09h     ; function: write string
    MOV DX, msg     ; address of string
    INT 21h         ; call DOS

    MOV AH, 4Ch     ; function: exit
    INT 21h
`,
  },
  {
    name: 'Stack & CALL/RET',
    code: `; Demonstrate CALL, RET, PUSH/POP

    MOV AX, 10
    MOV BX, 20
    CALL add_em
    HLT             ; AX = 30

add_em:
    PUSH BX
    ADD  AX, BX
    POP  BX
    RET
`,
  },
  {
    name: 'Bubble Sort (array)',
    code: `; Bubble sort 5 elements
; Uses memory directly (BX as base, SI as index)

.data
    arr DW 5, 3, 8, 1, 4

.code
    MOV CX, 4          ; outer loop count

outer:
    PUSH CX
    MOV  BX, arr
    MOV  SI, 0

inner:
    MOV  AX, [BX+SI]
    MOV  DX, [BX+SI+2]
    CMP  AX, DX
    JLE  no_swap
    MOV  [BX+SI],   DX
    MOV  [BX+SI+2], AX
no_swap:
    ADD  SI, 2
    CMP  SI, 8         ; 4 pairs × 2 bytes
    JL   inner

    POP  CX
    LOOP outer

    HLT
`,
  },
];

// ── UI Application ─────────────────────────────────────────────
class App {
  constructor() {
    this.cpu      = new CPU();
    this.parser   = new Parser();
    this.executor = null;
    this.parsed   = null;
    this.history  = [];      // CPU snapshots for step-back
    this.outputBuf = '';     // accumulated output chars
    this.autoTimer = null;
    this.runTimer  = null;
    this._parseDebounce = null;
    this._prevRegs = null;

    this._bindUI();
    this._loadExampleByIdx(0);
  }

  // ── UI binding ──
  _bindUI() {
    this.$editor    = document.getElementById('editor');
    this.$lineNums  = document.getElementById('line-nums');
    this.$lineHL    = document.getElementById('line-highlight-canvas');
    this.$edErrors  = document.getElementById('editor-errors');
    this.$regsGrid  = document.getElementById('regs-grid');
    this.$ipVal     = document.getElementById('ip-val');
    this.$spVal     = document.getElementById('sp-val');
    this.$flagsRow  = document.getElementById('flags-row');
    this.$stackBody = document.getElementById('stack-body');
    this.$outPre    = document.getElementById('out-pre');
    this.$memPre    = document.getElementById('mem-pre');
    this.$errList   = document.getElementById('err-list');
    this.$traceList = document.getElementById('trace-list');
    this.$errBadge  = document.getElementById('err-badge');
    this.$status    = document.getElementById('status-pill');
    this.$btnBack   = document.getElementById('btn-step-back');
    this.$btnStep   = document.getElementById('btn-step');
    this.$btnRun    = document.getElementById('btn-run');
    this.$btnStop   = document.getElementById('btn-stop');
    this.$btnReset  = document.getElementById('btn-reset');
    this.$autoTog   = document.getElementById('auto-toggle');
    this.$speedSlider = document.getElementById('speed-slider');
    this.$speedVal  = document.getElementById('speed-val');

    // Editor events
    this.$editor.addEventListener('input',  () => this._onCodeChange());
    this.$editor.addEventListener('scroll', () => this._syncScroll());
    this.$editor.addEventListener('keydown', e => {
      if (e.key === 'Tab') { e.preventDefault(); this._insertTab(); }
    });

    // Toolbar buttons
    document.getElementById('btn-reset').addEventListener('click',  () => this.reset());
    document.getElementById('btn-step-back').addEventListener('click', () => this.stepBack());
    document.getElementById('btn-step').addEventListener('click',   () => this.step());
    document.getElementById('btn-run').addEventListener('click',    () => this.runAll());
    document.getElementById('btn-stop').addEventListener('click',   () => this.stopAuto());
    document.getElementById('btn-example').addEventListener('click', () => this._showExamplePicker());
    document.getElementById('btn-clear').addEventListener('click',  () => this._clearEditor());

    // Auto-step toggle
    this.$autoTog.addEventListener('change', () => {
      if (this.$autoTog.checked) this._startAutoStep();
      else this.stopAuto();
    });

    // Speed slider
    this.$speedSlider.addEventListener('input', () => {
      const ms = this._sliderToMs();
      document.getElementById('speed-val').textContent = ms + 'ms';
      if (this.autoTimer) { this.stopAuto(); this._startAutoStep(); }
    });
    document.getElementById('speed-val').textContent = this._sliderToMs() + 'ms';

    // Tabs
    document.getElementById('tabs').addEventListener('click', e => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('pane-' + btn.dataset.pane).classList.add('active');
    });

    // Init register grid
    this._buildRegGrid();
    this._buildFlagRow();
    this._updateUI();
  }

  _sliderToMs() {
    const v = parseInt(this.$speedSlider.value);
    const speeds = [50, 100, 200, 300, 500, 700, 1000, 1500, 2000];
    return speeds[v - 1] ?? 500;
  }

  _insertTab() {
    const s = this.$editor.selectionStart;
    const e = this.$editor.selectionEnd;
    this.$editor.value = this.$editor.value.slice(0, s) + '    ' + this.$editor.value.slice(e);
    this.$editor.selectionStart = this.$editor.selectionEnd = s + 4;
    this._onCodeChange();
  }

  // ── Code change handling ──
  _onCodeChange() {
    this._updateLineNums();
    clearTimeout(this._parseDebounce);
    this._parseDebounce = setTimeout(() => this._reparseAndReset(), 300);
  }

  _reparseAndReset() {
    this.reset(true); // parse + reset but keep code
  }

  // ── Reset ──
  reset(keepCode = false) {
    this.stopAuto();
    this.$autoTog.checked = false;
    this.cpu.reset();
    this.history  = [];
    this.outputBuf = '';

    const code = this.$editor.value;
    this.parsed   = this.parser.parse(code);
    this.executor = new Executor(this.cpu, this.parsed);

    this._prevRegs = { ...this.cpu.regs };
    this._updateUI();
    this._setStatus('Ready', '');
  }

  // ── Step forward ──
  step() {
    if (!this.executor) this.reset();
    if (this.cpu.halted)                   return this._setStatus('Halted', 'done');
    if (this.cpu.ip >= this.executor.instrs.length) return this._setStatus('End of program', 'done');
    if (this.parsed.errors.length > 0)     return this._setStatus('Fix errors first', 'error');

    // Save snapshot before step
    this.history.push(this.cpu.snapshot());

    const prevRegs = { ...this.cpu.regs };

    try {
      const entry = this.executor.step();
      this._prevRegs = prevRegs;
      this._updateUI(entry);

      if (this.cpu.halted || this.cpu.ip >= this.executor.instrs.length) {
        this._setStatus('Done', 'done');
        this.stopAuto();
      } else {
        this._setStatus(`IP: ${this.cpu.ip}  Line: ${this._currentLineNum()}`, 'running');
      }
    } catch (e) {
      this.history.pop(); // don't save bad state
      this._showRuntimeError(e);
      this.stopAuto();
    }
  }

  _currentLineNum() {
    if (!this.executor || this.cpu.ip >= this.executor.instrs.length) return '-';
    return this.executor.instrs[this.cpu.ip]?.lineNum ?? '-';
  }

  // ── Step back ──
  stepBack() {
    if (this.history.length === 0) return;
    const snap = this.history.pop();
    this._prevRegs = { ...this.cpu.regs };
    this.cpu.restore(snap);
    // Rebuild executor output up to this point by replaying trace
    // (simpler: just re-sync output from trace)
    this.outputBuf = this.executor.output.slice(0, this.executor.trace.length).join('');
    if (this.executor.trace.length > 0) this.executor.trace.pop();
    this._updateUI();
    this._setStatus(`Stepped back — IP: ${this.cpu.ip}`, '');
  }

  // ── Run all ──
  runAll() {
    if (!this.executor) this.reset();
    if (this.parsed.errors.length > 0) return this._setStatus('Fix errors first', 'error');

    const MAX = 100000;
    let steps = 0;
    this.$btnRun.style.display  = 'none';
    this.$btnStop.style.display = '';

    const tick = () => {
      for (let i = 0; i < 200; i++) {
        if (this.cpu.halted || this.cpu.ip >= this.executor.instrs.length) {
          this._setStatus('Done', 'done');
          this._updateUI();
          this.$btnRun.style.display  = '';
          this.$btnStop.style.display = 'none';
          return;
        }
        if (steps++ > MAX) {
          this._setStatus('Stopped: exceeded 100k steps (possible infinite loop)', 'error');
          this.$btnRun.style.display  = '';
          this.$btnStop.style.display = 'none';
          this._updateUI();
          return;
        }
        this.history.push(this.cpu.snapshot());
        try {
          this.executor.step();
        } catch (e) {
          this.history.pop();
          this._showRuntimeError(e);
          this.$btnRun.style.display  = '';
          this.$btnStop.style.display = 'none';
          return;
        }
      }
      this._updateUI();
      this.runTimer = requestAnimationFrame(tick);
    };
    this.runTimer = requestAnimationFrame(tick);
  }

  // ── Auto-step ──
  _startAutoStep() {
    this.stopAuto();
    const ms = this._sliderToMs();
    this.$btnStop.style.display = '';
    this.$btnRun.style.display  = 'none';
    this.autoTimer = setInterval(() => {
      if (this.cpu.halted || this.cpu.ip >= this.executor.instrs.length) {
        this.stopAuto();
        return;
      }
      this.step();
    }, ms);
  }

  stopAuto() {
    clearInterval(this.autoTimer);
    cancelAnimationFrame(this.runTimer);
    this.autoTimer = null;
    this.$btnStop.style.display = 'none';
    this.$btnRun.style.display  = '';
    if (this.$autoTog.checked && !this.cpu.halted) {
      // keep toggle on if not done
    }
  }

  // ── UI update ──
  _updateUI(traceEntry) {
    this._updateRegs();
    this._updateFlags();
    this._updateStack();
    this._updateOutput();
    this._updateMemory();
    this._updateErrors();
    this._updateTrace(traceEntry);
    this._updateLineHighlight();
    this._updateLineNums();
    this.$btnBack.disabled = this.history.length === 0;
  }

  _buildRegGrid() {
    const pairs = [
      ['AX','AL','AH'], ['BX','BL','BH'], ['CX','CL','CH'], ['DX','DL','DH'],
      ['SI',null,null],  ['DI',null,null],  ['BP',null,null],
    ];
    this.$regsGrid.innerHTML = '';
    for (const [r16, lo, hi] of pairs) {
      const cell = document.createElement('div');
      cell.className = 'reg-cell';
      cell.id = 'rc-' + r16;
      cell.innerHTML = `
        <div class="reg-name">${r16}</div>
        <div class="reg-val" id="rv-${r16}">0000h</div>
        ${lo ? `<div class="reg-sub" id="rs-${r16}">${hi}=00 ${lo}=00</div>` : ''}
      `;
      this.$regsGrid.appendChild(cell);
    }
  }

  _updateRegs() {
    const pairs = [
      ['AX','AL','AH'], ['BX','BL','BH'], ['CX','CL','CH'], ['DX','DL','DH'],
      ['SI',null,null],  ['DI',null,null],  ['BP',null,null],
    ];
    for (const [r16, lo, hi] of pairs) {
      const v = this.cpu.getReg(r16);
      const cell = document.getElementById('rc-' + r16);
      const valEl = document.getElementById('rv-' + r16);
      if (!cell || !valEl) continue;

      const changed = this._prevRegs && this._prevRegs[r16] !== v;
      cell.classList.toggle('changed', !!changed);
      valEl.textContent = hex(v);

      if (lo) {
        const subEl = document.getElementById('rs-' + r16);
        if (subEl) subEl.textContent = `${hi}=${hex2(this.cpu.getReg(hi))} ${lo}=${hex2(this.cpu.getReg(lo))}`;
      }
    }
    this.$ipVal.textContent = this.cpu.ip.toString(16).toUpperCase().padStart(4, '0');
    this.$spVal.textContent = hex(this.cpu.regs.SP);
  }

  _buildFlagRow() {
    const flags = ['ZF','SF','CF','OF','PF','DF'];
    this.$flagsRow.innerHTML = '';
    for (const f of flags) {
      const badge = document.createElement('div');
      badge.className = 'flag-badge';
      badge.id = 'fb-' + f;
      badge.title = this._flagDesc(f);
      badge.textContent = f + '=0';
      this.$flagsRow.appendChild(badge);
    }
  }

  _updateFlags() {
    const flags = ['ZF','SF','CF','OF','PF','DF'];
    for (const f of flags) {
      const el = document.getElementById('fb-' + f);
      if (!el) continue;
      const v = this.cpu.flags[f];
      el.textContent = f + '=' + v;
      el.classList.toggle('set', v === 1);
    }
  }

  _flagDesc(f) {
    return { ZF:'Zero Flag', SF:'Sign Flag', CF:'Carry Flag', OF:'Overflow Flag', PF:'Parity Flag', DF:'Direction Flag' }[f] || f;
  }

  _updateStack() {
    // Show values pushed on the stack
    const base = 0xFFFE;
    const sp   = this.cpu.regs.SP;
    let html   = '';
    if (sp >= base) {
      html = '<div class="stack-empty">empty</div>';
    } else {
      let addr = base - 2;
      let depth = 0;
      while (addr >= sp && depth < 16) {
        const val = this.cpu.memRead(addr, 16);
        const isTop = addr === sp;
        html += `<div class="stack-entry">
          <span class="addr">${hex(addr)}</span>
          &nbsp;<span class="val">${hex(val)}</span>
          ${isTop ? ' <span style="color:var(--accent)">← SP</span>' : ''}
        </div>`;
        addr -= 2;
        depth++;
      }
    }
    this.$stackBody.innerHTML = html;
  }

  _updateOutput() {
    if (!this.executor) { this.$outPre.textContent = ''; return; }
    const text = this.executor.output.join('');
    if (!text) {
      this.$outPre.innerHTML = '<span class="out-empty">No output yet</span>';
    } else {
      this.$outPre.textContent = text;
    }
  }

  _updateMemory() {
    if (!this.executor) return;
    // Show non-zero memory regions
    const mem   = this.cpu.mem;
    const lines  = [];
    let i = 0;
    while (i < 0x10000) {
      // Find next non-zero byte
      while (i < 0x10000 && mem[i] === 0) i++;
      if (i >= 0x10000) break;

      // Show 16-byte row
      const row = i & ~0xF;
      const rowEnd = Math.min(row + 16, 0x10000);
      let hexPart  = '';
      let asciiPart = '';
      for (let j = row; j < rowEnd; j++) {
        hexPart   += mem[j].toString(16).toUpperCase().padStart(2, '0') + ' ';
        const c    = mem[j];
        asciiPart += (c >= 0x20 && c < 0x7F) ? String.fromCharCode(c) : '.';
      }
      lines.push(`<span class="mem-addr">${row.toString(16).toUpperCase().padStart(4,'0')}</span>  <span class="mem-bytes">${hexPart.trimEnd()}</span>  <span class="mem-ascii">${asciiPart}</span>`);
      i = rowEnd;
    }
    this.$memPre.innerHTML = lines.length ? lines.join('\n') : '<span style="color:var(--text3)">No data in memory</span>';
  }

  _updateErrors() {
    const allErrors = [
      ...(this.parsed?.errors ?? []),
      ...(this.executor?.errors ?? []),
    ];

    // Editor inline error list
    if (allErrors.length === 0) {
      this.$edErrors.innerHTML = '<div class="editor-errors-empty">✓ No errors</div>';
    } else {
      this.$edErrors.innerHTML = allErrors.map(e =>
        `<div class="editor-error-item">
          <span class="err-line">Line ${e.lineNum ?? '?'}</span>
          <span>${escHtml(e.message)}</span>
        </div>`
      ).join('');
    }

    // Errors tab
    this.$errBadge.textContent = allErrors.length;
    this.$errBadge.classList.toggle('zero', allErrors.length === 0);

    this.$errList.innerHTML = allErrors.length === 0
      ? '<div style="color:var(--green);padding:8px">✓ No errors detected</div>'
      : allErrors.map(e => `
        <div class="err-item">
          <span class="err-icon">✖</span>
          <span class="err-loc">Line ${e.lineNum ?? '?'}</span>
          <div>
            <div class="err-msg">${escHtml(e.message)}</div>
            ${e.instr ? `<div class="err-src">${escHtml(e.instr)}</div>` : ''}
          </div>
        </div>`
      ).join('');
  }

  _updateTrace(newEntry) {
    if (!newEntry) return;
    const item = document.createElement('div');
    item.className = 'trace-item current-trace';
    item.innerHTML = `
      <span class="trace-ip">${newEntry.ip.toString(16).toUpperCase().padStart(4,'0')}</span>
      <span class="trace-ln">L${newEntry.lineNum}</span>
      <span class="trace-instr">${escHtml(newEntry.instr)}</span>
      <span class="trace-note">${escHtml(newEntry.note)}</span>
    `;

    // Deselect previous
    this.$traceList.querySelectorAll('.current-trace').forEach(el => el.classList.remove('current-trace'));
    this.$traceList.appendChild(item);
    item.scrollIntoView({ block: 'nearest' });
  }

  _updateLineHighlight() {
    if (!this.executor || this.cpu.ip >= this.executor.instrs.length) {
      this._clearHighlight(); return;
    }
    const lineNum = this.executor.instrs[this.cpu.ip]?.lineNum;
    if (!lineNum) { this._clearHighlight(); return; }
    this._drawHighlight(lineNum - 1);
  }

  _drawHighlight(lineIdx) {
    const ta  = this.$editor;
    const cv  = this.$lineHL;
    cv.width  = ta.offsetWidth;
    cv.height = ta.offsetHeight;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);

    const lineH   = 20; // px, matches CSS --line-h
    const padTop  = 8;
    const y       = padTop + lineIdx * lineH - ta.scrollTop;

    if (y < 0 || y > cv.height) return;

    ctx.fillStyle = 'rgba(91,156,246,0.12)';
    ctx.fillRect(0, y, cv.width, lineH);

    ctx.strokeStyle = 'rgba(91,156,246,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cv.width, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y + lineH);
    ctx.lineTo(cv.width, y + lineH);
    ctx.stroke();

    // Scroll textarea to show line
    const targetScroll = lineIdx * lineH - ta.clientHeight / 2 + lineH;
    if (targetScroll > 0) ta.scrollTop = targetScroll;
  }

  _clearHighlight() {
    const cv = this.$lineHL;
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  }

  _updateLineNums() {
    const lines = (this.$editor.value + '\n').split('\n');
    const lineH = 20;
    const padTop = 8;

    let html = '';
    const ip     = this.cpu.ip;
    const instrs = this.executor?.instrs ?? [];
    const curLine = (ip < instrs.length) ? instrs[ip]?.lineNum : null;

    for (let i = 0; i < lines.length - 1; i++) {
      const ln   = i + 1;
      const isCur = ln === curLine;
      html += `<div style="height:${lineH}px;color:${isCur ? 'var(--yellow)' : 'var(--text3)'}${isCur ? ';font-weight:bold' : ''}">${isCur ? '▶' : ln}</div>`;
    }
    this.$lineNums.innerHTML = html;
    this.$lineNums.scrollTop = this.$editor.scrollTop;
  }

  _syncScroll() {
    this.$lineNums.scrollTop = this.$editor.scrollTop;
    this._updateLineHighlight();
  }

  // ── Status ──
  _setStatus(msg, kind) {
    this.$status.textContent = msg;
    this.$status.className   = 'status-pill' + (kind ? ' ' + kind : '');
  }

  _showRuntimeError(e) {
    const err = { lineNum: e.lineNum, message: e.message, instr: e.instr };
    if (this.executor) this.executor.errors.push(err);
    this._updateErrors();
    this._setStatus(`Error: ${e.message}`, 'error');
    // Switch to errors tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-pane="errors"]').classList.add('active');
    document.getElementById('pane-errors').classList.add('active');
  }

  // ── Example loading ──
  _showExamplePicker() {
    const names = EXAMPLES.map((e, i) => `${i + 1}. ${e.name}`).join('\n');
    const choice = prompt(`Choose an example (1-${EXAMPLES.length}):\n\n${names}`);
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < EXAMPLES.length) this._loadExampleByIdx(idx);
  }

  _loadExampleByIdx(idx) {
    this.$editor.value = EXAMPLES[idx].code;
    this._onCodeChange();
    this.reset();
  }

  _clearEditor() {
    this.$editor.value = '';
    this.reset();
  }
}

// ── Utility ──
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Boot ──
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { window._app = new App(); });
}

// ── Node export (headless engine for tests) ──
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CPU, Parser, Executor, EXAMPLES, hex, hex2, dec };
}
