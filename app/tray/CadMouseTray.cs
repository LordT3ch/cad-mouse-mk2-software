// Ikona u hodin pro CAD Mouse MK2: režim (SpaceMouse/Joystick), barva LED, jas, citlivost,
// a most COM <-> WebSocket pro ladicí stránku (../ladeni-web) na http://localhost:47390/.
// Překlad: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /optimize /codepage:65001 /r:System.Web.Extensions.dll /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll /win32icon:cadmouse.ico /out:CadMouseTray.exe CadMouseTray.cs
// Vedle exe musí ležet Microsoft.Web.WebView2.Core.dll, .WinForms.dll a WebView2Loader.dll (NuGet Microsoft.Web.WebView2).
// CadMouseTray.exe /ladeni = otevře okno ladění (i když ikonka už běží).
// Self-check: CadMouseTray.exe /test -> vypíše nalezený COM port myši (exit 0 = nalezen, 1 = ne).
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.IO.Ports;
using System.Net;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Linq;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Mys
{
    // Obě USB identity myši (SpaceMouse / Joystick), sériák je vždy rozhraní MI_00.
    static readonly string[] Klice = { @"VID_256F&PID_C631&MI_00", @"VID_2E8A&PID_0CAD&MI_00", @"VID_2E8A&PID_0CAE&MI_00" };

    // Všechny porty, které kdy myš měla a které Windows teď hlásí. Po přepnutí režimu tu chvíli
    // visí i starý port předchozí identity, proto se zkouší všechny, ne jen první.
    public static List<string> Porty()
    {
        var zive = new HashSet<string>(SerialPort.GetPortNames(), StringComparer.OrdinalIgnoreCase);
        var vysledek = new List<string>();
        foreach (var k in Klice)
            using (var usb = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\USB\" + k))
            {
                if (usb == null) continue;
                foreach (var inst in usb.GetSubKeyNames())
                    using (var p = usb.OpenSubKey(inst + @"\Device Parameters"))
                    {
                        var port = p == null ? null : p.GetValue("PortName") as string;
                        if (port != null && zive.Contains(port) && !vysledek.Contains(port)) vysledek.Add(port);
                    }
            }
        return vysledek;
    }

    public static string NajdiPort() { var l = Porty(); return l.Count > 0 ? l[0] : null; }

    public static SerialPort Port;
    static readonly object zamek = new object();
    public static event Action<string> Radek;   // každý řádek z myši (vlákno čtení)
    public static event Action<bool> Spojeni;

    public static bool Pripojeno { get { return Port != null; } }

    public static void Posli(string prikaz)
    {
        lock (zamek)
        {
            try { if (Port != null) Port.Write(prikaz.Trim() + "\n"); }
            catch (Exception) { Zavri(Port); } // čtecí vlákno pak skončí a připojí se znovu
        }
    }

    // Zavře a uvolní port úplně — jinak Windows drží starý COM po odpojení USB dál.
    static void Zavri(SerialPort p)
    {
        lock (zamek) { if (Port == p) Port = null; }
        if (p == null) return;
        try { p.Close(); } catch (Exception) { }
        try { p.Dispose(); } catch (Exception) { }
    }

    static SerialPort Otevri()
    {
        foreach (var jmeno in Porty())
        {
            var p = new SerialPort(jmeno, 115200) { DtrEnable = true, NewLine = "\n", ReadTimeout = Timeout.Infinite, Encoding = Encoding.ASCII };
            try { p.Open(); return p; }
            catch (Exception) { p.Dispose(); }
        }
        return null;
    }

    // Vlákno: připojuje se, čte řádky, po odpojení (i po přepnutí režimu) se samo připojí znovu.
    public static void Smycka()
    {
        while (true)
        {
            var p = Otevri();
            if (p == null) { Thread.Sleep(700); continue; }
            lock (zamek) Port = p;
            if (Spojeni != null) Spojeni(true);
            Posli("get");
            if (Server.MaKlienty) Posli("stream 1"); // po restartu myši (přepnutí režimu) proud znovu zapnout
            try
            {
                while (true)
                {
                    var r = p.ReadLine().TrimEnd('\r');
                    if (Radek != null) Radek(r);
                }
            }
            catch (Exception) { }
            Zavri(p);
            GC.Collect(); // dorazí zbytky starého portu (SerialPort na odpojeném USB)
            if (Spojeni != null) Spojeni(false);
            Thread.Sleep(300);
        }
    }
}

// Boční tlačítka -> klávesové zkratky podle programu v popředí (nastavení z podstránky Tlačítka).
// Soubor tlacitka.json vedle exe: { "default": {left, right}, "apps": { "<exe>": {name, left, right} } },
// akce = { "label": "Zpět", "keys": "Ctrl+Z" } (prázdné keys = nic).
static class Tlacitka
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    static readonly string soubor = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "tlacitka.json");
    const string Vychozi = "{\"default\":{\"left\":{\"label\":\"Nic\",\"keys\":\"\"},\"right\":{\"label\":\"Nic\",\"keys\":\"\"}},\"apps\":{}}";
    static readonly JavaScriptSerializer js = new JavaScriptSerializer();
    public static string Json = Vychozi;
    public static Func<int> Rezim = () => 0;
    static int predtim;

    public static void Nacti()
    {
        try { if (File.Exists(soubor)) { var t = File.ReadAllText(soubor); js.DeserializeObject(t); Json = t; } }
        catch (Exception) { } // poškozený soubor -> výchozí (nic)
    }

    public static void Uloz(string json)
    {
        js.DeserializeObject(json); // neplatné JSON vyhodí výjimku a nic se neuloží
        File.WriteAllText(soubor, json, new UTF8Encoding(false));
        Json = json;
    }

    // "b <bity> <knoflík použit>" z myši. Akce = při puštění tlačítka, jen když se mezitím
    // nehýbalo knoflíkem (tlačítko držené kvůli oddálení nic nespustí). V Joysticku nic.
    public static void Udalost(string radek)
    {
        var a = radek.Split(' ');
        int bity, pouzit;
        if (a.Length < 3 || !int.TryParse(a[1], out bity) || !int.TryParse(a[2], out pouzit)) return;
        var pusteno = predtim & ~bity;
        predtim = bity;
        if (Rezim() == 1) return;
        // Ve Fusionu: tlačítko nastavené jako „oddálení“ — když se při držení hýbalo knoflíkem,
        // šlo o zoom a zkratka se nespustí. Jinde (a u ostatních tlačítek) se zkratka spustí vždy.
        // Tlačítko držené kvůli oddálení (zmáčknutí knoflíku) zkratku nespustí.
        if ((pusteno & 1) != 0 && !(pouzit != 0 && JeModifikator("modLeft"))) Proved("left");
        if ((pusteno & 2) != 0 && !(pouzit != 0 && JeModifikator("modRight"))) Proved("right");
    }

    // Slouží tlačítko v programu v popředí jako „oddálit“? Fusion: { "zoom": { "modLeft", "modRight" } }
    // (doplněk), jiné programy: apps[exe].press.flip (zmáčknutí s tlačítkem opačně).
    static bool JeModifikator(string klic)
    {
        try
        {
            Dictionary<string, object> d;
            var cil = ProgramVPopredi(out d);
            if (Popredi() == "fusion360")
            {
                object z, v;
                if (d.TryGetValue("zoom", out z) && ((Dictionary<string, object>)z).TryGetValue(klic, out v)) return (bool)v;
                return true; // výchozí: obě tlačítka oddalují
            }
            object press;
            return cil != null && cil.TryGetValue("press", out press) && (bool)((Dictionary<string, object>)press)["flip"];
        }
        catch (Exception) { return false; }
    }

    // --- Přemapování os podle programu v popředí (např. Blender: náklony = posun) ---
    // apps[exe].map = [6 čísel] pro výstupní osy Tx..Rz: ±1..6 = zdrojová osa (minus = obráceně), 0 = vypnuto.
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint tid, uint flags);
    static WinEventProc hlidac; // musí žít, jinak ho GC uklidí a Windows zavolá neplatnou adresu
    static string posledniMapa;

    // Volat z UI vlákna: Windows pak samy hlásí každou změnu okna v popředí (žádné dotazování).
    public static void HlidejPopredi()
    {
        hlidac = (h, e, w, o, c, t, ti) => PosliMapu(false);
        SetWinEventHook(3, 3, IntPtr.Zero, hlidac, 0, 0, 0); // EVENT_SYSTEM_FOREGROUND, mimo proces
    }

    // Nastavení programu v popředí (apps[exe]), nebo null = program bez vlastního nastavení.
    static Dictionary<string, object> ProgramVPopredi(out Dictionary<string, object> vse)
    {
        vse = (Dictionary<string, object>)js.DeserializeObject(Json);
        var apps = vse.ContainsKey("apps") ? vse["apps"] as Dictionary<string, object> : null;
        object prog;
        return apps != null && apps.TryGetValue(Popredi(), out prog) ? (Dictionary<string, object>)prog : null;
    }

    static bool MaAkci(Dictionary<string, object> nastaveni)
    {
        foreach (var b in new[] { "left", "right" })
        {
            object a, k;
            if (nastaveni != null && nastaveni.TryGetValue(b, out a) && ((Dictionary<string, object>)a).TryGetValue("keys", out k) && !string.IsNullOrEmpty(k as string)) return true;
        }
        return false;
    }

    // Myši pošle: "map …" (přemapování os) a "press <osa> <flip> <hid>" (zmáčknutí jako zoom,
    // tlačítka do PC jen když jim ikonka nepřiřadila zkratku).
    public static void PosliMapu(bool vzdy)
    {
        var m = "1 2 3 4 5 6";
        var p = "0 0 1";
        try
        {
            Dictionary<string, object> vse;
            var cil = ProgramVPopredi(out vse);
            object mapa, press;
            var maPress = cil != null && cil.ContainsKey("press");
            if (cil != null && cil.TryGetValue("map", out mapa) && mapa is object[] && ((object[])mapa).Length == 6)
                // když zmáčknutí řídí "press", v map být nesmí (jinak by se poslalo dvakrát)
                m = string.Join(" ", ((object[])mapa).Select(x => { var v = Convert.ToInt32(x); return (maPress && Math.Abs(v) == 3 ? 0 : v).ToString(); }));
            int to = 0, flip = 0;
            if (cil != null && cil.TryGetValue("press", out press))
            {
                var pr = (Dictionary<string, object>)press;
                to = Convert.ToInt32(pr["to"]);
                flip = pr.ContainsKey("flip") && (bool)pr["flip"] ? 1 : 0;
            }
            // Tlačítka do PC (HID) jen když je ikonka nevyužívá: nemají zkratku ani neslouží k oddálení.
            // Jinak by je program vzal po svém (Blender: levé = navigační menu 3D myši).
            var hid = flip == 1 || MaAkci(cil ?? (vse.ContainsKey("default") ? (Dictionary<string, object>)vse["default"] : null)) ? 0 : 1;
            p = to + " " + flip + " " + hid;
        }
        catch (Exception) { }
        var obe = m + "|" + p;
        if (!vzdy && obe == posledniMapa) return;
        posledniMapa = obe;
        Mys.Posli("map " + m);
        Mys.Posli("press " + p);
    }

    public static string Popredi()
    {
        try
        {
            uint pid;
            GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            using (var p = Process.GetProcessById((int)pid)) return p.ProcessName.ToLowerInvariant();
        }
        catch (Exception) { return ""; }
    }

    static void Proved(string tlacitko)
    {
        try
        {
            var d = (Dictionary<string, object>)js.DeserializeObject(Json);
            var apps = d.ContainsKey("apps") ? d["apps"] as Dictionary<string, object> : null;
            object prog;
            var cil = apps != null && apps.TryGetValue(Popredi(), out prog) ? (Dictionary<string, object>)prog : (Dictionary<string, object>)d["default"];
            object akce;
            if (!cil.TryGetValue(tlacitko, out akce)) return;
            object keys;
            if (!((Dictionary<string, object>)akce).TryGetValue("keys", out keys)) return;
            var k = keys as string ?? "";
            // "Fusion:Home" apod. = funkce bez klávesové zkratky; provede ji doplněk Fusionu přes API
            if (k.StartsWith("Fusion:")) Server.Rozesli("akce " + k.Substring(7));
            else Klavesy(k);
        }
        catch (Exception) { } // chybné nastavení nesmí shodit ikonku
    }

    // "Ctrl+Shift+Z", "F6", "NumPad5", "MediaPlayPause"… (názvy kláves podle System.Windows.Forms.Keys)
    public static void Klavesy(string kombinace)
    {
        if (string.IsNullOrWhiteSpace(kombinace)) return;
        var mody = new List<byte>();
        Keys klavesa = Keys.None;
        foreach (var cast in kombinace.Split('+'))
        {
            var c = cast.Trim();
            if (c.Equals("Ctrl", StringComparison.OrdinalIgnoreCase)) mody.Add(0x11);
            else if (c.Equals("Shift", StringComparison.OrdinalIgnoreCase)) mody.Add(0x10);
            else if (c.Equals("Alt", StringComparison.OrdinalIgnoreCase)) mody.Add(0x12);
            else if (c.Equals("Win", StringComparison.OrdinalIgnoreCase)) mody.Add(0x5B);
            else if (c.All(char.IsDigit) || !Enum.TryParse(c, true, out klavesa)) return; // čísla by Enum vzal jako kód (1 = myš) -> raději nic
        }
        if (klavesa == Keys.None) return;
        var vk = (byte)klavesa;
        // navigační klávesy potřebují příznak "extended", jinak se chovají jako numerická klávesnice
        var ext = new[] { Keys.Home, Keys.End, Keys.PageUp, Keys.PageDown, Keys.Left, Keys.Right, Keys.Up, Keys.Down,
                          Keys.Insert, Keys.Delete, Keys.Divide }.Contains(klavesa) ? 1u : 0u;
        foreach (var m in mody) keybd_event(m, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, ext, UIntPtr.Zero);
        keybd_event(vk, 0, ext | 2, UIntPtr.Zero);
        for (int i = mody.Count - 1; i >= 0; i--) keybd_event(mody[i], 0, 2, UIntPtr.Zero);
    }

    // Programy s oknem, které teď běží: [{ "exe": "fusion360", "name": "Autodesk Fusion" }, …]
    public static string Aplikace()
    {
        var seznam = new List<Dictionary<string, string>>();
        var videno = new HashSet<string>();
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                if (p.MainWindowHandle == IntPtr.Zero || p.MainWindowTitle == "") continue;
                var exe = p.ProcessName.ToLowerInvariant();
                if (!videno.Add(exe)) continue;
                string jmeno = null;
                try { jmeno = p.MainModule.FileVersionInfo.FileDescription; } catch (Exception) { } // chráněné procesy
                seznam.Add(new Dictionary<string, string> { { "exe", exe }, { "name", string.IsNullOrWhiteSpace(jmeno) ? p.ProcessName : jmeno.Trim() } });
            }
            catch (Exception) { }
            finally { p.Dispose(); }
        }
        return js.Serialize(seznam.OrderBy(x => x["name"]).ToList());
    }

    // Příkazy stránky pro ikonku (ne pro myš): vrací odpověď pro tu stránku.
    public static string Prikaz(string p)
    {
        if (p == "tray buttons-get") return "buttons " + Json;
        if (p == "tray apps") return "apps " + Aplikace();
        if (p == "tray fusion-list") { Server.Rozesli("akce list"); return "ok"; } // doplněk zapíše seznam příkazů Fusionu
        if (p.StartsWith("tray buttons-set "))
        {
            try { Uloz(p.Substring("tray buttons-set ".Length)); Server.Rozesli("buttons " + Json); PosliMapu(true); return "ok"; } // i doplňku Fusionu (zoom)
            catch (Exception) { return "err tlačítka: neplatné nastavení"; }
        }
        return "err neznámý příkaz ikonky";
    }
}

