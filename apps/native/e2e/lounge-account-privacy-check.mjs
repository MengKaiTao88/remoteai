import assert from 'node:assert/strict';

export async function verifyNativeAccountPrivacy({ tap, find, nodes, screenshot, scale, broadcast, incoming }) {
  await tap('群聊');
  broadcast({ ...incoming('接口只返回前缀'), sender: { id: 'carol', account: 'carol' } });
  broadcast({ ...incoming('旧记录也只显示前缀'), reply: {
    id: 'old', senderId: 'bob', account: 'bob@example.test', text: '旧引用内容', imageCount: 0,
  } });
  await find('接口只返回前缀'); await find('旧引用内容');
  assert.ok(!(await nodes()).some(node => `${node.text} ${node['content-desc']}`.includes('@example.test')));
  await screenshot(`account-privacy-history-${scale}`);
  await tap('查看 bob 的资料'); await find('个人资料'); await find('bob');
  assert.ok(!(await nodes()).some(node => node.text.includes('@example.test')));
  await screenshot(`account-privacy-profile-${scale}`);
  await tap('返回'); await tap('返回聊天列表'); await find('搜索聊天');
  await tap('返回发现'); await find('在线交流');
  console.log(`PASS native account prefixes, legacy quotes and navigation at font scale ${scale}`);
}
