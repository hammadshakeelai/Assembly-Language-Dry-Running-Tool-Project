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
  const cp = b => {
    const byte = b & 0xFF;
    return (byte >= 32 && byte <= 126) ? CP437[byte] : '.';
  };

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
      this.errMsg = '';          // Current error or message displayed on Row 7
      this._build();
    }

    _build() {
      this.$root = document.getElementById('afd-root');
      this.$screen = document.getElementById('afd-screen');
      this.$frame = document.getElementById('dosbox-frame');
      this.isFullscreen = false;
      this.codeScroll = 0;
      window.addEventListener('keydown', e => this._onKey(e), true);
      window.addEventListener('resize', () => { if (this.opened) this._fit(); });
      if (this.$screen) {
        this.$screen.addEventListener('click', () => {
          if (this.splash) {
            this.splash = false;
            this.render();
          }
        });
      }
      const btn = document.getElementById('btn-afd');
      if (btn) btn.addEventListener('click', () => this.open('modern'));
      const btn2 = document.getElementById('btn-afd2');
      if (btn2) btn2.addEventListener('click', () => this.open('authentic'));

      const btnClose = document.getElementById('dosbox-btn-close');
      if (btnClose) btnClose.addEventListener('click', () => this.close());
      const btnMax = document.getElementById('dosbox-btn-max');
      if (btnMax) btnMax.addEventListener('click', () => this.toggleFullscreen());
      const btnMin = document.getElementById('dosbox-btn-min');
      if (btnMin) btnMin.addEventListener('click', () => this.close());
    }

    toggleFullscreen() {
      this.isFullscreen = !this.isFullscreen;
      if (this.$frame) {
        if (this.isFullscreen) this.$frame.classList.add('fullscreen');
        else this.$frame.classList.remove('fullscreen');
      }
      this._fit();
      this.render();
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
      this.codeScroll = 0;
      this.prevRegs = { ...this.cpu.regs };
      if (this.parsed.errors.length) {
        for (const e of this.parsed.errors) this._err(`L${e.lineNum || '?'}: ${e.message}`);
      } else {
        this._msg(`Loaded ${this.ex.instrs.length} instr | CS:0100 | ${this.ex.codeEnd - 0x100}B`);
      }
    }

    open(skin) {
      this.skin = skin || 'modern';
      this.splash = (this.skin === 'authentic');
      this.userScreen = false; this.waitingInput = false; this.inputLine = '';
      this.codeScroll = 0;
      this.errMsg = '';
      this._stopRun();
      this.assemble();
      if (this.skin === 'authentic') {
        this.m1 = '0000';
        this.m2 = '0000';
      }
      this.opened = true;
      this.$root.hidden = false;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      if (window._app && window._app.stopAuto) window._app.stopAuto();
      this._fit(); this.render();
    }
    close() { this._stopRun(); this.opened = false; this.$root.hidden = true; const ed = this.editor(); if (ed) ed.focus(); }

    _fit() {
      const isFullscreen = this.isFullscreen || false;
      const frame = this.$frame || document.getElementById('dosbox-frame');
      const titlebar = document.getElementById('dosbox-titlebar');
      if (frame) {
        if (isFullscreen || this.skin === 'modern') {
          frame.classList.add('fullscreen');
          if (titlebar) titlebar.style.display = this.skin === 'modern' ? 'none' : 'flex';
        } else {
          frame.classList.remove('fullscreen');
          if (titlebar) titlebar.style.display = 'flex';
        }
      }

      const W = (this.$root.clientWidth || 1024) - (isFullscreen ? 12 : 36);
      const H = (this.$root.clientHeight || 768) - (isFullscreen ? 12 : (this.skin === 'modern' ? 24 : 64));
      // Standard 80x25 character grid: font aspect ratio ~0.60
      const fs = Math.max(7, Math.floor(Math.min(W / (80 * 0.60), H / 25)));
      this.$screen.style.fontSize = fs + 'px';
      this.$screen.style.lineHeight = fs + 'px';
    }

    // ── Stepping ──
    _atEnd() { return this.cpu.halted || this.cpu.ip >= this.ex.instrs.length; }
    _stepOne() {
      this.errMsg = '';
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
    _msg(t) { this.errMsg = ''; this.log.push({ t, c: CYAN }); this._trim(); if (this.opened) this.render(); }
    _err(t) { this.errMsg = t.replace(/^!\s*/, ''); this.log.push({ t: '! ' + t, c: RED }); this._trim(); if (this.opened) this.render(); }
    _trim() { if (this.log.length > 400) this.log = this.log.slice(-400); }

    // ── Keyboard ──
    _onKey(e) {
      if (!this.opened) { if (e.key === 'F1') { e.preventDefault(); this.open('modern'); } return; }
      if (e.altKey && e.key === 'Enter') { e.preventDefault(); this.toggleFullscreen(); return; }
      if (e.ctrlKey || e.altKey || e.metaKey) return;       // leave browser shortcuts alone
      if (this.splash) { e.preventDefault(); this.splash = false; this.render(); return; }
      if (this.userScreen) { this._onKeyUser(e); return; }
      const k = e.key;
      if (this.help) { e.preventDefault(); this.help = false; this.render(); return; }
      switch (k) {
        case 'Escape': case 'F10': e.preventDefault(); this.close(); return;
        case 'F1': e.preventDefault(); this.codeScroll = 0; this.trace(1); return;     // step into
        case 'F2': e.preventDefault(); this.codeScroll = 0; this.proceed(); return;    // step over
        case 'F3': e.preventDefault(); this.codeScroll = 0; this.back(); return;       // history / undo
        case 'F4': e.preventDefault(); this.help = true; this.render(); return;
        case 'F5': e.preventDefault(); this._toggleBp(); return;
        case 'F6': e.preventDefault(); this.userScreen = !this.userScreen; this.render(); return;  // toggle DOS program screen
        case 'F7': e.preventDefault(); this.codeScroll = Math.max(-this.cpu.ip, (this.codeScroll || 0) - 1); this.render(); return; // up
        case 'F8': e.preventDefault(); this.codeScroll = (this.codeScroll || 0) + 1; this.render(); return; // dn
        case 'F9': e.preventDefault(); this.codeScroll = 0; this.runUser(null); return; // run (interactive, live screen)
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
      this.errMsg = '';
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
        if (this.cpu.isReg(name) || name === 'IP') {
          this.cpu.setReg(name === 'IP' ? 'IP' : name, val);
          if (name === 'IP') {
            if (this.ex.addrToIdx && this.ex.addrToIdx[val] !== undefined) {
              this.cpu.ip = this.ex.addrToIdx[val];
            } else if (val >= 0 && val < this.ex.instrs.length) {
              this.cpu.ip = val;
            }
          }
          this._msg(name + '=' + hx(this.cpu.getReg(name === 'IP' ? 'IP' : name)));
          return;
        }
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
          if (a[1] != null) {
            const v = num(a[1]) || 0;
            this.cpu.setReg(rn, v);
            if (rn === 'IP') {
              if (this.ex.addrToIdx && this.ex.addrToIdx[v] !== undefined) {
                this.cpu.ip = this.ex.addrToIdx[v];
              } else if (v >= 0 && v < this.ex.instrs.length) {
                this.cpu.ip = v;
              }
            }
            this._msg(rn + '=' + hx(this.cpu.getReg(rn)));
          }
          else { this.pending = { type: 'reg', reg: rn }; this._msg(rn + ' ' + hx(this.cpu.getReg(rn)) + ' :'); }
          break;
        }
        case 'C': { // Compare: C addr1 addr2 len
          if (a.length < 2) { this._err('C addr1 addr2 [len]'); break; }
          const sp1 = this._spec(a[0]), sp2 = this._spec(a[1]), len = num(a[2]) || 16;
          let diff = -1;
          for (let i = 0; i < len; i++) {
            if (this.cpu.mem[(sp1.linear + i) & 0xFFFFF] !== this.cpu.mem[(sp2.linear + i) & 0xFFFFF]) { diff = i; break; }
          }
          if (diff === -1) this._msg(`Identical (${len} bytes)`);
          else {
            this.m1 = hx((sp1.off + diff) & 0xFFFF);
            this.m2 = hx((sp2.off + diff) & 0xFFFF);
            this._msg(`Diff at +${hx(diff, 2)} (${sp1.seg}:${hx((sp1.off+diff)&0xFFFF)} vs ${sp2.seg}:${hx((sp2.off+diff)&0xFFFF)})`);
          }
          break;
        }
        case 'CP': { // Copy: CP src dst len
          if (a.length < 2) { this._err('CP src dst [len]'); break; }
          const spSrc = this._spec(a[0]), spDst = this._spec(a[1]), len = num(a[2]) || 1;
          for (let i = 0; i < len; i++) {
            this.cpu.mem[(spDst.linear + i) & 0xFFFFF] = this.cpu.mem[(spSrc.linear + i) & 0xFFFFF];
          }
          this._msg(`Copied ${len} bytes`);
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
        default: this.skin === 'authentic' ? this._err('Unknown command') : this._err('Unknown command: ' + c + '   (? for help)');
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

    // ── AdTec boot splash (pixel-perfect to genuine AFD-Pro start screen) ──
    _drawSplash(S) {
      const BLACK = 0, GRAY = 7, GREEN = 10, WHITE = 15;
      S.clear(GREEN, BLACK);

      const LOGO_STRIPS = [
        '                                  ▀▀▀▀                                          ',
        '                                  ▀▀▀▀                                          ',
        '                     ▀  ▀▀▀▀▀▀▀▀▀ ▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ',
        '                   ▀▀▀  ▀▀▀▀▀▀▀▀▀ ▀▀▀▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ',
        '                 ▀▀▀▀▀            ▀▀▀▀      ▀▀▀▀                                ',
        '               ▀▀▀▀▀▀▀            ▀▀▀▀      ▀▀▀▀                                ',
        '             ▀▀▀▀▀▀▀▀▀            ▀▀▀▀      ▀▀▀▀      ▀▀▀▀▀▀▀         ▀▀▀▀▀▀▀   ',
        '           ▀▀▀▀▀  ▀▀▀▀            ▀▀▀▀      ▀▀▀▀    ▀▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀▀ ',
        '         ▀▀▀▀▀    ▀▀▀▀            ▀▀▀▀      ▀▀▀▀   ▀▀▀▀     ▀▀▀▀   ▀▀▀▀         ',
        '       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀      ▀▀▀▀▀▀▀▀▀▀      ▀▀▀▀  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ▀▀▀▀          ',
        '     ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀    ▀▀▀▀▀▀▀▀▀▀▀▀      ▀▀▀▀   ▀▀▀▀            ▀▀▀▀         ',
        '   ▀▀▀▀▀          ▀▀▀▀   ▀▀▀▀▀   ▀▀▀▀▀      ▀▀▀▀    ▀▀▀▀▀▀▀▀▀▀▀     ▀▀▀▀▀▀▀▀▀▀▀ ',
        ' ▀▀▀▀▀            ▀▀▀▀  ▀▀▀▀▀     ▀▀▀▀      ▀▀▀▀      ▀▀▀▀▀▀▀         ▀▀▀▀▀▀▀   ',
        '                         ▀▀▀▀▀   ▀▀▀▀▀                                          ',
        '                          ▀▀▀▀▀▀▀▀▀▀▀▀                                          ',
        '                            ▀▀▀▀▀▀▀▀▀▀                                          ',
      ];

      // Draw 16 logo strips with scanline appearance
      for (let r = 0; r < 16; r++) {
        const line = LOGO_STRIPS[r];
        const maxCol = r >= 13 ? 39 : 80;
        for (let c = 0; c < maxCol; c++) {
          if (line[c] === '▀') S.put(c, r, '▀', GREEN, BLACK);
        }
      }

      // Bordered info box (centre-right, rows 13..19, cols 40..78)
      const bx = 40, by = 13, bw = 39, bh = 7;
      for (let i = 0; i < bw; i++) {
        S.put(bx + i, by, '═', WHITE, BLACK);
        S.put(bx + i, by + bh - 1, '═', WHITE, BLACK);
      }
      for (let j = 1; j < bh - 1; j++) {
        S.put(bx, by + j, '║', WHITE, BLACK);
        S.put(bx + bw - 1, by + j, '║', WHITE, BLACK);
      }
      S.put(bx, by, '╔', WHITE, BLACK);
      S.put(bx + bw - 1, by, '╗', WHITE, BLACK);
      S.put(bx, by + bh - 1, '╚', WHITE, BLACK);
      S.put(bx + bw - 1, by + bh - 1, '╝', WHITE, BLACK);

      const info = [
        'AFD-Pro',
        'Advanced Fullscreen Debug',
        'Professional',
        'Version 2.00',
        'Processor  : 80286'
      ];
      for (let i = 0; i < info.length; i++) {
        const t = info[i];
        const tx = bx + Math.floor((bw - t.length) / 2);
        S.text(tx, by + 1 + i, t, WHITE, BLACK);
      }

      // Copyright lines centered beneath the box
      const c1 = '(C) Copyright AdTec GmbH  1990';
      const c2 = 'all rights reserved';
      S.text(bx + Math.floor((bw - c1.length) / 2), 21, c1, WHITE, BLACK);
      S.text(bx + Math.floor((bw - c2.length) / 2), 22, c2, WHITE, BLACK);

      // Prompt on bottom row
      S.text(1, 24, 'Press any key to continue', GREEN, BLACK);
    }

    // ── Authentic green-on-black AFD-Pro layout (pixel-accurate to genuine AFD.EXE) ──
    _drawAuthentic(S) {
      const cpu = this.cpu;
      const BLACK = 0, GRAY = 7, GREEN = 10, YEL = 14, RED = 12, WHITE = 15;
      S.clear(GREEN, BLACK);
      const pr = this.prevRegs || {};

      // Register display helper
      const reg = (x, y, name) => {
        S.text(x, y, name, GRAY, BLACK);
        const v = cpu.getReg(name);
        const ch = pr[name] !== undefined && pr[name] !== v;
        S.text(x + 3, y, hx(v), ch ? YEL : GREEN, BLACK);
      };

      // Row 0: AX SI CS IP Stack +0 Flags
      reg(0, 0, 'AX'); reg(9, 0, 'SI'); reg(18, 0, 'CS'); reg(27, 0, 'IP');
      S.text(41, 0, 'Stack', GRAY, BLACK);
      S.text(47, 0, '+0', GRAY, BLACK);
      const sp0 = cpu.getReg('SP');
      const v0 = cpu.memRead(cpu.linear('SS', sp0), 16);
      S.text(50, 0, hx(v0), GREEN, BLACK);
      S.text(56, 0, 'Flags', GRAY, BLACK);
      const flWord = this._flagsWord() | 0x7202; // 8086 reserved bits
      S.text(62, 0, hx(flWord), GREEN, BLACK);

      // Row 1: BX DI DS +2
      reg(0, 1, 'BX'); reg(9, 1, 'DI'); reg(18, 1, 'DS');
      S.text(47, 1, '+2', GRAY, BLACK);
      const v2 = cpu.memRead(cpu.linear('SS', (sp0 + 2) & 0xFFFF), 16);
      S.text(50, 1, hx(v2), GREEN, BLACK);

      // Row 2: CX BP ES HS +4 Flags names
      reg(0, 2, 'CX'); reg(9, 2, 'BP'); reg(18, 2, 'ES');
      S.text(27, 2, 'HS', GRAY, BLACK); S.text(30, 2, hx(cpu.getReg('CS')), GREEN, BLACK);
      S.text(47, 2, '+4', GRAY, BLACK);
      const v4 = cpu.memRead(cpu.linear('SS', (sp0 + 4) & 0xFFFF), 16);
      S.text(50, 2, hx(v4), GREEN, BLACK);
      const flagNames = ['OF', 'DF', 'IF', 'SF', 'ZF', 'AF', 'PF', 'CF'];
      let fx = 56;
      for (const fn of flagNames) {
        S.text(fx, 2, fn, GRAY, BLACK);
        fx += 3;
      }

      // Row 3: DX SP SS FS +6 Flags values
      reg(0, 3, 'DX'); reg(9, 3, 'SP'); reg(18, 3, 'SS');
      S.text(27, 3, 'FS', GRAY, BLACK); S.text(30, 3, hx(cpu.getReg('SS')), GREEN, BLACK);
      S.text(47, 3, '+6', GRAY, BLACK);
      const v6 = cpu.memRead(cpu.linear('SS', (sp0 + 6) & 0xFFFF), 16);
      S.text(50, 3, hx(v6), GREEN, BLACK);
      let bx = 57;
      for (const fn of flagNames) {
        const bit = cpu.flags[fn] ? 1 : 0;
        S.text(bx, 3, String(bit), bit ? YEL : GREEN, BLACK);
        bx += 3;
      }

      // Row 4: Top divider line (47 cols left, divider at col 47, 32 cols right)
      const LN = GRAY;
      S.put(0, 4, '┌', LN, BLACK);
      for (let x = 1; x <= 46; x++) S.put(x, 4, '─', LN, BLACK);
      S.put(47, 4, '┬', LN, BLACK);
      for (let x = 48; x < 80; x++) S.put(x, 4, '─', LN, BLACK);

      // Row 5: CMD line (left) & M1 Header (right)
      S.put(0, 5, '│', LN, BLACK);
      S.text(1, 5, 'CMD >', GREEN, BLACK);
      const cmdStr = this.cmd.slice(0, 40);
      S.text(6, 5, cmdStr, GREEN, BLACK);
      S.put(6 + cmdStr.length, 5, '█', GREEN, BLACK);
      for (let x = 7 + cmdStr.length; x < 47; x++) S.put(x, 5, ' ', GREEN, BLACK);
      S.put(47, 5, '│', LN, BLACK);

      // Right: M1 Header
      S.put(48, 5, ' ', GREEN, BLACK);
      S.put(49, 5, '1', BLACK, GRAY); // Inverted '1' badge
      for (let x = 50; x < 57; x++) S.put(x, 5, ' ', GREEN, BLACK);
      let colX = 57;
      for (let j = 0; j < 8; j++) {
        S.put(colX, 5, String(j), GREEN, BLACK);
        colX += 3;
      }
      S.put(79, 5, ' ', GREEN, BLACK);

      // Row 6: CMD bottom border with -XX- byte tag and M1 Row 0
      S.put(0, 6, '└', LN, BLACK);
      for (let x = 1; x < 43; x++) S.put(x, 6, '─', LN, BLACK);
      const spM1 = this._spec(this.m1);
      const targetByte = this.cpu.mem[spM1.linear] || 0;
      const byteTag = '-' + hx(targetByte, 2) + '-';
      S.text(43, 6, byteTag, GRAY, BLACK);
      S.put(47, 6, '┤', LN, BLACK);
      this._drawAuthM1Row(S, 6, spM1, 0);

      // Row 7: Message/error line on left; M1 Row 1 on right
      for (let x = 0; x < 47; x++) S.put(x, 7, ' ', GREEN, BLACK);
      if (this.errMsg) {
        const em = this.errMsg.slice(0, 39);
        S.text(7, 7, em, RED, BLACK);
      }
      S.put(47, 7, '│', LN, BLACK);
      this._drawAuthM1Row(S, 7, spM1, 1);

      // Row 8: Active instruction in inverse-video across cols 0..46; M1 Row 2 on right
      this._drawAuthActiveCode(S, 8, 47);
      S.put(47, 8, '│', LN, BLACK);
      this._drawAuthM1Row(S, 8, spM1, 2);

      // Rows 9..15: Next 7 code disassembly instructions on left; M1 Rows 3..9 on right
      this._drawAuthRestCode(S, 9, 7, 47);
      for (let r = 3; r < 10; r++) {
        const y = 6 + r;
        S.put(47, y, '│', LN, BLACK);
        this._drawAuthM1Row(S, y, spM1, r);
      }

      // Row 16: Separator between Code/M1 and M2
      for (let x = 0; x <= 46; x++) S.put(x, 16, '─', LN, BLACK);
      S.put(47, 16, '┴', LN, BLACK);
      for (let x = 48; x <= 60; x++) S.put(x, 16, '─', LN, BLACK);
      S.put(61, 16, '┬', LN, BLACK);
      for (let x = 62; x < 80; x++) S.put(x, 16, '─', LN, BLACK);

      // Row 17: M2 Header
      S.put(0, 17, ' ', GRAY, BLACK);
      S.put(1, 17, '2', BLACK, GRAY); // Inverted '2' badge
      for (let x = 2; x < 10; x++) S.put(x, 17, ' ', GREEN, BLACK);
      S.text(10, 17, '0  1  2  3  4  5  6  7', GREEN, BLACK);
      S.text(33, 17, '   8  9  A  B  C  D  E  F', GREEN, BLACK);
      S.put(59, 17, ' ', GREEN, BLACK);
      S.put(60, 17, ' ', GREEN, BLACK);
      S.put(61, 17, '│', LN, BLACK);
      for (let x = 62; x < 80; x++) S.put(x, 17, ' ', GREEN, BLACK);

      // Rows 18..22: 5 M2 data rows
      this._drawAuthM2(S, 18, this.m2);

      // Row 23: Bottom border closing M2
      for (let x = 0; x <= 60; x++) S.put(x, 23, '─', LN, BLACK);
      S.put(61, 23, '┴', LN, BLACK);
      for (let x = 62; x < 80; x++) S.put(x, 23, '─', LN, BLACK);

      // Row 24: Status bar directly beneath Row 23 (NO line between Row 23 and 24)
      this._drawAuthStatus(S, 24);
    }

    _drawAuthActiveCode(S, y, w = 47) {
      const BLACK = 0, GRAY = 7;
      const ins = this.ex.instrs, ip = this.cpu.ip;
      if (!ins.length) {
        let line = '(no code — Esc to edit)'.padEnd(w, ' ');
        S.text(0, y, line, BLACK, GRAY);
        return;
      }
      const scroll = this.codeScroll || 0;
      const i = Math.max(0, Math.min(ins.length - 1, ip + scroll));
      const o = ins[i];
      if (!o) {
        S.text(0, y, ''.padEnd(w, ' '), BLACK, GRAY);
        return;
      }
      const bytes = (o.bytes || []).map(v => hx(v, 2)).join('');
      const addrStr = hx(o.addr);
      const bytesStr = bytes.padEnd(8, ' ').slice(0, 8);
      const opStr = (o.op || '').padEnd(7, ' ');
      const argsStr = (o.args ? o.args.join(',') : '');
      let line = addrStr + ' ' + bytesStr + '        ' + opStr + argsStr;
      line = line.padEnd(w, ' ').slice(0, w);
      S.text(0, y, line, BLACK, GRAY);
    }

    _drawAuthRestCode(S, top, count, w = 47) {
      const BLACK = 0, GRAY = 7, RED = 12;
      const ins = this.ex.instrs, ip = this.cpu.ip;
      const scroll = this.codeScroll || 0;
      const base = Math.max(0, ip + scroll);
      for (let r = 0; r < count; r++) {
        const y = top + r;
        const i = base + 1 + r;
        if (i >= ins.length) {
          S.text(0, y, ''.padEnd(w, ' '), GRAY, BLACK);
          continue;
        }
        const o = ins[i];
        const bp = this.bp.has(i);
        const bytes = (o.bytes || []).map(v => hx(v, 2)).join('');
        const addrStr = hx(o.addr);
        const bytesStr = bytes.padEnd(8, ' ').slice(0, 8);
        const opStr = (o.op || '').padEnd(7, ' ');
        const argsStr = (o.args ? o.args.join(',') : '');
        let line = addrStr + ' ' + bytesStr + '        ' + opStr + argsStr;
        line = line.padEnd(w, ' ').slice(0, w);
        S.text(0, y, line, bp ? RED : GRAY, BLACK);
      }
    }

    _drawAuthM1Row(S, y, spM1, rowIndex) {
      const BLACK = 0, GRAY = 7, GREEN = 10, YEL = 14;
      const rowBase = spM1.off & ~7;
      const off = (rowBase + rowIndex * 8) & 0xFFFF;
      const lin = this.cpu.linear(spM1.seg, off);
      const isCursorRow = (spM1.off >= off && spM1.off < off + 8);
      const addrColor = isCursorRow ? GREEN : GRAY;

      // Cols 48..54: DS:0000
      S.text(48, y, spM1.seg, GRAY, BLACK);
      S.put(50, y, ':', addrColor, BLACK);
      S.text(51, y, hx(off), addrColor, BLACK);
      S.put(55, y, ' ', GREEN, BLACK);

      for (let j = 0; j < 8; j++) {
        const b = this.cpu.mem[(lin + j) & 0xFFFFF] || 0;
        const isCursor = ((off + j) & 0xFFFF) === spM1.off;
        S.text(56 + j * 3, y, hx(b, 2), isCursor ? YEL : GREEN, BLACK);
        if (j < 7) S.put(58 + j * 3, y, ' ', GREEN, BLACK);
      }
      S.put(79, y, ' ', GREEN, BLACK);
    }

    _drawAuthM2(S, startY, spec) {
      const BLACK = 0, GRAY = 7, GREEN = 10, YEL = 14;
      const sp = this._spec(spec);
      const rowBase = sp.off & ~15;
      const LN = GRAY;
      for (let r = 0; r < 5; r++) {
        const off = (rowBase + r * 16) & 0xFFFF;
        const lin = this.cpu.linear(sp.seg, off);
        const y = startY + r;
        const isCursorRow = (sp.off >= off && sp.off < off + 16);
        const addrColor = isCursorRow ? GREEN : GRAY;

        S.text(0, y, sp.seg, GRAY, BLACK);
        S.put(2, y, ':', addrColor, BLACK);
        S.text(3, y, hx(off), addrColor, BLACK);
        S.text(7, y, '   ', GREEN, BLACK);

        // First 8 hex bytes
        let bx1 = 10;
        for (let j = 0; j < 8; j++) {
          const b = this.cpu.mem[(lin + j) & 0xFFFFF] || 0;
          const isCursor = ((off + j) & 0xFFFF) === sp.off;
          S.text(bx1, y, hx(b, 2), isCursor ? YEL : GREEN, BLACK);
          bx1 += 3;
        }

        // Second 8 hex bytes
        S.text(33, y, '   ', GREEN, BLACK);
        let bx2 = 36;
        for (let j = 8; j < 16; j++) {
          const b = this.cpu.mem[(lin + j) & 0xFFFFF] || 0;
          const isCursor = ((off + j) & 0xFFFF) === sp.off;
          S.text(bx2, y, hx(b, 2), isCursor ? YEL : GREEN, BLACK);
          bx2 += 3;
        }

        // Vertical separator at col 61
        S.put(59, y, ' ', GREEN, BLACK);
        S.put(60, y, ' ', GREEN, BLACK);
        S.put(61, y, '│', LN, BLACK);
        S.put(62, y, ' ', GREEN, BLACK);

        // ASCII pane
        for (let j = 0; j < 8; j++) {
          const b = this.cpu.mem[(lin + j) & 0xFFFFF] || 0;
          const isCursor = ((off + j) & 0xFFFF) === sp.off;
          S.put(63 + j, y, cp(b), isCursor ? YEL : GREEN, BLACK);
        }
        S.put(71, y, ' ', GREEN, BLACK);
        for (let j = 8; j < 16; j++) {
          const b = this.cpu.mem[(lin + j) & 0xFFFFF] || 0;
          const isCursor = ((off + j) & 0xFFFF) === sp.off;
          S.put(72 + (j - 8), y, cp(b), isCursor ? YEL : GREEN, BLACK);
        }
      }
    }

    _drawAuthStatus(S, y) {
      const BLACK = 0, GRAY = 7, WHITE = 15;
      const buttons = [
        { k: ' 1', l: ' Step   ' },
        { k: ' 2', l: 'ProcStep' },
        { k: ' 3', l: 'Retrieve' },
        { k: ' 4', l: 'Help ON ' },
        { k: ' 5', l: 'BRK Menu' },
        { k: ' 6', l: '    ' },
        { k: ' 7', l: ' up ' },
        { k: ' 8', l: ' dn ' },
        { k: ' 9', l: ' le ' },
        { k: '10', l: ' ri ' },
      ];
      let x = 0;
      for (const btn of buttons) {
        S.text(x, y, btn.k, WHITE, BLACK);
        x += btn.k.length;
        S.text(x, y, btn.l, BLACK, GRAY);
        x += btn.l.length;
      }
      while (x < 80) S.put(x++, y, ' ', WHITE, BLACK);
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
