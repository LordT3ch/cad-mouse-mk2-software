# CadMouseNav — zkušební navigace ve Fusionu přímo z CAD Mouse MK2, bez 3DxWare.
# Data bere z ikonky v liště (http://localhost:47390/stream), kameru hýbe přes Fusion API.
# Pro test přepni myš do režimu Joystick, jinak hýbe zároveň i 3DxWare.
import adsk.core, adsk.fusion, traceback, threading, time, ctypes, os, json, urllib.request

# --- ladění pocitu (znaménka otoč, kdyby se pohyb díval opačně) ---
ROT_SPEED = 1.8      # rad/s při plném naklonění / otočení
ZOOM_SPEED = 1.0     # podíl vzdálenosti za sekundu při plném zmáčknutí
SIGN_PITCH = 1       # dopředu / dozadu
SIGN_ROLL = 1        # doleva / doprava
SIGN_YAW = 1         # otáčení
LIMIT = 350.0        # plná výchylka osy z myši

EVENT_ID = 'CadMouseNavTick'
AKCE_ID = 'CadMouseNavAkce'   # funkce Fusionu na tlačítku (z ikonky řádek "akce Home")
app = None
handlers = []
konec = threading.Event()
cekam = threading.Event()   # nastaveno = událost čeká na zpracování v hlavním vlákně
osy = [0.0] * 6             # poslední Tx, Ty, Tz, Rx, Ry, Rz z myši
tlacitka = [0]              # bity bočních tlačítek (1 = levé, 2 = pravé)
# zoom ze stránky Tlačítka: které tlačítko s knoflíkem oddaluje, obrácený směr, vypnutí
zoom = {'modLeft': True, 'modRight': True, 'invert': False, 'off': False, 'speed': 1.0}
posledni = [None]


def fusion_vpredu():
    hwnd = ctypes.windll.user32.GetForegroundWindow()
    pid = ctypes.c_ulong()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value == os.getpid()


# Vlákno: čte řádky z ikonky a budí hlavní vlákno Fusionu (API se smí volat jen z něj).
def cteni():
    while not konec.is_set():
        try:
            # bez timeoutu: když myš spí, data nechodí a spojení má prostě čekat
            with urllib.request.urlopen('http://localhost:47390/stream', timeout=None) as r:
                for raw in r:
                    if konec.is_set():
                        return
                    radek = raw.decode('utf-8', 'ignore')
                    if radek.startswith('akce '):  # tlačítko s funkcí Fusionu (Home, Fit…)
                        app.fireCustomEvent(AKCE_ID, radek[5:].strip())
                        continue
                    if radek.startswith('buttons '):  # nastavení ze stránky Tlačítka (zoom)
                        try:
                            zoom.update(json.loads(radek[8:]).get('zoom', {}))
                        except ValueError:
                            pass
                        continue
                    v = radek.split()
                    if len(v) < 17 or v[0] != 's':
                        continue
                    osy[:] = [float(x) for x in v[10:16]]
                    tlacitka[0] = int(v[16])
                    if any(osy) and not cekam.is_set():
                        cekam.set()
                        app.fireCustomEvent(EVENT_ID, '')
        except Exception:
            time.sleep(1)  # ikonka neběží / myš odpojená -> zkusit znovu


def pohni(dt):
    _, _, tz, rx, ry, rz = [x / LIMIT for x in osy]
    vp = app.activeViewport
    if not vp:
        return
    cam = vp.camera
    eye, target, up = cam.eye, cam.target, cam.upVector
    pohled = eye.vectorTo(target)
    pohled.normalize()
    nahoru = up.copy()
    nahoru.normalize()
    vpravo = pohled.crossProduct(nahoru)
    vpravo.normalize()

    # Orbit kolem cíle: dopředu/dozadu = kolem osy vpravo, otáčení = kolem osy nahoru, doleva/doprava = náklon pohledu.
    celkem = adsk.core.Matrix3D.create()
    for uhel, osa in ((SIGN_PITCH * rx, vpravo), (SIGN_YAW * rz, nahoru), (SIGN_ROLL * ry, pohled)):
        if uhel:
            m = adsk.core.Matrix3D.create()
            m.setToRotation(uhel * ROT_SPEED * zoom.get('speed', 1.0) * dt, osa, target)
            celkem.transformBy(m)
    eye.transformBy(celkem)
    up.transformBy(celkem)

    # Zmáčknutí = přiblížit, zmáčknutí s podrženým bočním tlačítkem = oddálit
    # (povytažení nahoru dává moc slabý signál). Znaménko Tz záleží na magnetech -> abs.
    k = 0 if zoom.get('off') else min(0.5, abs(tz) * ZOOM_SPEED * zoom.get('speed', 1.0) * dt)
    if k:
        b = tlacitka[0]
        oddalit = bool((b & 1 and zoom.get('modLeft', True)) or (b & 2 and zoom.get('modRight', True)))
        if zoom.get('invert'):
            oddalit = not oddalit
        f = 1 + k if oddalit else 1 - k
        if cam.cameraType == adsk.core.CameraTypes.OrthographicCameraType:
            cam.viewExtents = cam.viewExtents * f
        else:
            k_oku = target.vectorTo(eye)
            k_oku.scaleBy(f)
            eye = target.copy()
            eye.translateBy(k_oku)

    cam.eye = eye
    cam.target = target
    cam.upVector = up
    cam.isSmoothTransition = False
    vp.camera = cam
    vp.refresh()  # bez toho Fusion překreslí až po kliknutí do okna


