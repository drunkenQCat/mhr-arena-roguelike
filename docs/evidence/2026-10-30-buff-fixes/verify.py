"""Verify recorded live evidence without changing the game."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
def read(name):
    return json.loads((root / name).read_text(encoding="utf-8"))

checks = {
    "wave1_stable": (370, 105, 5),
    "wave2_stable": (350, 120, -5),
    "run2_wave1": (360, 105, -5),
    "final_stacked": (360, 105, -5),
    "after_wave1": (340, 75, -25),
    "after_wave2": (340, 75, -25),
    "run2_unbuffed_later": (340, 75, -25),
    "final_cancelled": (340, 75, -25),
    "final_stopped": (340, 75, -25),
}
for name, expected in checks.items():
    report = read(f"stats-{name}.json")["report"]
    assert report["verdict"] == "PASS", name
    assert len(report["samples"]) == 6, name
    for row in report["samples"]:
        assert tuple(row[k] for k in ("_Attack", "_Defence", "_CriticalRate")) == expected, name

live = read("run2-unbuffed-confirm.json")
assert live["sessionStage"] == "Combat" and live["questUnique"] == 229892058
assert any(e["uid"] == 700 and not e["dead"] for e in live["enemies"])
assert read("wave1-combat.json")["state"]["pt"] == 3300
assert read("wave2-combat.json")["state"]["pt"] == 2860
assert read("final-combat.json")["state"]["pt"] == 3480
integrity = read("final-integrity.json")["report"]
assert integrity["pack"] == [28, 27, 25, 22, 21, 23, 0, -1]
assert integrity["temporaryArmor"] == 0
assert read("final-mhw_rogue_startup_state.json")["active"] is False
assert read("final-mhw_rogue_pouch_state.json")["active"] is False
assert read("final-effective-config.json")["config"] == read("config-original.json")["config"]
final = read("final-idle.json")
assert final["sessionStage"] == "Idle" and final.get("questUnique") is None
assert final["pt"] == 150 and final["invincible"] is False
assert final["ui"]["scene"] == "village"
print("PASS: stacked stats, wave expiry, cancellation, accounting, equipment restoration and final cleanup")