// Aktuální stav myši podle posledního "cfg {...}".
class Stav
{
    public int Rezim = -1;
    public bool Spi;
    public Color Barva = Color.Gray;
    public int Jas = 40;
    public double Citlivost = 1.0;
    public List<Color> Oblibene = new List<Color>();
    public string PosledniCfg;

    public static Color Hex(string h) { return Color.FromArgb(255, Color.FromArgb(int.Parse(h, NumberStyles.HexNumber))); }
    public static string Hex(Color c) { return string.Format("{0:X2}{1:X2}{2:X2}", c.R, c.G, c.B); }

    // Příkaz, který stránka poslala myši — ikonka si z něj vezme novou hodnotu hned, bez dotazu na myš.
    public void Prikaz(string p)
    {
        var a = p.Trim().Split(new[] { ' ' }, 2);
        if (a.Length < 2) return;
        try
        {
            switch (a[0])
            {
                case "color": Barva = Hex(a[1].Trim()); break;
                case "bright": Jas = int.Parse(a[1]); break;
                case "sens": Citlivost = double.Parse(a[1], CultureInfo.InvariantCulture); break;
                case "mode": Rezim = int.Parse(a[1]); break;
                case "fav":
                    Oblibene.Clear();
                    foreach (Match f in Regex.Matches(a[1], "[0-9A-Fa-f]{6}")) Oblibene.Add(Hex(f.Value));
                    break;
            }
        }
        catch (FormatException) { } // nečitelná hodnota — myš ji stejně odmítne
    }

