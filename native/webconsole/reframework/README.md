# REFramework plugin API header

This directory vendors a fixed version of the upstream REFramework plugin SDK header.

| Field | Value |
| --- | --- |
| Upstream | https://github.com/praydog/REFramework |
| Commit | `5bae4701396248a776c1de19f5be9552022295d5` |
| Original path | `include/reframework/API.h` |
| Source | [API.h at the pinned commit](https://github.com/praydog/REFramework/blob/5bae4701396248a776c1de19f5be9552022295d5/include/reframework/API.h) |
| License | MIT, Copyright (c) 2019 praydog; full text in [LICENSE](LICENSE) |
| Modifications | No content changes; line endings may differ |
| SHA-256 | `7ecbd696cb89cb9b87db7afe7cfdaa564fed8062a25e02eb2db2600ff81173bc` |

The hash is calculated after normalizing CRLF to LF. The local header was compared with the pinned upstream file on 2026-10-28.

The header declares plugin API version 1.10.0. This revision was selected for the installed Monster Hunter Rise REFramework build; do not replace it with the latest upstream header without checking loader and ABI compatibility.

When redistributing this header or releasing the plugin, include the upstream copyright and full MIT license text in the source or release's third-party notices. This license applies to the upstream dependency; it does not select a license for this repository's own code.

To update: choose an explicit upstream commit, obtain its header and license, review changes and test plugin loading, then update this record and checksum. Do not edit the version macros merely to bypass a loader compatibility check.
