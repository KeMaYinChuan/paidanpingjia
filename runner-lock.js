'use strict';

// 进程内互斥锁：同一时刻只允许一个 ego 任务在跑（拍单 / 晒评价共用）。

let holder = null;

function acquire(name) {
  if (holder) return false;
  holder = name;
  return true;
}

function release(name) {
  if (!name || holder === name) holder = null;
}

function isBusy() {
  return Boolean(holder);
}

function current() {
  return holder;
}

module.exports = { acquire, release, isBusy, current };
