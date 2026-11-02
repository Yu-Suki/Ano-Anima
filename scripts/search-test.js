// 搜索能力测试
// 用法：node scripts/search-test.js
import { webSearch, fetchUrl, formatResults } from '../src/text/search.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
};

console.log('='.repeat(56));
console.log('网页搜索 / 抓取');
console.log('='.repeat(56));

console.log('\n[1] 中文搜索');
const r1 = await webSearch('DeepSeek 是什么', { count: 4 });
console.log(`  来源：${r1.source}   结果 ${r1.results.length} 条`);
for (const x of r1.results) console.log(`   - ${x.title.slice(0, 40)}  ${x.url.slice(0, 50)}`);
check('能搜到中文内容', r1.results.length > 0, r1.error || `${r1.results.length} 条`);

console.log('\n[2] 英文搜索');
const r2 = await webSearch('mineflayer documentation', { count: 3 });
console.log(`  来源：${r2.source}   结果 ${r2.results.length} 条`);
for (const x of r2.results) console.log(`   - ${x.title.slice(0, 50)}`);
check('能搜到英文内容', r2.results.length > 0, r2.error || '');

console.log('\n[3] 抓取网页正文');
const firstUrl = r2.results[0]?.url;
if (firstUrl) {
  const page = await fetchUrl(firstUrl, { maxChars: 1500 });
  console.log(`  URL: ${firstUrl.slice(0, 60)}`);
  console.log(`  标题: ${page.title || '(无)'}`);
  console.log(`  正文预览: ${(page.text || page.error || '').slice(0, 150)}`);
  check('能抓到网页正文', Boolean(page.text && page.text.length > 100), `${(page.text || '').length} 字`);
} else {
  check('能抓到网页正文', false, '没有可用 URL');
}

console.log('\n[4] 喂给模型的格式');
const formatted = formatResults(r1);
console.log(`  ${formatted.split('\n')[0]}  …`);
check('搜索结果能格式化', formatted.includes(r1.source) && formatted.includes('http'));

console.log('\n[5] 空查询要安全');
const empty = await webSearch('   ');
check('空查询不崩', empty.results.length === 0);

const pass = results.filter((r) => r.pass).length;
console.log('\n' + '='.repeat(56));
console.log(`结果：${pass}/${results.length} 通过`);
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`);
console.log('='.repeat(56));
process.exit(pass === results.length ? 0 : 1);