// 验证群聊提示词里到底给没给她"谁在说话"和"他是谁"的判断依据
import { Agent } from '../src/agent.js';

let pass = 0;
let fail = 0;
const ok = (c, n, e = '') => {
  if (c) {
    pass++;
    console.log(`  PASS  ${n}`);
  } else {
    fail++;
    console.log(`  FAIL  ${n} ${e}`);
  }
};

const roster = {
  all: () => [
    { id: '10001', title: '大肥鱼', aliases: ['大肥鱼', '肥鱼'], isSelf: true, groups: ['619837801'] },
    { id: '10002', title: '主人', name: '三鹿乃粉', isOwner: true, groups: ['619837801'] },
    { id: '10003', title: '', name: '俞', relation: '妈妈', isOwner: false, groups: ['619837801'] },
    { id: '3286254489', title: '', name: '小鲸鱼', isOwner: false, groups: ['619837801'] },
  ],
  selfNames: () => ['大肥鱼', '肥鱼'],
  nameOf: (id) =>
    ({ 10002: '主人', 10003: '俞', 3286254489: '小鲸鱼', 10001: '大肥鱼' })[id] || '对方',
};

const agent = new Agent({
  llm: {},
  tools: { schemas: [], runTool: async () => '' },
  persona: '你是大肥鱼。',
  roster,
  log: () => {},
});

const ctx = {
  selfId: '10001',
  groupId: '619837801',
  senderId: '10003',
  isOwner: false,
  scene: 'group',
  who: '俞',
};

const meta = {
  scene: 'group',
  groupName: '鲸鱼群',
  hint: `最近的聊天记录：
三鹿乃粉: 我是谁
我: 你是我主人爸爸呀，10002那个
三鹿乃粉: @俞 你帮我问问
俞: @大肥鱼 他是谁`,
};

const s = agent.previewSystem(ctx, meta, '他是谁');

console.log('='.repeat(56));
console.log('群聊指代提示词');
console.log('='.repeat(56));

ok(s.includes('俞'), '知道现在说话的是俞');
ok(s.includes('刚才群里在聊什么'), '带上了群聊上下文');
ok(s.includes('三鹿乃粉: @俞 你帮我问问'), '上下文里有前面那句（能推出"他"是谁）');
ok(s.includes('不是你自己'), '明确禁止把"他"当成她/说话人自己');
ok(s.includes('拿不准就别猜'), '给了兜底：不确定就问');
ok(s.includes('你认识的人'), '列出了她认识的人+QQ号');
ok(s.includes('别人喊你'), '告诉她哪些名字是在叫她');
ok(s.includes('10003'), 'QQ 号在提示里');

console.log('\n' + '='.repeat(56));
console.log(`${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);