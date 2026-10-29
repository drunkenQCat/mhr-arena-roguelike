# REFramework plugin API header

This directory vendors a fixed version of the REFramework plugin SDK header, taken from our minimal fork that exposes the ScriptRunner script-control surface to plugins.

| Field | Value |
| --- | --- |
| Upstream | https://github.com/praydog/REFramework |
| Upstream base commit | `5bae4701396248a776c1de19f5be9552022295d5` (the installed MHRise REFramework build) |
| Fork | https://github.com/drunkenQCat/REFramework (`plugin-script-reset` branch) |
| Fork commit | `2e7ce5b` |
| Original path | `include/reframework/API.h` |
| License | MIT, Copyright (c) 2019 praydog; full text in [LICENSE](LICENSE) |
| Modifications vs upstream base | Three function pointers appended to the END of `REFrameworkPluginFunctions` (existing member offsets unchanged): `request_script_reset()`, `run_script(const char*)`, `last_script_error(char*, unsigned)`. Implemented in the fork's `ScriptRunner`/`PluginLoader`. |
| SHA-256 | `c8e4d49c75d08f3d3d8e1536b27aa9c0afea1cc2527271656891c97a0e0544f0` |

The hash is calculated after normalizing CRLF to LF. Every addition is append-only so plugins built against the unmodified 1.10.0 header keep their ABI; the plugin null-checks the new members before calling them.

When redistributing this header or releasing the plugin, include the upstream copyright and full MIT license text in the source or release's third-party notices. This license applies to the upstream dependency; it does not select a license for this repository's own code.

To update: choose an explicit fork commit, obtain its header, review changes and test plugin loading, then update this record and checksum. Do not edit the version macros merely to bypass a loader compatibility check.
