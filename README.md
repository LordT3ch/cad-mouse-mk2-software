# CAD Mouse MK2 – firmware a aplikace pro Windows

🇨🇿 Česky · 🇬🇧 [English](README.en.md)

Rozšířený firmware a aplikace pro Windows k DIY 6DoF 3D myši
**[CAD Mouse MK2](https://github.com/sb-ocr/cad-mouse-mk2)** od *salimbenbouz* (Salim Benbouziyane).
Hardware, plošné spoje, krabička a návod na stavbu jsou v původním projektu
([Instructables](https://www.instructables.com/CAD-Mouse-MK2-a-6DoF-Space-Mouse-Using-Magnets)).
Tohle repo řeší jen software.

![Okno aplikace: živý 3D model myši, učení pohybů, grafy senzorů, osy a nastavení LED](docs/app-window.png)

<img src="docs/tray-menu.png" width="320" alt="Menu u hodin: režim SpaceMouse / Joystick, barva LED, jas, citlivost">

## Co to umí

**Firmware (XIAO RP2040)**
- Dva režimy USB, přepínají se z ikonky u hodin nebo podržením obou bočních tlačítek (uloží se do flash):
  - **SpaceMouse** – hlásí se jako 3Dconnexion SpaceMouse Pro. Funguje v Blenderu, slicerech (Bambu Studio…)
    a s 3DxWare i v SolidWorks, Inventoru, Onshape, FreeCADu…
  - **Joystick** – obyčejný 6osý herní ovladač s 32 tlačítky (hry, letecké simulátory).
- **Učení pohybů** – každým směrem knoflíkem párkrát zatlačíš, nakloníš nebo otočíš a myš se naučí tvé pohyby
  (umístění magnetů, tuhost pružiny). Žádné ruční ladění zesílení.
- **Výhradní osy** – osa může být „výhradní“, takže ji ostatní osy nerozhodí (třeba čisté otáčení v CADu).
- Mrtvé zóny a citlivost pro každý směr, barva a jas LED, oblíbené barvy.
- **Spánek** po 3 minutách nečinnosti (LED zhasne, knoflík nereaguje). Probudíš ji bočním tlačítkem.
- Nastavení je ve flash myši. Mapování os a „zmáčknutí = zoom“ posílá ikonka za běhu přes sériový port.

**Ikonka u hodin (`CadMouseTray.exe`)**
- Ukazuje režim a barvu LED. Po kliknutí se otevře rychlé menu ve stylu Windows 11
  (režim, barva, jas, citlivost).
- **Okno aplikace** (WebView2, prohlížeč není potřeba): živý 3D model myši, učení pohybů,
  kalibrace klidu, mrtvé zóny, nastavení tlačítek.
- **Boční tlačítka → klávesové zkratky podle programu** v popředí. Přednastavení pro Fusion, Blender
  a Bambu Studio, přidat jde jakýkoli běžící program.
- **Mapování os podle programu** (např. v Blenderu náklon = posun), zmáčknutí knoflíku jako zoom.
- Most mezi COM portem a lokálním WebSocket/HTTP serverem na `localhost:47390`. Ten používá okno aplikace
  a doplněk pro Fusion.

**Doplněk pro Fusion (`CadMouseNav`)**
- Otáčení, posun a zoom v Autodesk Fusion **bez 3DxWare**, data bere z ikonky.
- Boční tlačítka umí spustit akce Fusionu, které nemají zkratku (Home, Fit, standardní pohledy,
  ortografický pohled, drátový model…).

## Instalace

Stáhni `CadMouseMK2-vX.Y.zip` z **[Releases](../../releases)** a rozbal ho do složky, kam se dá zapisovat
(např. `Dokumenty\CadMouseMK2`, ne do Program Files).

1. **Firmware** – podrž tlačítko **BOOT** na XIAO RP2040, připoj USB a zkopíruj `firmware\firmware.uf2`
   na disk **RPI-RP2**. Myš se sama restartuje.
2. **Ikonka** – spusť `tray\CadMouseTray.exe`, pravým na ikonku → *Spouštět s Windows*.
   SmartScreen může varovat (exe není podepsané): *Další informace → Přesto spustit*.
3. **Fusion** (volitelné) – `Shift+S` → *Add-Ins* → **+** → vyber složku `fusion-addin\CadMouseNav`,
   zaškrtni *Run on Startup* a dej *Run*.
4. **Kalibrace** – klikni na ikonku → *Ladění a kalibrace* → **Naučit všechny pohyby** a postupuj podle pokynů.

### Požadavky
- Windows 10 nebo 11, x64.
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) – ve Windows 11 už je,
  ve většině Windows 10 taky.
- .NET Framework 4.6.2+ (součást Windows 10/11).

### 3DxWare a další CAD programy
- **Fusion** stačí doplněk, 3DxWare není potřeba.
- **Blender** a slicery čtou SpaceMouse napřímo, 3DxWare není potřeba.
- **SolidWorks, Inventor, Onshape, FreeCAD** a další potřebují oficiální ovladač **3DxWare**
  od 3Dconnexion – nainstaluj si ho sám. V režimu SpaceMouse ho myš oklame jako SpaceMouse Pro.
- Když máš 3DxWare nainstalované, **ve Fusionu používej jen jedno z nich**: buď v 3DxWare vypni Fusion,
  nebo zastav doplněk `CadMouseNav`. Jinak se pohled hýbe dvakrát.

### Varianty firmwaru
| Soubor | USB ID v režimu SpaceMouse | Funguje s |
|---|---|---|
| `firmware.uf2` | `256F:C631` (3Dconnexion SpaceMouse Pro) | Všechny programy výše, vyžaduje 3Dconnexion, nepotřebuje Fusion doplněk |
| `firmware-generic-vid.uf2` | `2E8A:0CAE` | Fusion 360 + doplněk, Blender, režim Joystick, aplikace – bez 3Dconnexion - zkratky tlačítek, nebo správné chování v jiných programech není otestováno a bylo by potřeba jej ručně vytvořit |

Blender, slicery a 3DxWare poznají 3D myš jen podle USB ID výrobce 3Dconnexion, proto ho výchozí firmware
používá. To ID patří firmě 3Dconnexion a tenhle projekt s ní nijak nesouvisí. Když to nechceš,
použij generic variantu. Režim Joystick má vždy `2E8A:0CAD`.

> Aplikace je zatím jen česky. Překlady jsou vítané.

## Sestavení ze zdrojáků

**Firmware** – [PlatformIO](https://platformio.org/):
```
pio run -e seeed_xiao_rp2040      # nebo -e generic_vid
```
Výstup: `.pio/build/<env>/firmware.uf2`. `tools\flash-firmware.ps1` sestaví a nahraje naráz.

**Ikonka** – bez Visual Studia, stačí C# kompilátor, který je ve Windows:
```
powershell -ExecutionPolicy Bypass -File tools\build-tray.ps1
```
Stáhne knihovny WebView2 SDK z NuGetu (pevná verze, kontrola SHA256) a vytvoří `app\tray\CadMouseTray.exe`.
Exe hledá stránku aplikace ve složce `..\ladeni-web` vedle své složky.

**CI** – `.github/workflows/build.yml` sestaví obojí a zabalí zip. Tag `v*` ho vydá jako Release.

## Struktura repa
```
platformio.ini            projekt PlatformIO (envs: seeed_xiao_rp2040, generic_vid)
firmware/                 zdrojáky firmwaru (fork sb-ocr/cad-mouse-mk2)
app/tray/                 CadMouseTray.cs + ikona
app/ladeni-web/           okno aplikace (HTML/JS, three.js, STL modely)
fusion-addin/CadMouseNav/ doplněk pro Fusion (Python)
tools/                    skripty pro sestavení a nahrání
```

## Bezpečnost
Ikonka spouští malý HTTP/WebSocket server jen na `localhost:47390`. Spojení s hlavičkou `Origin` jinou než
vlastní aplikace odmítne (403), takže cizí webové stránky nemůžou posílat příkazy ani stisky kláves.
Okno aplikace nepustí navigaci mimo svou lokální stránku.

## Optimalizace
Hlavní program pro kalibraci a nastavení barev při běhu využívá ~300MB RAM - nemusí běžet pořád.
Ikonka v systémové liště která už běžet musí stále ~10MB RAM.

## Licence
- **Firmware** (`firmware/`, `platformio.ini`) a **STL modely** v `app/ladeni-web/model/` vychází z CAD Mouse MK2
  od salimbenbouz a zůstávají pod **[CC BY-NC-SA 4.0](LICENSE-CC-BY-NC-SA-4.0.txt)** – jen nekomerčně,
  se stejnou licencí a s uvedením autora.
- **Ikonka, okno aplikace, doplněk pro Fusion a skripty** – **[GPL-3.0-or-later](LICENSE-GPL-3.0.txt)**:
  můžeš je používat, upravovat a sdílet, ale upravené verze, které šíříš, musí zůstat otevřené pod GPL.
- **Logo** (`logo.png`, `cadmouse.ico`) – **všechna práva vyhrazena**, není pod GPL. Ve své kopii ho můžeš nechat
  beze změny nebo odstranit, ale nesmíš ho používat na jiné věci ani se vydávat za autora.
  Podrobně v [LICENSE.md](LICENSE.md#logo).
- Cizí části: three.js (MIT), WebView2 SDK (Microsoft, licence BSD-styl, redistribuce povolená – v zipu
  jako `WebView2-LICENSE.txt`).
