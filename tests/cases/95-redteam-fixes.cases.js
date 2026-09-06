// ================================================================
//  95-redteam-fixes.cases.js
//  Regression test suite for red-team fixes:
//  1. ModR/M invalid base/index register rejection (AX, CX, DX, SP)
//  2. Direct byte address jumps (JMP 0109h)
//  3. Register indirect jumps (JMP AX, CALL BX)
//  4. Safe mathematical expression evaluation in memory operands
//  5. Segment 16-bit offset wraparound
// ================================================================
'use strict';

module.exports = [
  // ── 1. ModR/M addressing register restrictions ──
  { name: 'ModR/M: MOV [AX], 5 is illegal on 8086', code: 'MOV AX, 200h\nMOV [AX], 5\nHLT', expectError: true },
  { name: 'ModR/M: MOV [CX], 5 is illegal on 8086', code: 'MOV CX, 200h\nMOV [CX], 5\nHLT', expectError: true },
  { name: 'ModR/M: MOV [DX], 5 is illegal on 8086', code: 'MOV DX, 200h\nMOV [DX], 5\nHLT', expectError: true },
  { name: 'ModR/M: MOV [SP], 5 is illegal on 8086', code: 'MOV [SP], 5\nHLT', expectError: true },
  { name: 'ModR/M: MOV [BX], 42h is valid', code: 'MOV BX, 200h\nMOV BYTE PTR [BX], 42h\nMOV AL, [BX]\nHLT', regs: { AL: 0x42 } },
  { name: 'ModR/M: MOV [BP], 42h is valid (SS-relative)', code: 'MOV BP, 100h\nMOV BYTE PTR [BP], 42h\nMOV AL, [BP]\nHLT', regs: { AL: 0x42 } },
  { name: 'ModR/M: MOV [SI], 42h is valid', code: 'MOV SI, 200h\nMOV BYTE PTR [SI], 42h\nMOV AL, [SI]\nHLT', regs: { AL: 0x42 } },
  { name: 'ModR/M: MOV [DI], 42h is valid', code: 'MOV DI, 200h\nMOV BYTE PTR [DI], 42h\nMOV AL, [DI]\nHLT', regs: { AL: 0x42 } },
  { name: 'ModR/M: Base+Index [BX+SI] is valid', code: 'MOV BX, 200h\nMOV SI, 4\nMOV BYTE PTR [BX+SI], 99h\nMOV AL, [BX+SI]\nHLT', regs: { AL: 0x99 } },

  // ── 2. Direct address jumps ──
  { name: 'Direct jump: JMP 0109h jumps accurately over code',
    code: 'MOV AX, 1\nJMP 0109h\nMOV AX, 2\nHLT',
    regs: { AX: 1 } },

  // ── 3. Register indirect jumps ──
  { name: 'Indirect jump: JMP AX jumps to target in register',
    code: 'MOV AX, 0109h\nJMP AX\nMOV BX, 2\nHLT',
    regs: { AX: 0x0109, BX: 0 } },

  // ── 4. Safe mathematical expressions in memory operands ──
  { name: 'Math in memory operand: [BX + 2 * 2]',
    code: 'MOV BX, 200h\nMOV BYTE PTR [BX+4], 55h\nMOV AL, [BX+4]\nHLT',
    regs: { AL: 0x55 } },

  // ── 5. Segment 16-bit offset wraparound on stack ──
  { name: 'Stack push/pop across FFFE wrap',
    code: 'MOV SP, 0\nPUSH 1234h\nPOP AX\nHLT',
    regs: { AX: 0x1234, SP: 0 } },
];