    public void Nacti(string cfg)
    {
        PosledniCfg = cfg;
        Match m;
        if ((m = Regex.Match(cfg, "\"mode\":(\\d+)")).Success) Rezim = int.Parse(m.Groups[1].Value);
        if ((m = Regex.Match(cfg, "\"sleep\":(\\d)")).Success) Spi = m.Groups[1].Value == "1";
        if ((m = Regex.Match(cfg, "\"color\":\"([0-9A-Fa-f]{6})\"")).Success) Barva = Hex(m.Groups[1].Value);
        if ((m = Regex.Match(cfg, "\"bright\":(\\d+)")).Success) Jas = int.Parse(m.Groups[1].Value);
        if ((m = Regex.Match(cfg, "\"sens\":([0-9.]+)")).Success) Citlivost = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        if ((m = Regex.Match(cfg, "\"fav\":\\[([^\\]]*)\\]")).Success)
        {
            Oblibene.Clear();
            foreach (Match f in Regex.Matches(m.Groups[1].Value, "[0-9A-Fa-f]{6}")) Oblibene.Add(Hex(f.Value));
        }
    }
}

// Mini server pro ladicí stránku: statické soubory + /ws (WebSocket <-> sériák).
static class Server
{
    public const int PortHttp = 47390;
    static HttpListener http;
    static string slozka;
    // Klienti = otevřené stránky (WebSocket) i doplňky čtoucí /stream; každý má svou frontu řádků.
    static readonly ConcurrentDictionary<object, BlockingCollection<string>> klienti = new ConcurrentDictionary<object, BlockingCollection<string>>();
    public static Func<string> Cfg;
    public static Action<string> Prikaz; // příkaz ze stránky -> ikonka aktualizuje svůj stav

