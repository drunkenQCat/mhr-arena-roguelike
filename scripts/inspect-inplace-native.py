"""Read-only native-code capture using addresses exported by REFramework.

Requires capstone. No process writes, remote calls, or code injection.
Addresses are valid only for the process that produced the metadata.
"""
import argparse
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import struct
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pid', type=int, required=True)
parser.add_argument('--metadata', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
import capstone

kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel.OpenProcess.restype = w.HANDLE
kernel.ReadProcessMemory.argtypes = [w.HANDLE, w.LPCVOID, w.LPVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel.CloseHandle.argtypes = [w.HANDLE]
handle = kernel.OpenProcess(0x410, False, args.pid)  # QUERY_INFORMATION | VM_READ
if not handle:
    raise ctypes.WinError(ctypes.get_last_error())
selected = {
    'snow.QuestManager': ['updateBossEnemy', 'updateExtraEnemyCommon', 'getBossSetInfo', 'checkNextEnemyAppearCondition', 'setupQuest_CreateEnemy', 'clearBossSetAll', 'getNextEnemyAppearSpace', 'setBossLoadStartOk', 'checkBossLoadDone'],
    'snow.enemy.EnemyManager': ['getEnemySetInfo', 'createEnemySetInfo', 'createEnemyFromSetInfo', 'updateEnemySetInfoQuestHost'],
    'snow.enemy.EnemySetInfo': ['repop', 'get_RepopMax', 'resetEnemy', 'updateSetStatus', 'updateDestroyStatus'],
}
decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
metadata = json.loads(args.metadata.read_text(encoding='utf-8'))
args.out.mkdir(parents=True, exist_ok=True)
manifest = {'pid': args.pid, 'metadataAt': metadata['at'], 'readOnly': True, 'functions': []}
try:
    for typename, names in selected.items():
        for method in metadata['types'][typename]['methods']:
            if method['name'] not in names:
                continue
            address = int(method['address'].split()[-1], 16)
            buffer = ctypes.create_string_buffer(0x2000)
            count = ctypes.c_size_t()
            if not kernel.ReadProcessMemory(handle, address, buffer, len(buffer), ctypes.byref(count)):
                raise ctypes.WinError(ctypes.get_last_error())
            data = buffer.raw[:count.value]
            filename = typename + '.' + method['name']
            (args.out / (filename + '.txt')).write_text('\n'.join(
                f'{ins.address:016x} {ins.mnemonic} {ins.op_str}'
                for ins in decoder.disasm(data, address)
            ), encoding='utf-8')
            manifest['functions'].append({'name': filename, 'address': hex(address), 'captureBytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    (args.out / 'metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    (args.out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    # Resolve only RIP-relative singleton loads already identified in these functions.
    # Resolve field offsets from the current process metadata, never the older SDK dump.
    def read(address, size):
        buffer = ctypes.create_string_buffer(size)
        count = ctypes.c_size_t()
        if not kernel.ReadProcessMemory(handle, address, buffer, size, ctypes.byref(count)) or count.value != size:
            raise ctypes.WinError(ctypes.get_last_error())
        return buffer.raw

    def pointer(address):
        return struct.unpack('<Q', read(address, 8))[0]

    def integer(address):
        return struct.unpack('<i', read(address, 4))[0]

    def singleton_from_load(typename, methodname, destination):
        method = next(m for m in metadata['types'][typename]['methods'] if m['name'] == methodname)
        address = int(method['address'].split()[-1], 16)
        decoder.detail = True
        for ins in decoder.disasm(read(address, 0x300), address):
            if ins.mnemonic == 'mov' and ins.op_str.startswith(destination + ', qword ptr [rip '):
                return pointer(ins.address + ins.size + ins.operands[1].mem.disp)
        raise ValueError('Singleton load pattern not found')

    em = singleton_from_load('snow.QuestManager', 'getBossSetInfo', 'rdx')
    qm = singleton_from_load('snow.enemy.EnemyManager', 'updateEnemySetInfoQuestHost', 'rdi')
    fields = {t: {f['name']: f['offset'] for f in x['fields']} for t, x in metadata['types'].items()}
    state = {'questManager': hex(qm), 'enemyManager': hex(em), 'note': 'Sequential read-only memory sample, not an atomic snapshot', 'quest': {}, 'lists': {}}
    for name in ['_ExtraEmRno', '_BossSetCount', '_ExtraSetCount']:
        state['quest'][name] = integer(qm + fields['snow.QuestManager'][name])
    for name in ['_BossSetNoTbl', '_BossSetCond']:
        array = pointer(qm + fields['snow.QuestManager'][name])
        count = integer(array + 0x1c)
        if not 0 <= count <= 100:
            raise ValueError('Unexpected quest array size')
        state['quest'][name] = list(struct.unpack('<' + 'i' * count, read(array + 0x20, count * 4)))
    for name in ['_EnemySetInfoList', '_ZakoSetInfoList']:
        obj = pointer(em + fields['snow.enemy.EnemyManager'][name])
        state['lists'][name] = {'address': hex(obj), 'count': integer(obj + 0x18)}
    (args.out / 'runtime-state.json').write_text(json.dumps(state, indent=2), encoding='utf-8')
    print(json.dumps(state, indent=2))
finally:
    kernel.CloseHandle(handle)
print(f"Captured {len(manifest['functions'])} functions (read-only) to {args.out}")
