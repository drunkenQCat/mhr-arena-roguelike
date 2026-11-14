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
    auto fail_key = reinterpret_cast<void(*)(const char*)>(GetProcAddress(module, "fake_fail_key"));
    auto data = reinterpret_cast<void(*)(const char*,const char*)>(GetProcAddress(module, "fake_data"));
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
    check(webconsole::steam_subscribe("effects.v1") && webconsole::steam_subscribe("effects.v1"),"message subscription/idempotence failed");
    check(webconsole::steam_subscribe("designer.v1"),"second message subscription failed");
    for(const auto& invalid:{"",".hidden","../escape","UPPER","contains space","abcdefghijklmnopqrstuvwxyz"})
        check(!webconsole::steam_subscribe(invalid),"invalid message channel accepted");
    check(!webconsole::steam_write_lobby_message("1000","not-subscribed","x"),"unsubscribed message namespace written");
    check(!webconsole::steam_write_member_message("1001","effects.v1","x"),"unobserved lobby accepted a message");
    check(!webconsole::steam_write_member_message("1000","effects.v1",std::string(2049,'x')) &&
          !webconsole::steam_write_lobby_message("1000","effects.v1",std::string("a\0b",3)),"message byte/null bound missing");
    check(webconsole::steam_write_lobby_message("1000","effects.v1","host-permit") &&
          webconsole::steam_write_member_message("1000","effects.v1","buyer-intent"),"message publish failed");
    check(webconsole::steam_write_lobby_message("1000","designer.v1","independent"),"second message namespace failed");
    snapshot=webconsole::steam_snapshot();
    check(snapshot.lobbies[0].messages["effects.v1"]=="host-permit" &&
          snapshot.lobbies[0].messages["designer.v1"]=="independent" &&
          snapshot.lobbies[0].members[0].messages["effects.v1"]=="buyer-intent" &&
          snapshot.lobbies[0].members[1].messages["effects.v1"].empty(),"message namespace/sender identity lost");
    check(snapshot.lobbies[0].plan=="plan" && snapshot.lobbies[0].members[0].ack=="ack","messages overwrote native gameplay channel");
    for(int i=0;i<6;++i)check(webconsole::steam_subscribe("bounded"+std::to_string(i)),"valid bounded subscription rejected");
    check(!webconsole::steam_subscribe("too-many") && webconsole::steam_subscribe("effects.v1"),"message channel set is unbounded");
    data("mhr_arena_bus_v1_effects.v1",std::string(2049,'x').c_str());
    check(webconsole::steam_snapshot().lobbies[0].messages["effects.v1"].empty(),"oversized native message exposed");
    check(webconsole::steam_write_lobby_message("1000","effects.v1","host-permit"),"message restore failed");
    std::string payload;
    for(int i=0;i<9000;++i) payload += "\xe4\xb8\xad"; // Multibyte data across many ASCII chunks.
    check(webconsole::steam_write_config_payload("1000",payload),"config payload publish failed");
    check(webconsole::steam_write_config_control("1000","proposal"),"config control publish failed");
    check(webconsole::steam_write_config_ack("1000","config-ready"),"config ACK publish failed");
    snapshot=webconsole::steam_snapshot();
    check(snapshot.lobbies[0].config.complete && snapshot.lobbies[0].config.payload==payload &&
          snapshot.lobbies[0].config.digest==webconsole::steam_digest(payload),"config chunks/digest changed UTF8 payload");
    check(snapshot.lobbies[0].config.control=="proposal" && snapshot.lobbies[0].members[0].config_ack=="config-ready", "independent config control/ACK not read back");
    check(snapshot.lobbies[0].plan=="plan" && snapshot.lobbies[0].members[0].ack=="ack","config overwrote the gameplay channel");
    check(!webconsole::steam_write_config_payload("1000",std::string(65537,'x')) &&
          !webconsole::steam_write_config_payload("1000","") &&
          !webconsole::steam_write_config_payload("1000",std::string("a\0b",3)),"config size/null bounds missing");
    data("mhr_arena_config_v1_part_1","");
    check(!webconsole::steam_snapshot().lobbies[0].config.complete,"missing chunk exposed a partial config");
    check(webconsole::steam_write_config_payload("1000",payload),"config retry failed");
    data("mhr_arena_config_v1_part_0",std::string(1800,'A').c_str());
    check(!webconsole::steam_snapshot().lobbies[0].config.complete,"corrupt chunk bypassed the full digest");
    check(webconsole::steam_write_config_payload("1000",payload),"config restore failed");
    fail_key("mhr_arena_config_v1_part_1");
    check(!webconsole::steam_write_config_payload("1000",std::string(6000,'z')),"partial native write reported success");
    check(!webconsole::steam_snapshot().lobbies[0].config.complete,"mixed old/new chunks exposed a config");
    fail_key("");
    check(webconsole::steam_write_config_payload("1000",std::string(65536,'z')),"maximum config rejected");
    check(webconsole::steam_snapshot().lobbies[0].config.payload==std::string(65536,'z'),"maximum config readback differs");
    data(webconsole::STEAM_CONFIG_MANIFEST_KEY,"C1|1000000|65536|bad");
    check(!webconsole::steam_snapshot().lobbies[0].config.complete,"invalid manifest accepted");
    owner(200);
    check(!webconsole::steam_write_lobby_message("1000","effects.v1","guest-overwrite"),"guest overwrote authoritative message");
    check(webconsole::steam_write_member_message("1000","effects.v1","own-intent"),"guest cannot write its own message");
    check(!webconsole::steam_write_plan("1000", "overwrite"), "non-owner changed the plan");
    check(!webconsole::steam_write_config_payload("1000","guest overwrite") &&
          !webconsole::steam_write_config_control("1000","guest control"),"non-owner changed config");
    check(webconsole::steam_write_config_ack("1000","guest-config-ack"),"member config ACK rejected");
    check(webconsole::steam_write_ack("1000", "guest-ack"), "non-owner could not acknowledge");
    present(false); check(webconsole::steam_snapshot().lobbies.empty(), "departed lobby remained usable");
    check(!webconsole::steam_write_lobby_message("1000","effects.v1","stale") &&
          !webconsole::steam_write_member_message("1000","effects.v1","stale"),"departed lobby accepted messages");
    check(!webconsole::steam_write_ack("1000", "stale"), "stale lobby accepted a write");
    check(!webconsole::steam_write_config_payload("1000","stale") && !webconsole::steam_write_config_ack("1000","stale"),"departed lobby accepted config writes");
    check(webconsole::steam_digest("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA256 mismatch");
    std::cout << "PASS Steam C ABI, callback, membership, authority, bounds, metadata and SHA256\n";
    // Keep the fake module loaded for the process lifetime, just like the game.
    return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