    public static void Start(string web)
    {
        if (http != null) return;
        slozka = web;
        http = new HttpListener();
        http.Prefixes.Add("http://localhost:" + PortHttp + "/");
        http.Start();
        Task.Run(() => Prijimej());
    }

    public static bool MaKlienty { get { return !klienti.IsEmpty; } }

    public static void Rozesli(string radek)
    {
        foreach (var q in klienti.Values) if (q.Count < 500) q.Add(radek);
    }

    static async Task Prijimej()
    {
        while (true)
        {
            var ctx = await http.GetContextAsync();
            if (ctx.Request.IsWebSocketRequest) { var _ = Klient(ctx); continue; }
            if (ctx.Request.Url.AbsolutePath == "/stream") { var _ = Proud(ctx); continue; }
            try { Soubor(ctx); } catch (Exception) { }
            ctx.Response.Close();
        }
    }

    static void Soubor(HttpListenerContext ctx)
    {
        var cesta = Uri.UnescapeDataString(ctx.Request.Url.AbsolutePath).TrimStart('/');
        if (cesta == "") cesta = "index.html";
        var plna = Path.GetFullPath(Path.Combine(slozka, cesta));
        if (!plna.StartsWith(slozka, StringComparison.OrdinalIgnoreCase) || !File.Exists(plna)) { ctx.Response.StatusCode = 404; return; }
        var typy = new Dictionary<string, string> { { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" }, { ".css", "text/css; charset=utf-8" }, { ".svg", "image/svg+xml" }, { ".json", "application/json; charset=utf-8" }, { ".png", "image/png" } };
        string typ;
        ctx.Response.ContentType = typy.TryGetValue(Path.GetExtension(plna).ToLowerInvariant(), out typ) ? typ : "application/octet-stream";
        ctx.Response.AddHeader("Cache-Control", "no-store");
        var data = File.ReadAllBytes(plna);
        ctx.Response.OutputStream.Write(data, 0, data.Length);
    }

    // Proud řádků z myši pro doplňky (Fusion): obyčejné HTTP, řádek po řádku, dokud se klient neodpojí.
    // Bezpečnost: k ikonce se smí připojit jen naše stránka (okno CAD Mouse) a programy bez prohlížeče
    // (doplněk Fusionu hlavičku Origin neposílá). Cizí webová stránka otevřená v prohlížeči by se jinak
    // přes WebSocket na localhost připojila taky a mohla by posílat příkazy i stisky kláves.
    static bool Povoleno(HttpListenerContext ctx)
    {
        var o = ctx.Request.Headers["Origin"];
        if (o == null || o == "http://localhost:" + PortHttp || o == "http://127.0.0.1:" + PortHttp) return true;
        ctx.Response.StatusCode = 403;
        ctx.Response.Close();
        return false;
    }

    static async Task Proud(HttpListenerContext ctx)
    {
        if (!Povoleno(ctx)) return;
        var fronta = new BlockingCollection<string>();
        var id = new object();
        klienti[id] = fronta;
        fronta.Add("buttons " + Tlacitka.Json); // doplněk si z toho vezme nastavení zoomu
        Mys.Posli("stream 1");
        ctx.Response.SendChunked = true;
        ctx.Response.ContentType = "text/plain; charset=ascii";
        var s = ctx.Response.OutputStream;
        await Task.Run(() =>
        {
            try
            {
                foreach (var r in fronta.GetConsumingEnumerable())
                {
                    var b = Encoding.ASCII.GetBytes(r + "\n");
                    s.Write(b, 0, b.Length);
                    s.Flush();
                }
            }
            catch (Exception) { }
        });
        BlockingCollection<string> x;
        klienti.TryRemove(id, out x);
        try { ctx.Response.Close(); } catch (Exception) { }
        if (klienti.IsEmpty) Mys.Posli("stream 0");
    }

    static async Task Klient(HttpListenerContext ctx)
    {
        if (!Povoleno(ctx)) return;
        WebSocket ws;
        try { ws = (await ctx.AcceptWebSocketAsync(null)).WebSocket; }
        catch (Exception) { ctx.Response.StatusCode = 500; ctx.Response.Close(); return; }
        var fronta = new BlockingCollection<string>();
        klienti[ws] = fronta;
        fronta.Add(Mys.Pripojeno ? "conn 1" : "conn 0");
        var cfg = Cfg();
        if (cfg != null) fronta.Add(cfg);

        var odesilac = Task.Run(async () =>
        {
            foreach (var r in fronta.GetConsumingEnumerable())
            {
                var b = Encoding.UTF8.GetBytes(r);
                try { await ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true, CancellationToken.None); }
                catch (Exception) { break; }
            }
        });

        var buf = new byte[4096];
        var sb = new StringBuilder();
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                var res = await ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
                if (res.MessageType == WebSocketMessageType.Close) break;
                sb.Append(Encoding.UTF8.GetString(buf, 0, res.Count));
                if (!res.EndOfMessage) continue;
                foreach (var prikaz in sb.ToString().Split('\n'))
                    if (prikaz.Trim() != "")
                    {
                        if (prikaz.StartsWith("tray ")) { fronta.Add(Tlacitka.Prikaz(prikaz.Trim())); continue; }
                        Mys.Posli(prikaz);
                        if (Prikaz != null) Prikaz(prikaz);
                    }
                sb.Clear();
            }
        }
        catch (Exception) { }
        BlockingCollection<string> x;
        klienti.TryRemove(ws, out x);
        fronta.CompleteAdding();
        if (klienti.IsEmpty) Mys.Posli("stream 0"); // stránka zavřená -> myš přestane posílat data
        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch (Exception) { }
    }
}

