# Bundled Everything

- Publisher: voidtools PTY LTD / David Carpenter
- Version: 1.4.1.1032, Windows x64, full multilingual portable edition
- Source: https://www.voidtools.com/Everything-1.4.1.1032.x64.zip
- Official checksum list: https://www.voidtools.com/Everything-1.4.1.1032.sha256
- Archive SHA256: `698df475ec44e638f66f1b6a32d28fea613cec78d3b6310e6abe53431eeb940c`
- Authenticode verification on 2026-10-18: Valid; voidtools PTY LTD
- License: `License.txt`, retrieved from https://www.voidtools.com/License.txt

The original archive contains `everything.exe` and `Everything.lng`. Preserve both and the complete license, including PCRE notices, in distributions. This resource targets x64 Windows; other distribution targets must supply the matching official build and checksum.

The workbench starts it only through an explicit action or enabled autostart preference. Existing local installations/instances may be used instead. NTFS indexing service installation is configured separately by the user in Everything; packaging this executable does not install a service.
