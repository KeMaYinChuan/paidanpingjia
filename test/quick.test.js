'use strict';

process.env.TEST_MODE = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeInput,
  extractUrl,
  allowedHost,
  profileDirFor,
  splitSku,
} = require('../quick-server');

test('SKU 按分隔符拆成多级规格', () => {
  assert.deepEqual(splitSku(' 白色 / M '), ['白色', 'M']);
  assert.deepEqual(splitSku('白色，M'), ['白色', 'M']);
  assert.deepEqual(splitSku('白色'), ['白色']);
  assert.deepEqual(splitSku('白色 / 白色'), ['白色']);
});

test('从分享文本提取商品链接', () => {
  const text =
    '【淘宝】https://item.taobao.com/item.htm?id=1234567890 点击链接直接打开';
  assert.equal(extractUrl(text), 'https://item.taobao.com/item.htm?id=1234567890');
});

test('归一化拍单参数', () => {
  const result = normalizeInput({
    url: 'https://detail.tmall.com/item.htm?id=9988',
    sku: ' 白色 / M ',
    account: ' 我的账号 ',
    quantity: 3,
    autoSubmit: 1,
  });
  assert.equal(result.url, 'https://detail.tmall.com/item.htm?id=9988');
  assert.equal(result.sku, '白色 / M');
  assert.equal(result.account, '我的账号');
  assert.equal(result.quantity, 3);
  assert.equal(result.autoSubmit, true);
});

test('两个规格值输入框合成 SKU 值列表', () => {
  const result = normalizeInput({
    url: 'https://item.taobao.com/item.htm?id=123',
    sku1: ' 白色 ',
    sku2: ' M ',
  });
  assert.equal(result.sku, '白色 / M');
  assert.deepEqual(result.levels, ['白色', 'M']);

  const onlyOne = normalizeInput({
    url: 'https://item.taobao.com/item.htm?id=123',
    sku1: '白色',
    sku2: '',
  });
  assert.equal(onlyOne.sku, '白色');
  assert.deepEqual(onlyOne.levels, ['白色']);

  assert.throws(
    () => normalizeInput({ url: 'https://item.taobao.com/item.htm?id=1', sku1: ' ', sku2: '' }),
    /请填写规格值/,
  );
});

test('数量自动限制在 1 到 99', () => {
  const base = {
    url: 'https://item.taobao.com/item.htm?id=1',
    sku: '白色 / M',
  };
  assert.equal(normalizeInput({ ...base, quantity: 0 }).quantity, 1);
  assert.equal(normalizeInput({ ...base, quantity: 200 }).quantity, 99);
});

test('拒绝非淘宝链接', () => {
  assert.throws(
    () =>
      normalizeInput({
        url: 'https://example.com/item?id=1',
        sku: '默认',
      }),
    /只支持淘宝、天猫商品链接/,
  );
});

test('登录档案路径不包含账号明文', () => {
  const profile = profileDirFor('my-taobao-account');
  assert.ok(!profile.includes('my-taobao-account'));
  assert.equal(profile, profileDirFor('my-taobao-account'));
  assert.notEqual(profile, profileDirFor('another-account'));
  assert.equal(allowedHost('item.taobao.com'), true);
  assert.equal(allowedHost('www.tmall.com'), true);
  assert.equal(allowedHost('evil-taobao.com'), false);
});