// Okénko ve stylu Rychlého nastavení Win11: dlaždice režimů, oblíbené barvy, jas, citlivost.
class Menu : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);

    readonly Stav stav;
    readonly Color pozadi = Color.FromArgb(44, 44, 44), dlazdice = Color.FromArgb(60, 60, 60), text = Color.FromArgb(240, 240, 240), slaby = Color.FromArgb(160, 160, 160);
    static readonly Color Akcent = Color.FromArgb(0xE5, 0x32, 0x2D);
    const int W = 320, P = 14;
    Rectangle[] dlazdiceR = { new Rectangle(P, P, 140, 78), new Rectangle(P + 152, P, 140, 78) };
    Rectangle jasR = new Rectangle(P + 72, 158, W - 2 * P - 72, 20), citR = new Rectangle(P + 72, 192, W - 2 * P - 72, 20);
    Rectangle ladeniR = new Rectangle(P - 4, 232, W - 2 * P + 8, 36);
    string tazeno;
    public Action Ladeni;

    public Menu(Stav s)
    {
        stav = s;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = pozadi;
        ClientSize = new Size(W, 282);
        DoubleBuffered = true;
        Font = new Font("Segoe UI Variable Text", 10f, GraphicsUnit.Point);
        int kulate = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(Handle, 33, ref kulate, 4);
        int tmave = 1;
        DwmSetWindowAttribute(Handle, 20, ref tmave, 4);
        Deactivate += (o, e) => { Hide(); CadMouseTray.Uvolni(); };
    }

    public void Ukaz()
    {
        var wa = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(wa.Right - Width - 12, wa.Bottom - Height - 12);
        Show();
        Activate();
        Invalidate();
    }

    Rectangle BarvaR(int i) { return new Rectangle(P + 72 + i * 30, 122, 22, 22); }

    static GraphicsPath Zaobleny(Rectangle r, int rad)
    {
        var g = new GraphicsPath();
        int d = rad * 2;
        g.AddArc(r.X, r.Y, d, d, 180, 90); g.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        g.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); g.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        g.CloseFigure();
        return g;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        string[] nazvy = { "SpaceMouse", "Joystick" }, popisy = { "CAD, Blender", "létání" }, ikony = { "\uE7AD", "\uE7FC" };
        using (var ikonaF = new Font("Segoe Fluent Icons", 16f, GraphicsUnit.Point))
        using (var tucne = new Font(Font, FontStyle.Bold))
        using (var male = new Font(Font.FontFamily, 8.5f))
            for (int i = 0; i < 2; i++)
            {
                bool on = stav.Rezim == i;
                using (var b = new SolidBrush(on ? Akcent : dlazdice)) using (var cesta = Zaobleny(dlazdiceR[i], 6)) g.FillPath(b, cesta);
                var r = dlazdiceR[i];
                using (var t = new SolidBrush(on ? Color.White : text))
                {
                    g.DrawString(ikony[i], ikonaF, t, r.X + 10, r.Y + 10);
                    g.DrawString(nazvy[i], tucne, t, r.X + 10, r.Y + 36);
                }
                using (var t = new SolidBrush(on ? Color.FromArgb(255, 220, 218) : slaby)) g.DrawString(popisy[i], male, t, r.X + 10, r.Y + 55);
            }

        using (var t = new SolidBrush(slaby))
        {
            g.DrawString("LED", Font, t, P, 123);
            g.DrawString("Jas", Font, t, P, jasR.Y);
            g.DrawString("Citlivost", Font, t, P, citR.Y);
        }
        for (int i = 0; i < stav.Oblibene.Count; i++)
        {
            var r = BarvaR(i);
            using (var b = new SolidBrush(stav.Oblibene[i])) g.FillEllipse(b, r);
            if (stav.Oblibene[i].ToArgb() == stav.Barva.ToArgb())
                using (var pero = new Pen(Color.White, 2)) g.DrawEllipse(pero, Rectangle.Inflate(r, 3, 3));
        }
        Posuvnik(g, jasR, stav.Jas / 255.0, stav.Jas * 100 / 255 + " %");
        Posuvnik(g, citR, (stav.Citlivost - 0.2) / 4.8, stav.Citlivost.ToString("0.0×", CultureInfo.InvariantCulture));

        using (var pero = new Pen(Color.FromArgb(70, 70, 70))) g.DrawLine(pero, P, ladeniR.Y - 6, W - P, ladeniR.Y - 6);
        using (var t = new SolidBrush(text)) g.DrawString("Ladění a kalibrace", Font, t, ladeniR.X + 6, ladeniR.Y + 8);
        using (var ikonaF = new Font("Segoe Fluent Icons", 11f, GraphicsUnit.Point)) using (var t = new SolidBrush(slaby))
            g.DrawString("\uE713", ikonaF, t, ladeniR.Right - 30, ladeniR.Y + 9);
        if (!Mys.Pripojeno)
            using (var t = new SolidBrush(Akcent)) g.DrawString("Myš není připojená", Font, t, P, 96);
    }

    void Posuvnik(Graphics g, Rectangle r, double hodnota, string popis)
    {
        hodnota = Math.Max(0, Math.Min(1, hodnota));
        int y = r.Y + r.Height / 2, sirka = r.Width - 52;
        int x = r.X + (int)(hodnota * sirka);
        using (var b = new SolidBrush(Color.FromArgb(90, 90, 90))) g.FillRectangle(b, r.X, y - 2, sirka, 4);
        using (var b = new SolidBrush(Akcent)) g.FillRectangle(b, r.X, y - 2, x - r.X, 4);
        using (var b = new SolidBrush(text)) g.FillEllipse(b, x - 8, y - 8, 16, 16);
        using (var b = new SolidBrush(Akcent)) g.FillEllipse(b, x - 4, y - 4, 8, 8);
        using (var t = new SolidBrush(slaby)) g.DrawString(popis, Font, t, r.X + sirka + 10, r.Y);
    }

    double Hodnota(Rectangle r, int x) { return Math.Max(0, Math.Min(1, (x - r.X) / (double)(r.Width - 52))); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        for (int i = 0; i < 2; i++)
            if (dlazdiceR[i].Contains(e.Location) && stav.Rezim != i && Mys.Pripojeno)
            {
                Mys.Posli("mode " + i); // myš uloží a restartuje se jako jiné USB zařízení
                stav.Rezim = i;
                Invalidate();
                return;
            }
        for (int i = 0; i < stav.Oblibene.Count; i++)
            if (Rectangle.Inflate(BarvaR(i), 4, 4).Contains(e.Location))
            {
                stav.Barva = stav.Oblibene[i];
                Mys.Posli("color " + Stav.Hex(stav.Barva));
                Mys.Posli("save");
                Mys.Posli("get"); // otevřená stránka dostane nový stav
                Invalidate();
                return;
            }
        if (Rectangle.Inflate(jasR, 0, 6).Contains(e.Location)) tazeno = "jas";
        else if (Rectangle.Inflate(citR, 0, 6).Contains(e.Location)) tazeno = "cit";
        else if (ladeniR.Contains(e.Location)) { Hide(); if (Ladeni != null) Ladeni(); return; }
        OnMouseMove(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (tazeno == "jas")
        {
            stav.Jas = (int)Math.Round(Hodnota(jasR, e.X) * 255);
            Mys.Posli("bright " + stav.Jas);
        }
        else if (tazeno == "cit")
        {
            stav.Citlivost = Math.Round(0.2 + Hodnota(citR, e.X) * 4.8, 1);
            Mys.Posli("sens " + stav.Citlivost.ToString(CultureInfo.InvariantCulture));
        }
        else return;
        Invalidate();
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (tazeno != null) { Mys.Posli("save"); Mys.Posli("get"); } // get = otevřená stránka dostane nový stav
        tazeno = null;
    }
}

