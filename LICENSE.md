# Licenses

This repository contains parts under different licenses.

| Part | License |
|---|---|
| `firmware/`, `platformio.ini` – derived from [CAD Mouse MK2](https://github.com/sb-ocr/cad-mouse-mk2) by salimbenbouz | [CC BY-NC-SA 4.0](LICENSE-CC-BY-NC-SA-4.0.txt) |
| `app/ladeni-web/model/*.stl` – meshes from the original CAD Mouse MK2 enclosure | [CC BY-NC-SA 4.0](LICENSE-CC-BY-NC-SA-4.0.txt) |
| `app/tray/`, `app/ladeni-web/`, `fusion-addin/`, `tools/`, `.github/` (except the items below) | [GPL-3.0-or-later](LICENSE-GPL-3.0.txt) |
| **Logo**: `app/ladeni-web/logo.png`, `app/tray/cadmouse.ico` (also embedded in `CadMouseTray.exe`) | **Not GPL** – all rights reserved, see [Logo](#logo) |
| `app/ladeni-web/vendor/` – three.js, STLLoader, BufferGeometryUtils | MIT, © 2010-2023 three.js authors |
| WebView2 SDK dlls (downloaded at build time, shipped in the release zip) | Microsoft BSD-style license, see `WebView2-LICENSE.txt` in the zip |

Firmware changes: the original firmware is © Salim Benbouziyane (salimbenbouz), licensed CC BY-NC-SA 4.0.
This fork adds USB modes (SpaceMouse/Joystick), motion teaching, flash settings, sleep and serial
commands; the modified firmware is shared under the same license (ShareAlike). Non-commercial use only.

---

## Software (GPL-3.0-or-later)

Copyright (C) 2026 LordT3ch and CAD Mouse MK2 software contributors

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
[GNU General Public License](LICENSE-GPL-3.0.txt) for more details.

Additional term under GPL-3.0 section 7(e): this license grants no rights to use the logo, the
author's name or nickname as a trade name, trademark or mark of endorsement (see below).

---

## Logo

The CAD Mouse logo (`app/ladeni-web/logo.png`, `app/tray/cadmouse.ico` and the same image embedded
in `CadMouseTray.exe`) is © 2026 LordT3ch. **All rights reserved.** It is not covered by the GPL
or by the Creative Commons license.

You **may**:
- keep the logo, unmodified, in copies and forks of this project (source or builds), or
- remove or replace it in your copy.

You **may not**:
- use the logo, or anything confusingly similar, in any other project, product, page or channel;
- modify the logo and keep presenting it as this project's logo;
- use it to present yourself as the author, or to suggest the author made, supports or endorses
  your version, product or service.

If you publish a fork that changes how the software behaves, please replace the logo with your own,
so users can tell your version from the original.
