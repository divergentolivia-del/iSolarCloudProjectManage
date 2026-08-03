// 抽取 app.js 里的合并函数做单测（不依赖 DOM）
const fs = require('fs');
const src = fs.readFileSync('app.js','utf8');
const start = src.indexOf('function eq(a, b)');
const end = src.indexOf('/* 执行合并并提交');
eval(src.slice(start, end));

let pass=0, fail=0;
function ck(name, cond, extra){ if(cond){pass++;console.log('  PASS '+name);} else {fail++;console.log('  FAIL '+name, extra!==undefined?JSON.stringify(extra):'');} }

const base = {
  cycles:[{name:'方案一',online:'8.13',workdays:20,saturdays:1,active:true,note:''}],
  headcount:{ 'APP开发-阳光云':{regular:5,outsource:0,owner:'甲'} },
  locked:[], totals:[{a:1}], board:[], sources:{totals:{fileName:'x.csv'}},
  iterations:[{name:'迭代A',weight:10,selected:false},{name:'迭代B',weight:20,selected:false}],
  rev:10
};
const clone=o=>JSON.parse(JSON.stringify(o));

console.log('\n[场景1] A、B 离线各填自己组 —— 应两份都在');
{
  const A=clone(base); A.headcount['WEB开发-阳光云']={regular:3,outsource:1,owner:'甲'};
  const B=clone(base); B.headcount['后端开发-阳光云']={regular:8,outsource:2,owner:'乙'};
  // A 先恢复提交，服务端变成 A；B 后恢复，以 base 为基线合并
  const r = mergeStates(base, A, B);
  ck('A的填写保留', r.merged.headcount['WEB开发-阳光云'] && r.merged.headcount['WEB开发-阳光云'].regular===3, r.merged.headcount);
  ck('B的填写保留', r.merged.headcount['后端开发-阳光云'] && r.merged.headcount['后端开发-阳光云'].regular===8, r.merged.headcount);
  ck('原有数据保留', r.merged.headcount['APP开发-阳光云'].regular===5);
  ck('无冲突提示', r.conflicts.length===0, r.conflicts);
}

console.log('\n[场景2] 三人离线：A、B 恢复后合并结果再与 C 合并');
{
  const A=clone(base); A.headcount['WEB开发-阳光云']={regular:3,outsource:0,owner:'甲'};
  const B=clone(base); B.headcount['后端开发-阳光云']={regular:8,outsource:0,owner:'乙'};
  const C=clone(base); C.headcount['测试部-应用软件测试-云服务']={regular:4,outsource:0,owner:'丙'};
  const ab = mergeStates(base, A, B).merged;
  const abc = mergeStates(base, ab, C);
  ck('A在', !!abc.merged.headcount['WEB开发-阳光云']);
  ck('B在', !!abc.merged.headcount['后端开发-阳光云']);
  ck('C在', !!abc.merged.headcount['测试部-应用软件测试-云服务']);
  ck('无冲突', abc.conflicts.length===0, abc.conflicts);
}

console.log('\n[场景3] 两人改同一组 —— 应报冲突并保我方');
{
  const S=clone(base); S.headcount['APP开发-阳光云']={regular:6,outsource:0,owner:'甲'};
  const M=clone(base); M.headcount['APP开发-阳光云']={regular:7,outsource:0,owner:'乙'};
  const r = mergeStates(base, S, M);
  ck('保我方值7', r.merged.headcount['APP开发-阳光云'].regular===7, r.merged.headcount['APP开发-阳光云']);
  ck('列出冲突', r.conflicts.length===1 && /APP开发-阳光云/.test(r.conflicts[0]), r.conflicts);
}

console.log('\n[场景4] 一方改、一方没动同一组 —— 不应误报冲突');
{
  const S=clone(base); S.headcount['APP开发-阳光云']={regular:6,outsource:0,owner:'甲'};
  const M=clone(base);
  const r = mergeStates(base, S, M);
  ck('采用服务端值6', r.merged.headcount['APP开发-阳光云'].regular===6);
  ck('无冲突', r.conflicts.length===0, r.conflicts);
}

console.log('\n[场景5] 迭代勾选：各勾各的 —— 应合并');
{
  const S=clone(base); S.iterations[0].selected=true;
  const M=clone(base); M.iterations[1].selected=true;
  const r = mergeStates(base, S, M);
  const sel = r.merged.iterations.filter(i=>i.selected).map(i=>i.name);
  ck('两个都勾上', sel.length===2 && sel.includes('迭代A') && sel.includes('迭代B'), sel);
}

console.log('\n[场景6] 我方重新导入工时 —— 迭代清单应整份跟随我方，不残留旧迭代');
{
  const S=clone(base); S.headcount['WEB开发-阳光云']={regular:3,outsource:0,owner:'甲'};
  const M=clone(base);
  M.totals=[{a:2},{a:3}];
  M.iterations=[{name:'迭代C',weight:5,selected:false}];
  const r = mergeStates(base, S, M);
  ck('迭代清单只剩新的', r.merged.iterations.length===1 && r.merged.iterations[0].name==='迭代C', r.merged.iterations);
  ck('他人人头数仍保留', !!r.merged.headcount['WEB开发-阳光云']);
}

console.log('\n[场景7] 专项锁定：各加各的 / 一方删除');
{
  const S=clone(base); S.locked=[{name:'专项甲',roles:{},line:'',confirmer:'',confirmed:false,note:''}];
  const M=clone(base); M.locked=[{name:'专项乙',roles:{},line:'',confirmer:'',confirmed:false,note:''}];
  const r = mergeStates(base, S, M);
  ck('两条都在', r.merged.locked.length===2, r.merged.locked.map(x=>x.name));

  const b2=clone(base); b2.locked=[{name:'专项丙',roles:{},line:'',confirmer:'',confirmed:false,note:''}];
  const S2=clone(b2); S2.locked=[];                       // 服务端删了
  const M2=clone(b2); M2.locked[0].note='改了备注';        // 我方改了
  const r2 = mergeStates(b2, S2, M2);
  ck('一方删除即删除', r2.merged.locked.length===0, r2.merged.locked);
}

console.log('\n[场景8] 基线缺失 —— 降级不报错');
{
  const r = mergeStates(null, clone(base), clone(base));
  ck('降级标记', r.degraded===true && r.conflicts.length===1, r);
}

console.log('\n[场景9] 版本周期两方都改 —— 应报冲突');
{
  const S=clone(base); S.cycles[0].online='8.20';
  const M=clone(base); M.cycles[0].online='8.25';
  const r = mergeStates(base, S, M);
  ck('保我方8.25', r.merged.cycles[0].online==='8.25');
  ck('列出冲突', r.conflicts.includes('版本周期'), r.conflicts);
}

console.log('\n结果：'+pass+' 通过，'+fail+' 失败');
process.exit(fail?1:0);