// Vlastní okno aplikace „CAD Mouse“: ladicí stránka ve WebView2 (engine Edge, který je ve Windows),
// takže to není prohlížeč s adresním řádkem. Po zavření se WebView2 uvolní a ikonka zase drží pár MB.
class Okno : Form
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
    readonly WebView2 web;

    public Okno(string url, string dataSlozka)
    {
        Text = "CAD Mouse";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        BackColor = Color.FromArgb(0x16, 0x18, 0x1B);
        StartPosition = FormStartPosition.CenterScreen;
        var wa = Screen.PrimaryScreen.WorkingArea;
        ClientSize = new Size(Math.Min(1440, wa.Width - 80), Math.Min(900, wa.Height - 80));
        MinimumSize = new Size(1000, 640);
        int tmave = 1;
        DwmSetWindowAttribute(Handle, 20, ref tmave, 4); // tmavý titulek okna
        web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
        web.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = dataSlozka };
        web.CoreWebView2InitializationCompleted += (s, e) =>
        {
            if (!e.IsSuccess) { MessageBox.Show("Okno ladění nejde otevřít (WebView2): " + e.InitializationException.Message, "CAD Mouse"); Close(); return; }
            var st = web.CoreWebView2.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsZoomControlEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+R, F5, Ctrl+P… jdou stránce (nahrávání zkratek)
            // okno smí ukazovat jen naši stránku, žádné jiné weby ani nová okna
            web.CoreWebView2.NavigationStarting += (o, n) => { if (!n.Uri.StartsWith(url, StringComparison.OrdinalIgnoreCase)) n.Cancel = true; };
            web.CoreWebView2.NewWindowRequested += (o, n) => { n.Handled = true; };
        };
        Controls.Add(web);
        web.Source = new Uri(url);
    }

    public WebView2 Web { get { return web; } }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        web.Dispose();
        base.OnFormClosed(e);
        CadMouseTray.Uvolni();
    }
}

