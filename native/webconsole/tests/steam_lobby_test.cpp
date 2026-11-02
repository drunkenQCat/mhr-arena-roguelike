#include "common.h"
#include "steam_lobby.h"
#include <stdexcept>
#include <iostream>
void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
int main(int argc, char** argv) try {
    check(!webconsole::steam_snapshot().available, "Steam must fail closed before the module loads");
    check(argc == 2, "missing fake DLL path");
    auto module = LoadLibraryA(argv[1]); check(module != nullptr, "fake DLL did not load");
    check(webconsole::steam_snapshot().available, "C API did not bind");
    check(webconsole::steam_snapshot().lobbies.empty(), "invented an unobserved lobby");
    auto enter = reinterpret_cast<void(*)()>(GetProcAddress(module, "fake_enter"));
    auto owner = reinterpret_cast<void(*)(std::uint64_t)>(GetProcAddress(module, "fake_owner"));
    auto present = reinterpret_cast<void(*)(bool)>(GetProcAddress(module, "fake_present"));
    enter(); enter();
    auto snapshot = webconsole::steam_snapshot();
    check(snapshot.lobbies.size() == 1 && snapshot.lobbies[0].members.size() == 2, "callback ABI or lobby dedup failed");
    check(snapshot.lobbies[0].self == "100", "SteamID was not preserved as a decimal string");
    check(!webconsole::steam_write_plan("1001", "x"), "wrote to an unobserved lobby");
    check(!webconsole::steam_write_plan("1000junk", "x"), "accepted an invalid ID");
    check(!webconsole::steam_write_plan("1000", std::string(2049, 'x')), "accepted an oversized payload");
    check(webconsole::steam_write_plan("1000", "plan"), "owner publish failed");
    check(webconsole::steam_write_ack("1000", "ack"), "member ACK failed");
    snapshot = webconsole::steam_snapshot();
    check(snapshot.lobbies[0].plan == "plan" && snapshot.lobbies[0].members[0].ack == "ack", "metadata readback differs");
    owner(200);
    check(!webconsole::steam_write_plan("1000", "overwrite"), "non-owner changed the plan");
    check(webconsole::steam_write_ack("1000", "guest-ack"), "non-owner could not acknowledge");
    present(false); check(webconsole::steam_snapshot().lobbies.empty(), "departed lobby remained usable");
    check(!webconsole::steam_write_ack("1000", "stale"), "stale lobby accepted a write");
    check(webconsole::steam_digest("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA256 mismatch");
    std::cout << "PASS Steam C ABI, callback, membership, authority, bounds, metadata and SHA256\n";
    // Keep the fake module loaded for the process lifetime, just like the game.
    return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
