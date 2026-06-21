#include "web.h"
#include "notify.h"
#include "protocol.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <string.h>

static WebServer server(80);

static const char PAGE[] PROGMEM = R"HTML(<!doctype html><html><head>
<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Stack light test</title><style>
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#111;color:#eee}
h1{font-size:18px;font-weight:500}h2{font-size:14px;font-weight:500;margin:18px 0 6px;color:#aaa}
button{font-size:15px;padding:10px 12px;margin:3px;border:0;border-radius:8px;color:#fff;cursor:pointer}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-bottom:6px}
.lbl{width:64px;display:inline-block;text-transform:capitalize}
.red{background:#c0392b}.green{background:#1e8449}.yellow{background:#b7950b}.blue{background:#2471a3}
.g{background:#444}.off{background:#222;outline:1px solid #555}
input[type=range]{width:170px;vertical-align:middle}
#b{color:#aaa}
</style></head><body>
<h1>Stack light test</h1>
<h2>Brightness <span id=b>80</span>%</h2>
<input type=range id=br min=0 max=100 value=80 oninput="b.textContent=this.value">
<h2>Lights</h2><div id=lights></div>
<h2>Volume <span id=v>100</span>% <small>(&gt;100 = overdrive, may distort)</small></h2>
<input type=range id=vol min=0 max=255 value=100 oninput="v.textContent=this.value">
<h2>Sound</h2><div class=row>
<button class=g onclick="snd('alert')">Alert</button>
<button class=g onclick="snd('error')">Error</button>
<button class=g onclick="snd('info')">Info</button></div>
<div class=row><button class=off onclick="go('/alloff','all off')">All off</button></div>
<div id=s></div>
<script>
var C=['red','green','yellow','blue'],L=document.getElementById('lights');
C.forEach(function(c){var d=document.createElement('div');d.className='row';
d.innerHTML='<span class=lbl>'+c+'</span>'+
'<button class="'+c+'" onclick="lt(\''+c+'\',\'solid\')">Solid</button>'+
'<button class="'+c+'" onclick="lt(\''+c+'\',\'flash\')">Flash</button>'+
'<button class="'+c+'" onclick="lt(\''+c+'\',\'pulse\')">Pulse</button>'+
'<button class=off onclick="lt(\''+c+'\',\'off\')">Off</button>';L.appendChild(d);});
function st(m){document.getElementById('s').textContent=m;}
function go(u,label){st(label+'...');fetch(u).then(function(r){return r.text();})
.then(function(t){st(label+' → '+t);}).catch(function(){st(label+' → error');});}
function lt(c,p){var br=document.getElementById('br').value;
var u=(p=='off')?'/light?color='+c+'&pattern=solid&bright=0':'/light?color='+c+'&pattern='+p+'&bright='+br;
go(u,c+' '+p);}
function snd(i){var vol=document.getElementById('vol').value;go('/sound?id='+i+'&vol='+vol,i+' '+vol+'%');}
</script></body></html>)HTML";

static void handleRoot() { server.send_P(200, "text/html", PAGE); }

static void handleLight() {
  String color = server.arg("color");
  String pattern = server.arg("pattern");
  int bright = server.hasArg("bright") ? server.arg("bright").toInt() : 80;
  char json[176];
  snprintf(json, sizeof(json),
    "{\"v\":1,\"type\":\"light\",\"color\":\"%s\",\"pattern\":\"%s\","
    "\"brightness\":%d,\"duration\":500,\"repeat_count\":3}",
    color.c_str(), pattern.c_str(), bright);
  ParsedMessage m = parse_message(json, strlen(json));
  if (m.kind == MsgKind::Light) { deliver_light(m.light); server.send(200, "text/plain", "ok"); }
  else server.send(400, "text/plain", "bad light");
}

static void handleSound() {
  String id = server.arg("id");
  int vol = server.hasArg("vol") ? server.arg("vol").toInt() : 100;
  char json[128];
  snprintf(json, sizeof(json),
    "{\"v\":1,\"type\":\"sound\",\"sound\":\"%s\","
    "\"volume\":%d,\"duration\":400,\"repeat_count\":1}",
    id.c_str(), vol);
  ParsedMessage m = parse_message(json, strlen(json));
  if (m.kind == MsgKind::Sound) { deliver_sound(m.sound); server.send(200, "text/plain", "ok"); }
  else server.send(400, "text/plain", "bad sound");
}

static void handleAllOff() {
  const char* colors[] = { "red", "green", "yellow", "blue" };
  for (auto c : colors) {
    char json[160];
    snprintf(json, sizeof(json),
      "{\"v\":1,\"type\":\"light\",\"color\":\"%s\",\"pattern\":\"solid\","
      "\"brightness\":0,\"duration\":1,\"repeat_count\":1}", c);
    ParsedMessage m = parse_message(json, strlen(json));
    if (m.kind == MsgKind::Light) deliver_light(m.light);
  }
  server.send(200, "text/plain", "ok");
}

void web_begin() {
  server.on("/", handleRoot);
  server.on("/light", handleLight);
  server.on("/sound", handleSound);
  server.on("/alloff", handleAllOff);
  server.on("/favicon.ico", []() { server.send(204); });   // quiet browser noise
  server.begin();
  Serial.printf("[web] test page: http://%s/\n", WiFi.localIP().toString().c_str());
}

void web_handle() { server.handleClient(); }