static class CadMouseTray
{
    static Okno okno;
    static string DataWebView(string pripona = "")
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CadMouse", "WebView2" + pripona);
    }

    static void OtevriLadeni()
    {
        try { Server.Start(WebSlozka()); }
        catch (Exception ex) { MessageBox.Show("Server ladění nejde spustit: " + ex.Message, "CAD Mouse"); return; }
        if (okno == null || okno.IsDisposed)
        {
            okno = new Okno("http://localhost:" + Server.PortHttp + "/", DataWebView());
            okno.Show();
        }
        if (okno.WindowState == FormWindowState.Minimized) okno.WindowState = FormWindowState.Normal;
        okno.Activate();
    }

    static NotifyIcon ni;
    static Stav stav = new Stav();
    static Menu menu;

    // Glyf jako obrys vyplněný a ještě obtažený — tučnější a větší než text, na tmavé liště
    // je vidět podobně jako systémové ikonky (mikrofon apod.).
    static Bitmap GlyphBitmap(string znak, Color barva)
    {
        var b = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(b))
        using (var ff = new FontFamily("Segoe Fluent Icons"))
        using (var cesta = new GraphicsPath())
        using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
        using (var br = new SolidBrush(barva))
        using (var pero = new Pen(barva, 0.9f) { LineJoin = LineJoin.Round })
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            cesta.AddString(znak, ff, 0, 26f, new RectangleF(0, 1, 32, 32), sf);
            g.FillPath(br, cesta);
            g.DrawPath(pero, cesta);
        }
        return b;
    }

    // Barva LED zesvětlená pro lištu: čistá červená/modrá jsou na tmavém pozadí moc tmavé.
    static Color ProListu(Color c)
    {
        if (c.GetBrightness() < 0.15) return Color.White;
        Func<int, int> k = x => x + (255 - x) * 35 / 100;
        return Color.FromArgb(k(c.R), k(c.G), k(c.B));
    }

    static Icon Glyph(string znak, Color barva)
    {
        using (var b = GlyphBitmap(znak, barva))
        {
            var h = b.GetHicon();
            var ikona = (Icon)Icon.FromHandle(h).Clone();
            DestroyIcon(h);
            return ikona;
        }
    }
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool SetProcessWorkingSetSize(IntPtr p, IntPtr min, IntPtr max);

    // Vrátí nepoužívanou paměť systému, v klidu pak ikona drží jen pár MB.
    public static void Uvolni()
    {
        GC.Collect();
        SetProcessWorkingSetSize(Process.GetCurrentProcess().Handle, (IntPtr)(-1), (IntPtr)(-1));
    }

    static void Obnov()
    {
        var stara = ni.Icon;
        if (!Mys.Pripojeno)
        {
            ni.Icon = Glyph("\uE7AD", Color.Gray);
            ni.Text = "CAD Mouse: nepřipojeno";
        }
        else
        {
            // příliš tmavá LED by na liště zmizela -> bílá
            var c = ProListu(stav.Barva);
            if (stav.Spi) c = Color.FromArgb((c.R + 128) / 2, (c.G + 128) / 2, (c.B + 128) / 2); // spí = vybledlá
            ni.Icon = Glyph(stav.Rezim == 1 ? "\uE7FC" : "\uE7AD", c);
            ni.Text = (stav.Rezim == 1 ? "CAD Mouse: Joystick" : "CAD Mouse: SpaceMouse") + (stav.Spi ? " (spí)" : "");
        }
        if (stara != null) stara.Dispose();
        if (menu.Visible) menu.Invalidate();
    }

    static string WebSlozka()
    {
        var exe = Path.GetDirectoryName(Application.ExecutablePath);
        return Path.GetFullPath(Path.Combine(exe, @"..\ladeni-web")) + Path.DirectorySeparatorChar;
    }

    const string RunKlic = @"Software\Microsoft\Windows\CurrentVersion\Run";

    static bool Autostart
    {
        get { using (var k = Registry.CurrentUser.OpenSubKey(RunKlic)) return k != null && k.GetValue("CadMouseTray") != null; }
        set
        {
            using (var k = Registry.CurrentUser.CreateSubKey(RunKlic))
                if (value) k.SetValue("CadMouseTray", "\"" + Application.ExecutablePath + "\"");
                else k.DeleteValue("CadMouseTray", false);
        }
    }

    [STAThread]
    static void Main(string[] a)
    {
        if (a.Length > 0 && a[0] == "/test")
        {
            var port = Mys.NajdiPort();
            Console.WriteLine(port ?? "nenalezeno");
            Environment.Exit(port == null ? 1 : 0);
        }
        if (a.Length > 1 && a[0] == "/nahled") // vykreslí menu s ukázkovým stavem do PNG (kontrola vzhledu)
        {
            stav.Nacti("cfg {\"mode\":0,\"fav\":[\"E5322D\",\"0040FF\",\"FF6000\",\"FFFFFF\"],\"color\":\"0040FF\",\"bright\":102,\"sens\":1.300}");
            if (a.Length > 2) Mys.Port = new SerialPort(); // "/nahled x.png pripojeno": menu jako s připojenou myší (screenshot do README)
            var m = new Menu(stav);
            using (var b = new Bitmap(m.Width, m.Height)) { m.DrawToBitmap(b, new Rectangle(0, 0, m.Width, m.Height)); b.Save(a[1]); }
            // ikonky na liště na tmavém pozadí: SpaceMouse červená / modrá, Joystick červená, nepřipojeno
            using (var lista = new Bitmap(4 * 40, 40))
            {
                using (var g = Graphics.FromImage(lista))
                {
                    g.Clear(Color.FromArgb(32, 32, 32));
                    var ikony = new[] { GlyphBitmap("", ProListu(Color.Red)), GlyphBitmap("", ProListu(Color.FromArgb(0, 0x40, 0xFF))),
                                        GlyphBitmap("", ProListu(Color.Red)), GlyphBitmap("", Color.Gray) };
                    for (int i = 0; i < ikony.Length; i++) { g.DrawImage(ikony[i], i * 40 + 4, 4); ikony[i].Dispose(); }
                }
                lista.Save(Path.ChangeExtension(a[1], null) + "-ikony.png");
            }
            return;
        }

        if (a.Length > 1 && a[0] == "/okno-nahled") // otevře okno, počká na stránku a uloží snímek (kontrola vzhledu)
        {
            Application.EnableVisualStyles();
            var f = new Okno("http://localhost:" + Server.PortHttp + "/", DataWebView("-nahled"));
            f.Web.NavigationCompleted += async (s, e) =>
            {
                await Task.Delay(2500); // three.js a STL modely
                using (var soubor = File.Create(a[1]))
                    await f.Web.CoreWebView2.CapturePreviewAsync(Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat.Png, soubor);
                f.Close();
            };
            Application.Run(f);
            return;
        }

        // „Otevřít ladění“ zvenku (zástupce, druhé spuštění): běžící ikonka dostane signál a okno otevře sama.
        var signal = new EventWaitHandle(false, EventResetMode.AutoReset, "CadMouseTrayLadeni");
        bool nova;
        using (new Mutex(true, "CadMouseTray", out nova))
        {
            if (!nova)
            {
                if (a.Length > 0 && a[0] == "/ladeni") signal.Set();
                return;
            }

            Application.EnableVisualStyles();
            menu = new Menu(stav);
            var ui = menu.Handle; // vytvoří okno na UI vlákně kvůli BeginInvoke
            menu.Ladeni = OtevriLadeni;
            Server.Cfg = () => stav.PosledniCfg;
            Server.Prikaz = p => menu.BeginInvoke((Action)(() => { stav.Prikaz(p); Obnov(); }));
            try { Server.Start(WebSlozka()); } catch (Exception) { } // stránka pak jde otevřít i ze záložky; jinak se zkusí při kliknutí

            ni = new NotifyIcon { Visible = true };
            var auto = new MenuItem("Spouštět s Windows", (s, e) => { Autostart = !Autostart; ((MenuItem)s).Checked = Autostart; }) { Checked = Autostart };
            ni.ContextMenu = new ContextMenu(new[] { auto, new MenuItem("Ukončit", (s, e) => Application.Exit()) });
            ni.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) { if (menu.Visible) menu.Hide(); else menu.Ukaz(); } };

            Mys.Spojeni += pripojeno => menu.BeginInvoke((Action)(() =>
            {
                Server.Rozesli(pripojeno ? "conn 1" : "conn 0");
                if (pripojeno) Tlacitka.PosliMapu(true); // myš po restartu mapování nezná
                Obnov();
            }));
            Tlacitka.Nacti();
            Tlacitka.HlidejPopredi();
            Tlacitka.Rezim = () => stav.Rezim;
            Mys.Radek += r =>
            {
                Server.Rozesli(r);
                if (r.StartsWith("b ")) Tlacitka.Udalost(r);
                if (r == "z 1" || r == "z 0") menu.BeginInvoke((Action)(() => { stav.Spi = r == "z 1"; Obnov(); }));
                if (r.StartsWith("cfg ")) menu.BeginInvoke((Action)(() => { stav.Nacti(r); Obnov(); }));
            };
            new Thread(Mys.Smycka) { IsBackground = true }.Start();
            new Thread(() => { while (signal.WaitOne()) menu.BeginInvoke((Action)OtevriLadeni); }) { IsBackground = true }.Start();
            if (a.Length > 0 && a[0] == "/ladeni") menu.BeginInvoke((Action)OtevriLadeni);

            Obnov();
            var t = new System.Windows.Forms.Timer { Interval = 5000 };
            t.Tick += (s, e) => { t.Stop(); Uvolni(); };
            t.Start();
            Application.Run();
            ni.Dispose(); // jinak zůstane „mrtvá“ ikona u hodin
        }
    }
}
