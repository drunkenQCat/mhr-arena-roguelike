const fs = require('node:fs');
const assert = require('node:assert/strict');
const input = JSON.parse(fs.readFileSync(process.argv[2] || 'docs/evidence/2026-10-15/base-expedition-101.json', 'utf8'));
const catalog = Array.isArray(input) ? input : [input];
const base = catalog.find(q => q.id === 101);
assert(base && base.normal._QuestType === 32, 'Expected original village expedition 101');
assert(!catalog.some(q => q.id === 900101), 'Custom ID collision');
const n = base.normal, e = base.enemy;
const mapFields = (src, pairs) => Object.fromEntries(pairs.split(' ').map(pair => {
  const [key, field] = pair.split(':');
  assert.notEqual(src[field], undefined, field);
  return [key, structuredClone(src[field])];
}));
const normal = mapFields(n, 'QuestType:_QuestType QuestLevel:_QuestLv EnemyLevel:_EnemyLv Map:_MapNo BaseTime:_BaseTime TimeVariation:_TimeVariation TimeLimit:_TimeLimit Carts:_QuestLife QuestConditions:_OrderType TargetTypes:_TargetType TargetMonsters:_TgtEmType TargetItemIds:_TgtItemId TargetAmounts:_TgtNum ExtraMonsterCount:_InitExtraEmNum SwapExitRide:_IsSwapExitMarionette SwapFrequencies:_SwapEmRate SwapConditions:_SwapSetCondition SwapParams:_SwapSetParam SwapExitTimes:_SwapExitTime SwapStopType:_SwapStopType SwapStopParam:_SwapStopParam SwapExecType:_SwapExecType SupplyTable:_SupplyTbl Icons:_Icon Tutorial:_IsTutorial FromNpc:_IsFromNpc AutoMatchHR:_AutoMatchHR BattleBGMType:_BattleBGMType ClearBGMType:_ClearBGMType');
normal.Monsters = n._BossEmType.map((id, i) => ({Id:id, SpawnCondition:n._BossSetCondition[i], SpawnParam:n._BossSetParam[i]}));
normal.Reward = mapFields(n, 'Zenny:_RemMoney Points:_RemVillagePoint HRP:_RemRankPoint');
normal.ArenaParam = mapFields(n, 'FenceDefaultActive:_FenceDefaultActive FenceUptime:_FenceActiveSec FenceInitialDelay:_FenceDefaultWaitSec FenceCooldown:_FenceReloadSec Pillars:_IsUsePillar');
normal.Map = 10;
const enemy = {
  SmallMonsters: mapFields(e, 'SpawnType:_EmsSetNo HealthTable:_ZakoVital AttackTable:_ZakoAttack PartTable:_ZakoParts OtherTable:_ZakoOther MultiTable:_ZakoMulti'),
  Monsters: Array.from({length:7}, (_, i) => Object.fromEntries('PathId:_RouteNo PartTable:_PartsTbl SetName:_InitSetName SubType:_SubType HealthTable:_VitalTbl AttackTable:_AttackTbl OtherTable:_OtherTbl StaminaTable:_StaminaTbl Size:_Scale SizeTable:_ScaleTbl Difficulty:_Difficulty MultiTable:_BossMulti IndividualType:_IndividualType'.split(' ').map(pair => {
    const [key, field] = pair.split(':'); return [key, e[field][i]];
  })))
};
enemy.SmallMonsters.SpawnType = 0;
const quest = {
  QuestID:900101,
  QuestText:{DebugName:'Free Arena', DebugClient:'Arena Research', DebugDescription:'Empty arena expedition', FallbackLanguage:'ENG', QuestInfo:[
    {Language:'ENG', Name:'Free Arena', Client:'Arena Research', Description:'Explore the empty arena with your own equipment.\nNo time limit or hunting objective.\nUse Complete Quest in the menu to return.', Target:'Explore freely; return from the quest menu', Fail:'No expedition failure'},
    {Language:'ZHS', Name:'自由竞技场', Client:'竞技场管理员', Description:'携带自己的装备，自由探索空场。\n无时间限制、无狩猎目标。\n通过菜单中的完成任务返回。', Target:'自由探索；通过任务菜单返回', Fail:'探索任务不会失败'}
  ]}, QuestData:normal, EnemyData:enemy, RampageData:null
};
assert.equal(normal.TimeLimit, 0);
assert(normal.Monsters.every(m => m.Id === 0 && m.SpawnCondition === 0));
assert.deepEqual(normal.TargetTypes, [0,0]);
fs.mkdirSync('reframework/quests', {recursive:true});
fs.writeFileSync('reframework/quests/q900101.json', JSON.stringify(quest, null, 2)+'\n');
fs.mkdirSync('docs/evidence/2026-10-15', {recursive:true});
fs.writeFileSync('docs/evidence/2026-10-15/base-expedition-101.json', JSON.stringify(base, null, 2)+'\n');
console.log('Built q900101: village 1-star expedition, arena map 10, empty, untimed');
