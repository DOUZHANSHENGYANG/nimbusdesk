import test from 'node:test';
import assert from 'node:assert/strict';
import { recordShortcut } from './shortcut-keys.ts';

const key = (code, extra = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false, getModifierState: () => false, ...extra });

test('records native modifier order and physical letter keys independent of typed characters', () => {
  assert.deepEqual(recordShortcut(key('Space', {ctrlKey: true, altKey: true})), {type: 'recorded', shortcut: 'Ctrl+Alt+Space'});
  assert.deepEqual(recordShortcut(key('KeyK', {ctrlKey: true, shiftKey: true})), {type: 'recorded', shortcut: 'Ctrl+Shift+K'});
  assert.deepEqual(recordShortcut(key('Digit2', {altKey: true})), {type: 'recorded', shortcut: 'Alt+2'});
});

test('symbol keys use native code names instead of ambiguous shifted symbols', () => {
  for (const code of ['Equal', 'Minus', 'Backquote', 'Backslash', 'BracketLeft', 'BracketRight', 'Comma', 'Period', 'Quote', 'Semicolon', 'Slash']) {
    assert.deepEqual(recordShortcut(key(code, {ctrlKey: true, shiftKey: true})), {type: 'recorded', shortcut: `Ctrl+Shift+${code}`});
  }
});

test('Meta is represented by native Super and supports navigation, function and numpad keys', () => {
  for (const code of ['KeyA', 'ArrowUp', 'F24', 'NumpadAdd']) {
    assert.equal(recordShortcut(key(code, {metaKey: true})).shortcut, `Super+${code === 'KeyA' ? 'A' : code}`);
  }
});

test('Escape and Tab cancel without becoming global shortcuts', () => {
  for (const code of ['Escape', 'Tab']) assert.deepEqual(recordShortcut(key(code, {ctrlKey: true})), {type: 'cancel'});
});

test('requires a native global modifier; Shift alone and ordinary typing stay unrecorded', () => {
  for (const extra of [{}, {shiftKey: true}]) assert.deepEqual(recordShortcut(key('KeyA', extra)), {type: 'ignored', reason: 'typing'});
  assert.deepEqual(recordShortcut(key('ControlLeft', {ctrlKey: true})), {type: 'ignored', reason: 'modifier'});
});

test('composition, AltGraph and repeated keys cannot create accidental global shortcuts', () => {
  assert.deepEqual(recordShortcut(key('KeyK', {ctrlKey: true, isComposing: true})), {type: 'ignored', reason: 'composition'});
  assert.deepEqual(recordShortcut(key('KeyQ', {ctrlKey: true, altKey: true, getModifierState: name => name === 'AltGraph'})), {type: 'ignored', reason: 'composition'});
  assert.deepEqual(recordShortcut(key('KeyK', {ctrlKey: true, repeat: true})), {type: 'ignored', reason: 'repeat'});
});

test('unknown or layout-specific physical keys are rejected without guessing', () => {
  for (const code of ['', 'Unidentified', 'IntlBackslash', 'F25', 'MediaPlayPause', 'KeyAA']) assert.equal(recordShortcut(key(code, {ctrlKey: true})).type, 'ignored');
});
