'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Backend } = require('../line-tui/backend');

for (const exits of [true, false]) {
  test(`backend close gives cache writes a bounded graceful shutdown: exits=${exits}`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const backend = Object.create(Backend.prototype);
    backend.child = new EventEmitter();
    let ended = 0,
      killed = 0;
    backend.child.stdin = {
      end: () => {
        ended++;
      },
    };
    backend.child.kill = () => {
      killed++;
    };
    backend.close();
    backend.close();
    assert.equal(ended, 1);
    assert.equal(killed, 0);
    if (exits) backend.child.emit('exit', 0);
    t.mock.timers.tick(5000);
    assert.equal(killed, exits ? 0 : 1);
  });
}
