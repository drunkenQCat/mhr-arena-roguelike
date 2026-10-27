"""Collect offline API evidence; never attaches to or modifies the game.

The output distinguishes TDB method metadata from RSZ serialization schemas.
Usage: python scripts/collect-design-api-evidence.py [--game-data PATH]
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--game-data', type=Path, default=Path(
    'C:/Program Files (x86)/Steam/steamapps/common/MonsterHunterRise/reframework/data'))
args = parser.parse_args()
out = ROOT / 'docs/evidence/2026-10-27-design-api'
out.mkdir(parents=True, exist_ok=True)
types = {
    'snow.QuestManager', 'snow.enemy.EnemyManager', 'snow.enemy.EnemyCharacterBase',
    'snow.enemy.EnemySetInfo', 'snow.quest.EnemySetParam', 'snow.quest.BossSetParam',
    'snow.data.ItemPouch', 'snow.data.ItemInventoryData', 'snow.data.ItemBox',
    'snow.data.DataManager', 'snow.data.EquipDataManager', 'snow.data.EquipBox',
    'snow.data.WeaponData', 'snow.player.PlayerBase', 'snow.player.PlayerManager',
    'snow.gui.GuiManager', 'snow.gui.GuiItemBoxWindow',
    'snow.enemy.SystemDifficultyRateData', 'snow.enemy.EnemyBossRandomScaleData',
    'snow.quest.NormalQuestDataForEnemy.Param', 'snow.quest.ArenaQuestData',
}
inputs = [
    ('sdk-subset', ROOT / 'sdk-dump/sdk_types.json'),
    ('native-flow', ROOT / 'docs/evidence/2026-10-27-native-flow/metadata.json'),
    ('native-equipment', args.game_data / 'rogue_inplace_native_metadata.json'),
    ('native-gui', args.game_data / 'rogue_native_gui_metadata.json'),
]
manifest = {'scope': 'offline extraction; no new runtime verification', 'inputs': []}
for label, path in inputs:
    if not path.exists():
        manifest['inputs'].append({'label': label, 'missing': True})
        continue
    raw = path.read_bytes()
    data = json.loads(raw.decode('utf-8-sig'))
    # GUI dump values are inheritance chains, other dumps store one type per key.
    selected = {n: v for n, v in data['types'].items() if n in types or label == 'native-gui'}
    result = {'source': label, 'capturedAt': data.get('at', data.get('generated')),
              'caution': 'Metadata proves existence, not successful execution. Addresses are historical.',
              'types': selected}
    (out / (label + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    manifest['inputs'].append({'label': label, 'source': str(path),
        'sha256': hashlib.sha256(raw).hexdigest(), 'selectedTypes': len(selected)})

rsz = ROOT / '.local/save-editor/assets/mhrise/rszmhrise.json'
if rsz.exists():
    raw = rsz.read_bytes()
    schemas = json.loads(raw.decode('utf-8-sig'))
    wanted = {
        'snow.quest.QuestEnemyNando', 'snow.quest.NormalQuestDataForEnemy.Param',
        'snow.quest.EnemySetParam', 'snow.quest.BossSetParam',
        'snow.equip.PlEquipMySetData', 'snow.equip.PlEquipMySetData.BackupData',
        'snow.data.PlItemPouchMySetData', 'snow.data.ItemUserData.Param',
        'snow.data.ItemShopDisplayUserData.Param', 'snow.QuestManager.SyncDiscoverNextBoss',
        'snow.QuestManager.NotifyQuestBossLoad', 'snow.QuestManager.SyncNormalsQuest',
        'snow.enemy.EnemyManager.EnemySetupParam', 'snow.enemy.EnemyBossRandomScaleData',
    }
    selected = {v['name']: v for v in schemas.values() if v['name'] in wanted}
    (out / 'rsz-candidates.json').write_text(json.dumps({
        'caution': 'Serialization schema only; NOT a complete TDB or live memory layout. No field offsets.',
        'types': selected}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    manifest['inputs'].append({'label': 'rsz', 'source': str(rsz),
        'sha256': hashlib.sha256(raw).hexdigest(), 'selectedTypes': len(selected)})
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Collected {len(manifest["inputs"])} sources into {out}')
