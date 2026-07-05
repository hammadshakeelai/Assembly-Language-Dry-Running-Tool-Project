// ================================================================
//  AFD — Advanced Fullscreen Debug, web recreation
//  A faithful 80x25 DOS-text recreation of the AFD-Pro debugger,
//  driven by the segmented virtual-8086 engine in app.js.
//
//  Flow: type code in the editor → F1 "locks & loads" it at CS:0100
//  → this authentic AFD screen runs it.  Four regions (red registers,
//  white code, green m1, yellow m2) + command line, exactly like AFD.
//
//  Pure client-side, no build step, scales to any screen.
// ================================================================
'use strict';
(function () {

  // ── DOS 16-colour palette ──
  const PAL = ['#000000','#0000AA','#00AA00','#00AAAA','#AA0000','#AA00AA','#AA5500','#AAAAAA',
               '#555555','#5555FF','#55FF55','#55FFFF','#FF5555','#FF55FF','#FFFF55','#FFFFFF'];
  const BG = 1, GRAY = 7, WHITE = 15, RED = 12, GREEN = 10, YEL = 14, CYAN = 11, DGRAY = 8;

  // IBM CP437 → Unicode (all 256 code points) so memory dumps show authentic glyphs.
  const CP437 =
    ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼' +
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNO' +
    'PQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂' +
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
    '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
    'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
  const cp = b => CP437[b & 0xFF] || ' ';

  const hx = (v, w = 4) => ((v < 0 ? v >>> 0 : v) & (w === 2 ? 0xFF : w === 5 ? 0xFFFFF : 0xFFFF))
                            .toString(16).toUpperCase().padStart(w, '0');
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ── 80x25 VGA text buffer ──
  class VGA {
    constructor() { this.cols = 80; this.rows = 25; this.clear(); }
    clear(f = GRAY, b = BG) {
      this.cell = [];
      for (let y = 0; y < this.rows; y++) {
        const r = [];
        for (let x = 0; x < this.cols; x++) r.push({ c: ' ', f, b });
        this.cell.push(r);
      }
    }
    put(x, y, c, f, b) {
      if (y < 0 || y >= this.rows || x < 0 || x >= this.cols) return;
      const e = this.cell[y][x];
      e.c = c; if (f != null) e.f = f; if (b != null) e.b = b;
    }
    text(x, y, s, f, b) { s = String(s); for (let i = 0; i < s.length; i++) this.put(x + i, y, s[i], f, b); }
    fill(x, y, w, h, c, f, b) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, c, f, b); }
    box(x, y, w, h, f, title, tf, b = BG) {
      const H = '═', V = '║', TL = '╔', TR = '╗', BL = '╚', BR = '╝';
      for (let i = 1; i < w - 1; i++) { this.put(x + i, y, H, f, b); this.put(x + i, y + h - 1, H, f, b); }
      for (let j = 1; j < h - 1; j++) { this.put(x, y + j, V, f, b); this.put(x + w - 1, y + j, V, f, b); }
      this.put(x, y, TL, f, b); this.put(x + w - 1, y, TR, f, b);
      this.put(x, y + h - 1, BL, f, b); this.put(x + w - 1, y + h - 1, BR, f, b);
      if (title) { this.put(x + 2, y, ' ', f, b); this.text(x + 3, y, title, tf == null ? f : tf, b); this.put(x + 3 + title.length, y, ' ', f, b); }
    }
    html() {
      let out = '';
      for (let y = 0; y < this.rows; y++) {
        let row = '', run = '', cf = -1, cb = -1;
        const flush = () => { if (run !== '') { row += `<span style="color:${PAL[cf]};background:${PAL[cb]}">${esc(run)}</span>`; run = ''; } };
        for (let x = 0; x < this.cols; x++) {
          const e = this.cell[y][x];
          if (e.f !== cf || e.b !== cb) { flush(); cf = e.f; cb = e.b; }
          run += e.c;
        }
        flush();
        out += row + (y < this.rows - 1 ? '\n' : '');
      }
      return out;
    }
  }

  // ── The AFD debugger screen ──
  class AfdScreen {
    constructor() {
      this.vga    = new VGA();
      this.opened = false;
      this.cmd    = '';
      this.cmdHist = [];
      this.histPos = 0;
      this.log    = [];          // program output + command messages
      this.outIdx = 0;
      this.m1     = '0200';      // memory-window-1 address spec
      this.m2     = 'DS:SI';     // memory-window-2 address spec
      this.bp     = new Set();   // breakpoint instruction indices
      this.history = [];         // step-back snapshots
      this.help   = false;
      this.progName = 'PROG.COM';
      this.prevRegs = {};
      this.userScreen = false;   // showing the full DOS program screen?
      this.waitingInput = false; // program is blocked reading the keyboard
      this.inputLine = '';       // line being typed into the running program
      this._timer = null;        // interactive run loop
      this.skin = 'modern';      // 'modern' panels | 'authentic' green AFD-Pro look
      this.splash = false;       // AdTec boot logo showing?
      this._build();
    }

    _build() {
      this.$root = document.getElementById('afd-root');
      this.$screen = document.getElementById('afd-screen');
      window.addEventListener('keydown', e => this._onKey(e), true);
      window.addEventListener('resize', () => { if (this.opened) this._fit(); });
      const btn = document.getElementById('btn-afd');
      if (btn) btn.addEventListener('click', () => this.open('modern'));
      const btn2 = document.getElementById('btn-afd2');
      if (btn2) btn2.addEventListener('click', () => this.open('authentic'));
    }

    editor() { return document.getElementById('editor'); }

    // ── Lock current editor source into the code segment & start a session ──
    assemble() {
      const code = this.editor() ? this.editor().value : '';
      this.cpu    = new CPU();
      this.parser = new Parser();
      this.parsed = this.parser.parse(code);
      this.ex     = new Executor(this.cpu, this.parsed);   // assigns addresses + IP
      this.bp = new Set(); this.history = []; this.log = []; this.outIdx = 0;
      this.prevRegs = { ...this.cpu.regs };
      if (this.parsed.errors.length) {
        for (const e of this.parsed.errors) this._err(`L${e.lineNum || '?'}: ${e.message}`);
      } else {
        this._msg(`Loaded ${this.ex.instrs.length} instr  CS:0100  DS:0200  (${this.ex.codeEnd - 0x100} code bytes)`);
      }
    }

    open(skin) {
      this.skin = skin || 'modern';
      this.splash = (this.skin === 'authentic');
      this.userScreen = false; this.waitingInput = false; this.inputLine = '';
      this._stopRun();
      this.assemble();
      this.opened = true;
      this.$root.hidden = false;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (window._app && window._app.stopAuto) window._app.stopAuto();
      this._fit(); this.render();
    }
    close() { this._stopRun(); this.opened = false; this.$root.hidden = true; const ed = this.editor(); if (ed) ed.focus(); }

    _fit() {
      const W = this.$root.clientWidth, H = this.$root.clientHeight;
      // 0.97 safety margin so the 80th column never sits flush against the edge.
      const fs = Math.max(7, Math.min(W / (80 * 0.62), H / (25 * 1.18)) * 0.97);
      this.$screen.style.fontSize = fs + 'px';
    }

    // ── Stepping ──
    _atEnd() { return this.cpu.halted || this.cpu.ip >= this.ex.instrs.length; }
    _stepOne() {
      this.prevRegs = { ...this.cpu.regs };
      this.history.push({ snap: this.cpu.snapshot(), out: this.ex.output.length, tr: this.ex.trace.length, vid: this.ex.video.length });
      if (this.history.length > 2000) this.history.shift();
      this.ex.step();
    }
    trace(n) {
      for (let i = 0; i < n; i++) {
        if (this._atEnd()) { this._msg('Program terminated'); break; }
        try { this._stepOne(); } catch (e) { this._err(e.message); break; }
      }
      this._after();
    }
    proceed() {
      if (this._atEnd()) { this._msg('Program terminated'); this._after(); return; }
      const i = this.cpu.ip, ins = this.ex.instrs[i];
      try {
        if (ins && ins.op === 'CALL') {                 // step over the whole call
          const ret = i + 1; let g = 0;
          do { this._stepOne(); } while (!this._atEnd() && this.cpu.ip !== ret && g++ < 500000);
        } else this._stepOne();
      } catch (e) { this._err(e.message); }
      this._after();
    }
    go(extra) {
      let n = 0;
      try {
        while (!this._atEnd()) {
          if (n > 0 && (this.bp.has(this.cpu.ip) ||
              (extra != null && this.ex.instrs[this.cpu.ip] && this.ex.instrs[this.cpu.ip].addr === extra))) {
            this._msg('Breakpoint at CS:' + hx(this.ex.instrs[this.cpu.ip].addr)); break;
          }
          this._stepOne(); n++;
          if (n > 1000000) { this._err('Halted: step limit (possible infinite loop)'); break; }
        }
      } catch (e) { this._err(e.message); }
      if (this._atEnd() && n > 0) this._msg('Program terminated');
      this._after();
    }
    back() {
      const h = this.history.pop();
      if (!h) { this._msg('No history'); return; }
      this.cpu.restore(h.snap);
      this.ex.output.length = h.out; this.ex.trace.length = h.tr; this.ex.video.length = h.vid;
      this.outIdx = Math.min(this.outIdx, this.ex.output.join('').length);
      this.render();
    }
    _after() { this._syncOut(); this.render(); }

    // ── Output / message log ──
    _syncOut() {
      const full = this.ex.output.join('');
      if (full.length > this.outIdx) { this._pushOut(full.slice(this.outIdx)); this.outIdx = full.length; }
    }
    _pushOut(t) {
      for (const ch of t) {
        if (ch === '\r') continue;
        if (ch === '\n') { this.log.push({ t: '', c: WHITE }); continue; }
        let last = this.log[this.log.length - 1];
        if (!last || last.c !== WHITE) { last = { t: '', c: WHITE }; this.log.push(last); }
        last.t += ch;
      }
      this._trim();
    }
    _msg(t) { this.log.push({ t, c: CYAN }); this._trim(); if (this.opened) this.render(); }
    _err(t) { this.log.push({ t: '! ' + t, c: RED }); this._trim(); if (this.opened) this.render(); }
    _trim() { if (this.log.length > 400) this.log = this.log.slice(-400); }

    // ── Keyboard ──
    _onKey(e) {
      if (!this.opened) { if (e.key === 'F1') { e.preventDefault(); this.open('modern'); } return; }
      if (e.ctrlKey || e.altKey || e.metaKey) return;       // leave browser shortcuts alone
      if (this.splash) { e.preventDefault(); this.splash = false; this.render(); return; }
      if (this.userScreen) { this._onKeyUser(e); return; }
      const k = e.key;
      if (this.help) { e.preventDefault(); this.help = false; this.render(); return; }
      switch (k) {
        case 'Escape': case 'F10': e.preventDefault(); this.close(); return;
        case 'F1': e.preventDefault(); this.trace(1); return;     // step into
        case 'F2': e.preventDefault(); this.proceed(); return;    // step over
        case 'F3': e.preventDefault(); this.back(); return;       // history / undo
        case 'F4': e.preventDefault(); this.help = true; this.render(); return;
        case 'F5': e.preventDefault(); this._toggleBp(); return;
        case 'F6': e.preventDefault(); this.userScreen = true; this.render(); return;  // DOS program screen
        case 'F9': e.preventDefault(); this.runUser(null); return; // run (interactive, live screen)
        case 'Enter': e.preventDefault(); this._runCmd(); return;
        case 'Backspace': e.preventDefault(); this.cmd = this.cmd.slice(0, -1); this.render(); return;
        case 'ArrowUp': e.preventDefault(); this._hist(-1); return;
        case 'ArrowDown': e.preventDefault(); this._hist(1); return;
        case 'PageUp': e.preventDefault(); this.m1 = hx((this._spec(this.m1).off - 0x40) & 0xFFFF); this.render(); return;
        case 'PageDown': e.preventDefault(); this.m1 = hx((this._spec(this.m1).off + 0x40) & 0xFFFF); this.render(); return;
      }
      if (k.length === 1) { e.preventDefault(); this.cmd += k; this.render(); }
    }
    _hist(d) {
      if (!this.cmdHist.length) return;
      this.histPos = Math.max(0, Math.min(this.cmdHist.length, this.histPos + d));
      this.cmd = this.cmdHist[this.histPos] || '';
      this.render();
    }
    _toggleBp() {
      const i = this.cpu.ip;
      if (this.bp.has(i)) { this.bp.delete(i); this._msg('Cleared breakpoint'); }
      else if (this.ex.instrs[i]) { this.bp.add(i); this._msg('Breakpoint at CS:' + hx(this.ex.instrs[i].addr)); }
      this.render();
    }

    // ── Address-spec resolution (m1/m2 and commands) ──
    _hexnum(s) { s = String(s).trim().replace(/h$/i, ''); const v = parseInt(s, 16); return isNaN(v) ? null : v; }
    _evalOff(expr) {
      let s = expr.replace(/\b([0-9A-Fa-f]+)h\b/gi, (_, n) => parseInt(n, 16))
                  .replace(/\b([A-Za-z]\w*)\b/g, (_, r) => this.cpu.isReg(r) ? this.cpu.getReg(r) : parseInt(r, 16));
      if (!/^[\d\s+\-*/()]+$/.test(s)) return NaN;
      try { return Function('"use strict";return(' + s + ')')() & 0xFFFF; } catch (_) { return NaN; }
    }
    _spec(spec, defSeg = 'DS') {
      spec = (spec || '').trim();
      let seg = defSeg;
      const m = spec.match(/^(CS|DS|ES|SS)\s*:\s*(.*)$/i);
      if (m) { seg = m[1].toUpperCase(); spec = m[2].trim(); }
      let off;
      if (spec.startsWith('[') && spec.endsWith(']')) off = this._evalOff(spec.slice(1, -1));
      else if (this.cpu.isReg(spec)) off = this.cpu.getReg(spec);
      else off = this._hexnum(spec);
      if (off == null || isNaN(off)) off = 0;
      off &= 0xFFFF;
      return { seg, off, linear: this.cpu.linear(seg, off) };
    }

    // ── Command line ──
    _runCmd() {
      const line = this.cmd.trim();
      this.cmd = '';
      if (line) { this.cmdHist.push(line); this.histPos = this.cmdHist.length; }
      if (this.pending) { this._resolvePending(line); this.render(); return; }
      if (!line) { this.render(); return; }
      try { this._exec(line); } catch (e) { this._err(e.message); }
      this.render();
    }
    _resolvePending(line) {
      const p = this.pending; this.pending = null;
      if (!line.trim()) return;
      if (p.type === 'reg') { this.cpu.setReg(p.reg, this._hexnum(line) || 0); this._msg(p.reg + '=' + hx(this.cpu.getReg(p.reg))); }
      else if (p.type === 'mem') {
        let a = p.linear;
        for (const tk of line.trim().split(/\s+/)) { const v = this._hexnum(tk); if (v != null) { this.cpu.memWrite(a, v & 0xFF, 8); a = (a + 1) & 0xFFFFF; } }
        this._msg('Memory updated');
      }
    }

    _exec(line) {
      // REG=val / FLAG=val / FL=word   (AFD style: AX=15, CF=1, FL=0060)
      const asn = line.match(/^([A-Za-z]{1,2}[A-Za-z]?)\s*=\s*([0-9A-Fa-f]+)h?$/);
      if (asn) {
        const name = asn[1].toUpperCase(), val = parseInt(asn[2], 16);
        if (name === 'FL' || name === 'FLAGS') { this._setFlags(val); this._msg('FL=' + hx(val)); return; }
        if (name in this.cpu.flags) { this.cpu.flags[name] = val ? 1 : 0; this._msg(name + '=' + this.cpu.flags[name]); return; }
        if (this.cpu.isReg(name) || name === 'IP') { this.cpu.setReg(name === 'IP' ? 'IP' : name, val); this._msg(name + '=' + hx(this.cpu.getReg(name === 'IP' ? 'IP' : name))); return; }
        this._err('Unknown register/flag: ' + name); return;
      }

      const t = line.split(/\s+/);
      const c = t[0].toUpperCase();
      const a = t.slice(1);
      const num = s => this._hexnum(s);

      switch (c) {
        case 'T': this.trace(a[0] != null ? (num(a[0]) || 1) : 1); break;             // trace / step into
        case 'P': { let n = a[0] != null ? (num(a[0]) || 1) : 1; for (let i = 0; i < n && !this._atEnd(); i++) this.proceed(); break; }
        case 'G': { let extra = null; for (const tk of a) { const v = num(tk.replace('=', '')); if (v != null) extra = v & 0xFFFF; } this.go(extra); break; }
        case 'R': {
          if (!a.length) { this._msg('Registers shown'); break; }
          const rn = a[0].toUpperCase();
          if (!(this.cpu.isReg(rn) || rn === 'IP')) { this._err('Unknown register ' + rn); break; }
          if (a[1] != null) { this.cpu.setReg(rn, num(a[1]) || 0); this._msg(rn + '=' + hx(this.cpu.getReg(rn))); }
          else { this.pending = { type: 'reg', reg: rn }; this._msg(rn + ' ' + hx(this.cpu.getReg(rn)) + ' :'); }
          break;
        }
        case 'M1': this.m1 = a.join(' ') || this.m1; break;
        case 'M2': this.m2 = a.join(' ') || this.m2; break;
        case 'D':  if (a.length) this.m1 = a.join(' '); break;
        case 'E': {
          const sp = this._spec(a[0] || '');
          if (a.length > 1) { let ad = sp.linear; for (const tk of a.slice(1)) { const v = num(tk); if (v != null) { this.cpu.memWrite(ad, v & 0xFF, 8); ad = (ad + 1) & 0xFFFFF; } } this._msg('Memory updated'); }
          else { this.pending = { type: 'mem', linear: sp.linear }; this._msg(sp.seg + ':' + hx(sp.off) + ' :'); }
          this.m1 = a[0] || this.m1;
          break;
        }
        case 'F': {                                          // F addr len val
          const sp = this._spec(a[0] || ''), len = num(a[1]), val = num(a[2]);
          if (len == null || val == null) { this._err('F addr len val'); break; }
          for (let i = 0; i < len; i++) this.cpu.memWrite((sp.linear + i) & 0xFFFFF, val & 0xFF, 8);
          this._msg(`Filled ${len} bytes`); break;
        }
        case 'S': {                                          // S addr len b1 b2...
          const sp = this._spec(a[0] || ''), len = num(a[1]), pat = a.slice(2).map(num);
          if (len == null || !pat.length) { this._err('S addr len bytes'); break; }
          let found = 0;
          for (let i = 0; i < len; i++) {
            let ok = true;
            for (let j = 0; j < pat.length; j++) if (this.cpu.mem[(sp.linear + i + j) & 0xFFFFF] !== (pat[j] & 0xFF)) { ok = false; break; }
            if (ok) { this._msg('Found at ' + hx((sp.off + i) & 0xFFFF)); if (++found >= 8) break; }
          }
          if (!found) this._msg('Not found'); break;
        }
        case 'H': { const x = num(a[0]), y = num(a[1]); if (x == null || y == null) { this._err('H v1 v2'); break; } this._msg(hx((x + y) & 0xFFFF) + '  ' + hx((x - y) & 0xFFFF)); break; }
        case 'BP': { const ad = num(a[0]); const idx = ad != null ? this.ex.addrToIdx[ad] : null; if (idx == null) { this._err('No instruction at ' + (a[0] || '?')); break; } this.bp.add(idx); this._msg('Breakpoint at CS:' + hx(ad)); break; }
        case 'BL': this._msg(this.bp.size ? 'BP: ' + [...this.bp].map(i => hx(this.ex.instrs[i].addr)).join(' ') : 'No breakpoints'); break;
        case 'BC': if (!a.length || a[0] === '*') { this.bp.clear(); this._msg('Breakpoints cleared'); } else { const idx = this.ex.addrToIdx[num(a[0])]; if (idx != null) this.bp.delete(idx); this._msg('Cleared'); } break;
        case 'K': { const txt = line.slice(line.indexOf(' ') + 1); if (a.length) { for (const ch of txt) this.cpu.inputBuffer.push(ch.charCodeAt(0)); this.cpu.inputBuffer.push(13); this._msg(`Queued ${txt.length} input chars`); } break; }
        case 'N': this.progName = a.join(' ') || 'PROG.COM'; this._msg('Name: ' + this.progName); break;
        case 'L': this._msg('In-browser AFD runs the JS engine. To boot a real .COM/.EXE use the separate "Real AFD" mode.'); break;
        case 'CLS': this.log = []; this.outIdx = this.ex.output.join('').length; break;
        case 'A': this._msg('Edit source in the editor (Esc to return), then F1 to reload.'); break;
        case 'RELOAD': case 'LOAD': this.assemble(); break;
        case 'Q': case 'QUIT': this.close(); break;
        case '?': case 'HELP': this.help = true; break;
        default: this._err('Unknown command: ' + c + '   (? for help)');
      }
    }

    _flagsWord() {
      const f = this.cpu.flags;
      return f.CF | (f.PF << 2) | (f.AF << 4) | (f.ZF << 6) | (f.SF << 7) | (f.TF << 8) | (f.IF << 9) | (f.DF << 10) | (f.OF << 11);
    }
    _setFlags(w) {
      const f = this.cpu.flags;
      f.CF = w & 1; f.PF = (w >> 2) & 1; f.AF = (w >> 4) & 1; f.ZF = (w >> 6) & 1;
      f.SF = (w >> 7) & 1; f.TF = (w >> 8) & 1; f.IF = (w >> 9) & 1; f.DF = (w >> 10) & 1; f.OF = (w >> 11) & 1;
    }

    // ── Interactive run + live DOS program screen (Wave 3) ──
    _stopRun(keepWaiting) { if (this._timer) { clearInterval(this._timer); this._timer = null; } if (!keepWaiting) this.waitingInput = false; }
    _needsInput() {
      const ins = this.ex.instrs[this.cpu.ip];
      if (!ins || ins.op !== 'INT') return false;
      const n = parseInt(String(ins.args[0] || '').replace(/h$/i, ''), 16);
      const ah = this.cpu.getReg('AH');
      if (n === 0x21) return [0x01, 0x07, 0x08, 0x0A].includes(ah) || (ah === 0x06 && this.cpu.getReg('DL') === 0xFF);
      if (n === 0x16) return ah === 0x00 || ah === 0x10;
      return false;
    }
    runUser(extra) {
      this._stopRun();
      this._timer = setInterval(() => {
        let budget = 4000;
        while (budget-- > 0) {
          if (this._atEnd()) { this._stopRun(); this._msg('Program terminated'); this._after(); return; }
          if (extra != null && this.ex.instrs[this.cpu.ip] && this.ex.instrs[this.cpu.ip].addr === extra) { this._stopRun(); this._msg('Stopped at CS:' + hx(extra)); this._after(); return; }
          if (this.bp.has(this.cpu.ip)) { this._stopRun(); this.userScreen = false; this._msg('Breakpoint at CS:' + hx(this.ex.instrs[this.cpu.ip].addr)); this._after(); return; }
          if (this.cpu.inputBuffer.length === 0 && this._needsInput()) { this.waitingInput = true; this.userScreen = true; this._stopRun(true); this._syncOut(); this.render(); return; }
          try { this._stepOne(); } catch (e) { this._stopRun(); this._err(e.message); this._after(); return; }
        }
        this._syncOut(); this.render();
      }, 16);
    }

    // Replay the output stream + video events into a real 80x25 DOS screen.
    _buildConsole() {
      const ROWS = 25, COLS = 80;
      const grid = []; for (let r = 0; r < ROWS; r++) { const row = []; for (let c = 0; c < COLS; c++) row.push(' '); grid.push(row); }
      let cr = 0, cc = 0;
      const blank = () => { const row = []; for (let c = 0; c < COLS; c++) row.push(' '); return row; };
      const scroll = () => { grid.shift(); grid.push(blank()); cr = ROWS - 1; };
      const nl = () => { cr++; if (cr >= ROWS) scroll(); };
      const out = this.ex.output.join(''), vid = this.ex.video; let vi = 0;
      const applyAt = k => { while (vi < vid.length && vid[vi].at === k) { const m = vid[vi++]; if (m.type === 'cls') { for (let r = 0; r < ROWS; r++) grid[r] = blank(); cr = 0; cc = 0; } else if (m.type === 'pos') { cr = Math.min(ROWS - 1, Math.max(0, m.r | 0)); cc = Math.min(COLS - 1, Math.max(0, m.c | 0)); } } };
      for (let i = 0; i <= out.length; i++) {
        applyAt(i);
        if (i === out.length) break;
        const ch = out[i];
        if (ch === '\r') cc = 0;
        else if (ch === '\n') { cc = 0; nl(); }
        else if (ch === '\b') cc = Math.max(0, cc - 1);
        else if (ch === '\t') { cc = (cc + 8) & ~7; if (cc >= COLS) { cc = 0; nl(); } }
        else { grid[cr][cc] = ch; cc++; if (cc >= COLS) { cc = 0; nl(); } }
      }
      return { grid, cr, cc };
    }
    _drawUserScreen(S) {
      S.clear(GRAY, 0);                              // DOS default: light-grey on black
      const con = this._buildConsole();
      for (let r = 0; r < 25; r++) S.text(0, r, con.grid[r].join('').slice(0, 80), GRAY, 0);
      let cr = con.cr, cc = con.cc;
      if (this.waitingInput) for (let i = 0; i < this.inputLine.length && cc < 80; i++) { S.put(cc, cr, this.inputLine[i], WHITE, 0); cc++; }
      S.put(Math.min(79, cc), cr, '█', WHITE, 0);
      const hint = this.waitingInput ? ' type input, Enter to send ' : ' F9 Run  F6 Debug  Esc Exit ';
      S.text(80 - hint.length, 24, hint, 0, GRAY);
    }
    _onKeyUser(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (k === 'Escape') { e.preventDefault(); this.close(); return; }
      if (k === 'F6') { e.preventDefault(); this._stopRun(); this.userScreen = false; this.render(); return; }
      if (k === 'F9') { e.preventDefault(); this.runUser(null); return; }
      if (this.waitingInput) {
        if (k === 'Enter') {
          e.preventDefault();
          for (const ch of this.inputLine) this.cpu.inputBuffer.push(ch.charCodeAt(0));
          this.cpu.inputBuffer.push(13);
          this.inputLine = ''; this.waitingInput = false; this.runUser(null); return;
        }
        if (k === 'Backspace') { e.preventDefault(); this.inputLine = this.inputLine.slice(0, -1); this.render(); return; }
        if (k.length === 1) { e.preventDefault(); this.inputLine += k; this.render(); return; }
      }
    }

    // ── AdTec boot splash (homage to the real AFD-Pro start screen) ──
    _drawSplash(S) {
      S.clear(GREEN, 0);
      // Big block "AdTec" logo (homage to the real slanted logo)
      const L = {
        A: [' ████ ', '██  ██', '██████', '██  ██', '██  ██'],
        D: ['█████ ', '██  ██', '██  ██', '██  ██', '█████ '],
        T: ['██████', '  ██  ', '  ██  ', '  ██  ', '  ██  '],
        E: ['██████', '██    ', '█████ ', '██    ', '██████'],
        C: [' █████', '██    ', '██    ', '██    ', ' █████'],
      };
      const rows = ['', '', '', '', ''];
      for (const ch of 'ADTEC') for (let r = 0; r < 5; r++) rows[r] += L[ch][r] + ' ';
      for (let r = 0; r < 5; r++) S.text(5, 3 + r, rows[r], GREEN, 0);
      // Bordered info box (centre-right)
      const bx = 41, by = 11, bw = 35, bh = 8;
      for (let i = 0; i < bw; i++) { S.put(bx + i, by, '═', GREEN, 0); S.put(bx + i, by + bh - 1, '═', GREEN, 0); }
      for (let j = 1; j < bh - 1; j++) { S.put(bx, by + j, '║', GREEN, 0); S.put(bx + bw - 1, by + j, '║', GREEN, 0); }
      S.put(bx, by, '╔', GREEN, 0); S.put(bx + bw - 1, by, '╗', GREEN, 0);
      S.put(bx, by + bh - 1, '╚', GREEN, 0); S.put(bx + bw - 1, by + bh - 1, '╝', GREEN, 0);
      const info = [['AFD-Pro', YEL], ['Advanced Fullscreen Debug', GREEN], ['Professional', GREEN],
        ['Version 2.00', GREEN], ['Processor : 8086', GREEN]];
      for (let i = 0; i < info.length; i++) { const [t, c] = info[i]; S.text(bx + Math.floor((bw - t.length) / 2), by + 1 + i, t, c, 0); }
      // Copyright (bottom-right) + prompt (bottom-left), like the real screen
      const c1 = '(C) Copyright AdTec GmbH  1990', c2 = 'all rights reserved';
      S.text(78 - c1.length, 21, c1, GRAY, 0);
      S.text(78 - c2.length, 22, c2, GRAY, 0);
      S.text(1, 24, 'Press any key to continue', GREEN, 0);
    }

    // ── Authentic green-on-black AFD-Pro layout (matches the real screen) ──
    _drawAuthentic(S) {
      const cpu = this.cpu;
      S.clear(GREEN, 0);
      S.fill(0, 0, 80, 1, ' ', WHITE, DGRAY);
      S.text(1, 0, 'DOSBox 0.74, Cpu speed:   3000 cycles, Frameskip  0, Program:     AFD', WHITE, DGRAY);
      const pr = this.prevRegs || {};
      const reg = (x, y, name) => {                       // value turns yellow when it changed this step
        S.text(x, y, name, GREEN);
        const v = cpu.getReg(name), ch = pr[name] !== undefined && pr[name] !== v;
        S.text(x + 3, y, hx(v), ch ? YEL : WHITE);
      };
      reg(1, 1, 'AX'); reg(1, 2, 'BX'); reg(1, 3, 'CX'); reg(1, 4, 'DX');
      reg(11, 1, 'SI'); reg(11, 2, 'DI'); reg(11, 3, 'BP'); reg(11, 4, 'SP');
      reg(21, 1, 'CS'); reg(21, 2, 'DS'); reg(21, 3, 'ES'); reg(21, 4, 'SS');
      reg(31, 1, 'IP');
      S.text(31, 3, 'HS', GREEN); S.text(34, 3, hx(cpu.getReg('CS')), WHITE);
      S.text(31, 4, 'FS', GREEN); S.text(34, 4, hx(cpu.getReg('SS')), WHITE);
      S.text(40, 1, 'Stack', GREEN);
      for (let i = 0; i < 4; i++) { const off = (cpu.getReg('SP') + i * 2) & 0xFFFF; const v = cpu.memRead(cpu.linear('SS', off), 16); S.text(47, 1 + i, '+' + (i * 2) + ' ' + hx(v), i === 0 ? WHITE : GREEN); }
      S.text(60, 1, 'Flags ', GREEN); S.text(66, 1, hx(this._flagsWord() | 0x7002), YEL);  // 8086 reserved bits 1,12-14 = 1
      S.text(57, 3, 'OF DF IF SF ZF AF PF CF', GREEN);
      let vx = 58; for (const fn of ['OF', 'DF', 'IF', 'SF', 'ZF', 'AF', 'PF', 'CF']) { S.text(vx, 4, String(cpu.flags[fn]), cpu.flags[fn] ? YEL : DGRAY); vx += 3; }
      // CMD line
      S.text(1, 5, 'CMD >' + this.cmd, GREEN); S.put(6 + this.cmd.length, 5, '█', WHITE);
      // Region contents: m1 header sits on the separator row; code below the message line
      this._drawAuthM1(S, 6, 41, this.m1, 9);
      this._drawAuthCode(S, 8, 1, 38);
      this._drawAuthM2(S, 17, this.m2);
      // Error / message line at the TOP of the code window (red on error), like real AFD
      const last = this.log[this.log.length - 1];
      if (last) { const red = last.c === RED; S.text(1, 7, (red ? last.t.replace(/^!\s*/, '') : last.t).slice(0, 37), red ? RED : CYAN, 0); }
      // Window boundaries — single-line grey rules between every box
      const LN = DGRAY;
      for (let y = 1; y <= 4; y++) S.put(38, y, '│', LN, 0);          // registers │ stack+flags
      S.text(0, 6, '─'.repeat(39), LN); S.put(38, 6, '┴', LN); S.put(39, 6, '┐', LN);
      S.text(34, 6, '─' + hx(this.cpu.mem[this._spec(this.m1).linear] || 0, 2) + '─', GRAY, 0);  // ─XX─ tag
      for (let y = 7; y <= 15; y++) S.put(39, y, '│', LN, 0);         // code │ m1
      S.text(0, 16, '─'.repeat(80), LN); S.put(39, 16, '┴', LN); S.put(58, 16, '┬', LN);
      for (let y = 17; y <= 22; y++) S.put(58, y, '│', LN, 0);        // m2 │ ascii
      // Status bar (real AFD F-key labels)
      S.fill(0, 24, 80, 1, ' ', 0, GREEN);
      S.text(1, 24, ' 1 Step  2 ProcStep  3 Retrieve  4 Help  5 BRK  6 Screen  9 Run  Esc Exit ', 0, GREEN);
    }
    _drawAuthCode(S, top, x, w) {
      const ins = this.ex.instrs, ip = this.cpu.ip, H = 8;
      if (!ins.length) { S.text(x + 1, top + 1, '(no code — Esc to edit)', DGRAY); return; }
      // Real-AFD scroll: short programs show from the top; longer ones keep the
      // current instruction pinned one line from the top and scroll under it.
      const start = ins.length <= H ? 0 : Math.max(0, ip - 1);
      for (let r = 0; r < H; r++) {
        const i = start + r, y = top + r; if (i >= ins.length) break;
        const o = ins[i], cur = i === ip, bp = this.bp.has(i);
        const bytes = (o.bytes || []).map(v => hx(v, 2)).join('');   // real machine code
        let line = hx(o.addr) + ' ' + bytes.padEnd(12).slice(0, 12) + ' ' + o.raw;
        line = line.length > w ? line.slice(0, w) : line + ' '.repeat(w - line.length);
        S.text(x, y, line, cur ? 0 : (bp ? RED : GREEN), cur ? GRAY : 0);
      }
    }
    _drawAuthM1(S, top, x, spec, rows) {
      const sp = this._spec(spec), rowBase = sp.off & ~7;     // align to 8-byte paragraph
      S.text(x, top, '1', YEL);
      S.text(x + 9, top, '0  1  2  3  4  5  6  7', GREEN);
      for (let r = 0; r < rows; r++) {
        const off = (rowBase + r * 8) & 0xFFFF, lin = this.cpu.linear(sp.seg, off), y = top + 1 + r;
        S.text(x, y, sp.seg + ':' + hx(off), GREEN);
        for (let j = 0; j < 8; j++) {
          const b = this.cpu.mem[(lin + j) & 0xFFFFF];
          S.text(x + 9 + j * 3, y, hx(b, 2), ((off + j) & 0xFFFF) === sp.off ? YEL : WHITE);  // cursor byte
        }
      }
    }
    _drawAuthM2(S, top, spec) {
      const sp = this._spec(spec), rowBase = sp.off & ~15;    // align to 16-byte paragraph
      S.text(1, top, '2', YEL);
      S.text(10, top, '0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F', GREEN);
      for (let r = 0; r < 5; r++) {
        const off = (rowBase + r * 16) & 0xFFFF, lin = this.cpu.linear(sp.seg, off), y = top + 1 + r;
        S.text(1, y, sp.seg + ':' + hx(off), GREEN);
        let asc = '';
        for (let j = 0; j < 16; j++) {
          const b = this.cpu.mem[(lin + j) & 0xFFFFF];
          S.text(10 + j * 3, y, hx(b, 2), ((off + j) & 0xFFFF) === sp.off ? YEL : WHITE);
          asc += cp(b);
        }
        S.text(59, y, asc, GREEN);
      }
    }

    // ── Render the 80x25 screen ──
    render() {
      if (!this.opened) return;
      const S = this.vga;
      // Match the element background to the active skin so the line-height
      // gaps between rows don't show a contrasting colour.
      this.$screen.style.background = (this.skin === 'authentic' || this.userScreen || this.splash) ? '#000000' : '#0000AA';
      if (this.splash)     { this._drawSplash(S);     this.$screen.innerHTML = S.html(); return; }
      if (this.userScreen) { this._drawUserScreen(S);  this.$screen.innerHTML = S.html(); return; }
      if (this.skin === 'authentic') { this._drawAuthentic(S); this.$screen.innerHTML = S.html(); return; }
      S.clear(GRAY, BG);

      // Title bar
      S.fill(0, 0, 80, 1, ' ', BG, GRAY);
      S.text(2, 0, 'AFD-Pro 2.00  Advanced Fullscreen Debug — 8086 Virtual CPU', BG, GRAY);
      const nm = '[' + this.progName + ']';
      S.text(80 - nm.length - 2, 0, nm, BG, GRAY);

      // Regions
      S.box(0, 1, 32, 10, RED,  'Registers', RED);
      S.box(32, 1, 48, 10, WHITE, 'Code  CS:IP', WHITE);
      this._drawRegs(S);
      this._drawCode(S);
      this._drawMem(S, 11, this.m1, GREEN, 'm1');
      this._drawMem(S, 17, this.m2, YEL,   'm2');
      this._drawOut(S);
      this._drawCmd(S);
      if (this.help) this._drawHelp(S);

      this.$screen.innerHTML = S.html();
    }

    _drawRegs(S) {
      const cpu = this.cpu, pr = this.prevRegs;
      const cell = (x, y, name, val, raw) => {
        S.text(x, y, name + '=', RED);
        const ch = pr[raw] !== undefined && pr[raw] !== val;
        S.text(x + 3, y, hx(val), ch ? YEL : WHITE);
      };
      cell(2, 2, 'AX', cpu.getReg('AX'), 'AX'); cell(13, 2, 'BX', cpu.getReg('BX'), 'BX');
      cell(2, 3, 'CX', cpu.getReg('CX'), 'CX'); cell(13, 3, 'DX', cpu.getReg('DX'), 'DX');
      cell(2, 4, 'SP', cpu.getReg('SP'), 'SP'); cell(13, 4, 'BP', cpu.getReg('BP'), 'BP');
      cell(2, 5, 'SI', cpu.getReg('SI'), 'SI'); cell(13, 5, 'DI', cpu.getReg('DI'), 'DI');
      cell(2, 6, 'DS', cpu.getReg('DS'), 'DS'); cell(13, 6, 'ES', cpu.getReg('ES'), 'ES');
      cell(2, 7, 'SS', cpu.getReg('SS'), 'SS'); cell(13, 7, 'CS', cpu.getReg('CS'), 'CS');
      cell(2, 8, 'IP', cpu.getReg('IP'), 'IP');
      // Flags row
      const order = [['O', 'OF'], ['D', 'DF'], ['I', 'IF'], ['S', 'SF'], ['Z', 'ZF'], ['A', 'AF'], ['P', 'PF'], ['C', 'CF']];
      let x = 2;
      for (const [ltr, fn] of order) {
        const on = cpu.flags[fn];
        S.text(x, 9, ltr + (on ? '1' : '0'), on ? GREEN : DGRAY);
        x += 3;
      }
    }

    _drawCode(S) {
      const ins = this.ex.instrs, ip = this.cpu.ip, H = 8;
      if (!ins.length) { S.text(34, 5, '(no code — type a program, Esc to edit)', DGRAY); return; }
      const start = ins.length <= H ? 0 : Math.max(0, ip - 1);   // real-AFD scroll: current pinned near top
      for (let r = 0; r < H; r++) {
        const i = start + r, y = 2 + r;
        if (i >= ins.length) break;
        const o = ins[i], cur = i === ip, isbp = this.bp.has(i);
        const marker = cur ? '►' : (isbp ? '●' : ' ');
        let txt = marker + 'CS:' + hx(o.addr) + ' ' + o.raw.toUpperCase();
        if (txt.length > 46) txt = txt.slice(0, 46);
        else txt = txt + ' '.repeat(46 - txt.length);
        const fg = cur ? BG : (isbp ? RED : WHITE);
        const bg = cur ? WHITE : BG;
        S.text(33, y, txt, fg, bg);
      }
    }

    _drawMem(S, top, spec, col, tag) {
      const sp = this._spec(spec);
      S.box(0, top, 80, 6, col, `${tag}  ${spec}  = ${sp.seg}:${hx(sp.off)}`, col);
      for (let r = 0; r < 4; r++) {
        const base = (sp.off + r * 16) & 0xFFFF, lin = this.cpu.linear(sp.seg, base), y = top + 1 + r;
        S.text(2, y, hx(base), col);
        let hexs = '', asc = '';
        for (let j = 0; j < 16; j++) {
          const b = this.cpu.mem[(lin + j) & 0xFFFFF];
          hexs += hx(b, 2) + ' ';
          asc += cp(b);
        }
        S.text(8, y, hexs, WHITE);
        S.text(8 + 48 + 1, y, asc, col);
      }
    }

    _drawOut(S) {
      S.text(0, 23, '─'.repeat(80), DGRAY);
      const vis = this.log.slice(-1)[0];
      if (vis) S.text(1, 23, ('Out: ' + vis.t).slice(0, 78), vis.c);
    }

    _drawCmd(S) {
      S.fill(0, 24, 80, 1, ' ', WHITE, BG);
      S.text(0, 24, '-' + this.cmd, YEL);
      S.put(1 + this.cmd.length, 24, '█', YEL);
      const hint = 'F1 Step F2 Over F3 Back F5 BP F9 Run F4 Help Esc Exit';
      if (1 + this.cmd.length < 80 - hint.length - 1) S.text(80 - hint.length - 1, 24, hint, CYAN);
    }

    _drawHelp(S) {
      const x = 6, y = 2, w = 68, h = 21;
      S.fill(x, y, w, h, ' ', WHITE, BG);
      S.box(x, y, w, h, CYAN, 'AFD Help  —  press any key to close', YEL);
      const lines = [
        'KEYS',
        '  F1  Step into (Trace)      F2  Step over (Proceed)',
        '  F3  Step back / undo       F5  Toggle breakpoint',
        '  F9  Run (live screen)      F6  DOS program screen',
        '  F4/?  This help            Esc/F10  Exit',
        '',
        'COMMAND LINE  (numbers are hex, AFD-style)',
        '  AX=15   CF=1   FL=0060     set register / flag / flags word',
        '  R AX [val]                 show or edit a register',
        '  T [n]   P [n]   G [addr]    trace / proceed / go (opt. breakpoint)',
        '  m1 <a>  m2 <a>             point a memory window:',
        '       m1 0200   m2 DS:SI   m2 [DI]   m2 ES:[BX]',
        '  E <a> [bytes]  F <a> len v  enter / fill memory',
        '  S <a> len b..              search memory',
        '  BP <a>  BC [*]  BL          breakpoints set / clear / list',
        '  K <text>                   queue keyboard input for the program',
        '  H v1 v2   CLS   N name   Q  hex math / clear / name / quit',
      ];
      for (let i = 0; i < lines.length; i++) S.text(x + 2, y + 2 + i, lines[i], lines[i] === 'KEYS' || lines[i].startsWith('COMMAND') ? YEL : WHITE);
    }
  }

  // ── Boot (after app.js has created window._app) ──
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => { window._afd = new AfdScreen(); });
  }
})();