class Tik(adsk.core.CustomEventHandler):
    def notify(self, args):
        try:
            ted = time.perf_counter()
            dt = min(0.05, ted - posledni[0]) if posledni[0] else 1 / 60
            posledni[0] = ted
            if fusion_vpredu():
                pohni(dt)
        except Exception:
            pass
        finally:
            cekam.clear()


# Funkce Fusionu, které nemají klávesovou zkratku — tlačítko je spustí přes API.
# Názvy přicházejí z ikonky jako "akce <název>" (na stránce Tlačítka jako "Fusion:<název>").
POHLEDY = {'Top': 'TopViewOrientation', 'Front': 'FrontViewOrientation', 'Right': 'RightViewOrientation',
           'Left': 'LeftViewOrientation', 'Back': 'BackViewOrientation', 'Bottom': 'BottomViewOrientation',
           'Iso': 'IsoTopRightViewOrientation'}
predchozi_styl = [None]


def vypis_prikazy():
    # Seznam všech příkazů Fusionu (ID a název) — podle něj se dají přidat další akce na tlačítka.
    defs = app.userInterface.commandDefinitions
    cesta = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prikazy-fusion.txt')
    with open(cesta, 'w', encoding='utf-8') as f:
        for i in range(defs.count):
            d = defs.item(i)
            f.write('%s\t%s\n' % (d.id, d.name))


def proved(nazev):
    if nazev == 'list':
        vypis_prikazy()
        return
    vp = app.activeViewport
    if not vp or not fusion_vpredu():
        return
    if nazev == 'Home':
        vp.goHome(True)          # domovský pohled (jako domeček u ViewCube)
    elif nazev == 'Fit':
        vp.fit()                 # celý model do okna
    elif nazev.startswith('View:'):
        cam = vp.camera          # getter vrací kopii -> upravit a vrátit
        cam.viewOrientation = getattr(adsk.core.ViewOrientations, POHLEDY[nazev[5:]])
        cam.isSmoothTransition = True
        vp.camera = cam
    elif nazev == 'Ortho':
        cam = vp.camera
        T = adsk.core.CameraTypes
        cam.cameraType = T.PerspectiveCameraType if cam.cameraType == T.OrthographicCameraType else T.OrthographicCameraType
        vp.camera = cam
    elif nazev == 'Wireframe':
        S = adsk.core.VisualStyles
        if vp.visualStyle == S.WireframeVisualStyle:
            vp.visualStyle = predchozi_styl[0] or S.ShadedWithVisibleEdgesOnlyVisualStyle
        else:
            predchozi_styl[0] = vp.visualStyle
            vp.visualStyle = S.WireframeVisualStyle
    elif nazev == 'FullScreen':
        vp.isFullScreen = not vp.isFullScreen
    elif nazev.startswith('cmd:'):
        d = app.userInterface.commandDefinitions.itemById(nazev[4:])
        if d:
            d.execute()
        else:
            app.userInterface.messageBox('Příkaz „%s“ ve Fusionu není.' % nazev[4:], 'CAD Mouse')


class Akce(adsk.core.CustomEventHandler):
    def notify(self, args):
        try:
            proved(args.additionalInfo)
        except Exception:
            pass


def run(context):
    global app
    try:
        app = adsk.core.Application.get()
        ev = app.registerCustomEvent(EVENT_ID)
        h = Tik()
        ev.add(h)
        handlers.append(h)
        ev2 = app.registerCustomEvent(AKCE_ID)
        h2 = Akce()
        ev2.add(h2)
        handlers.append(h2)
        konec.clear()
        threading.Thread(target=cteni, daemon=True).start()
    except Exception:
        app.userInterface.messageBox('CadMouseNav nejde spustit:\n' + traceback.format_exc())


def stop(context):
    konec.set()
    for ident in (EVENT_ID, AKCE_ID):
        try:
            app.unregisterCustomEvent(ident)
        except Exception:
            pass
