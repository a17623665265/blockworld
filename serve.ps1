# Blockworld local static server + LAN signaling (pure PowerShell, no python/node/admin)
# Start: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8000]
# URL:   http://localhost:8000/   (also reachable from phones via LAN IP)
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less
#       scripts as GBK; non-ASCII comments corrupt parsing.
#
# Concurrency model: the main runspace only accepts TCP connections and hands
# each one to a runspace-pool worker. A slow/idle/trickling connection can
# therefore never block signaling polls or static file requests (the previous
# single-threaded accept loop stalled for the whole server). Shared room state
# uses concurrent collections plus per-room locks; cloud saves land through a
# GUID temp file and an atomic Move/Replace.
param([int]$Port = 8000)

$root = "d:\minecraft"
$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".gif"  = "image/gif"
  ".svg"  = "image/svg+xml"
  ".json" = "application/json"
  ".webmanifest" = "application/manifest+json"
  ".ico"  = "image/x-icon"
}
# HTML/JS/CSS must revalidate every load so updated game code is never stale
$revalidateExt = @(".html", ".js", ".css", ".json", ".webmanifest")

# ---------------- LAN signaling rooms (shared with worker runspaces) ----------------
# A room holds two one-way concurrent message queues:
#   hostQ  = messages FROM the guest, read by the host
#   guestQ = messages FROM the host, read by the guest
$ROOM_TTL_SEC = 900          # rooms expire 15 minutes after last activity
$SIG_MAX_BODY = 8192         # signaling payloads are tiny SDP/ICE blobs

# ---------------- Cloud saves (one JSON file per numeric code) ----------------
# File layout: saves/<code>.json containing
#   { code, ts(ms), locked(bool), ph(sha256 "code:password" hex), data(raw snapshot string) }
$saveDir = Join-Path $root "saves"
if (-not (Test-Path $saveDir)) { New-Item -ItemType Directory -Path $saveDir | Out-Null }
$SAVE_MAX_BODY = 12582912    # 12 MB hard cap per save upload

$rooms = [System.Collections.Concurrent.ConcurrentDictionary[string,object]]::new()
$logQ  = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()

$shared = @{
  Rooms         = $rooms
  LogQ          = $logQ
  Mime          = $mime
  RevalidateExt = $revalidateExt
  Root          = $root
  FullRoot      = (Resolve-Path $root).Path
  SaveDir       = $saveDir
  SigMaxBody    = $SIG_MAX_BODY
  SaveMaxBody   = $SAVE_MAX_BODY
  RoomTtlSec    = $ROOM_TTL_SEC
}

# Worker body: self-contained script executed inside a pool runspace.
# Single-quoted here-string: nothing is expanded here, the worker parses it.
$WorkerScript = @'
param($Client, $S)

Add-Type -AssemblyName System.Web.Extensions
$jsonSer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
# 15 MB: cloud save bodies wrap a ~4-6 MB world snapshot (signaling stays tiny)
$jsonSer.MaxJsonLength = 15728640
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$epoch = New-Object System.DateTime(1970,1,1,0,0,0,[System.DateTimeKind]::Utc)
$rooms = $S.Rooms

function Log-Worker($msg) {
  try { $S.LogQ.Enqueue((Get-Date -Format "HH:mm:ss") + " " + $msg) } catch {}
}

function Purge-Rooms {
  $now = [DateTime]::UtcNow
  foreach ($k in @($rooms.Keys)) {
    $r = $null
    if ($rooms.TryGetValue($k, [ref]$r) -and
        ($now - $r.t).TotalSeconds -gt $S.RoomTtlSec) {
      [void]$rooms.TryRemove($k, [ref]$null)
    }
  }
}

# Create a room under a fresh random code; ConcurrentDictionary.TryAdd makes
# the code allocation race-free across workers.
function New-Room {
  while ($true) {
    $code = ([System.Guid]::NewGuid().GetHashCode() -band 0x7fffffff) % 1000000
    $code = $code.ToString("000000")
    $room = @{
      hostQ  = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
      guestQ = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
      t      = [DateTime]::UtcNow
      guest  = $false
      gate   = [object]::new()
    }
    if ($rooms.TryAdd($code, $room)) { $room.code = $code; return $room }
  }
}

function Send-Response($stream, $code, $reason, $contentType, $bodyBytes, $extraHeaders) {
  if (-not $bodyBytes) { $bodyBytes = New-Object byte[] 0 }
  $head = "HTTP/1.1 $code $reason`r`n" +
          "Content-Type: $contentType`r`n" +
          "Content-Length: $($bodyBytes.Length)`r`n" +
          "Connection: close`r`n"
  if ($extraHeaders) { $head += $extraHeaders }
  $head += "`r`n"
  $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($headBytes, 0, $headBytes.Length)
  if ($bodyBytes.Length -gt 0) { $stream.Write($bodyBytes, 0, $bodyBytes.Length) }
  $stream.Flush()
}

function Send-Json($stream, $code, $reason, $obj) {
  $jsonText = $jsonSer.Serialize($obj)
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonText)
  Send-Response $stream $code $reason "application/json; charset=utf-8" $bodyBytes `
    ("Cache-Control: no-store`r`n")
}

function Read-RequestBody($stream, $reqBytes, $headerLength, $bodyLen) {
  # reqBytes already contains the raw header bytes; the body follows on the same stream
  $bodyBytes = New-Object System.Collections.Generic.List[byte]
  for ($k = $headerLength; $k -lt $reqBytes.Count; $k++) { [void]$bodyBytes.Add($reqBytes[$k]) }
  while ($bodyBytes.Count -lt $bodyLen) {
    $want = [Math]::Min(4096, $bodyLen - $bodyBytes.Count)
    $buf = New-Object byte[] $want
    $read = $stream.Read($buf, 0, $want)
    if ($read -le 0) { break }
    for ($k = 0; $k -lt $read; $k++) { [void]$bodyBytes.Add($buf[$k]) }
  }
  return [System.Text.Encoding]::UTF8.GetString($bodyBytes.ToArray())
}

function Parse-Query($target) {
  $query = @{}
  $qIdx = $target.IndexOf("?")
  if ($qIdx -ge 0) {
    foreach ($pair in $target.Substring($qIdx + 1).Split("&")) {
      $kv = $pair.Split("=", 2)
      if ($kv.Length -eq 2) {
        $query[[System.Uri]::UnescapeDataString($kv[0])] = [System.Uri]::UnescapeDataString($kv[1])
      }
    }
  }
  return $query
}

function Handle-Signal($stream, $method, $urlPath, $query, $bodyText) {
  Purge-Rooms
  if ($method -eq "POST" -and $urlPath -eq "/signal/host") {
    $room = New-Room
    Send-Json $stream 200 "OK" @{ ok = $true; code = $room.code; ttl = $S.RoomTtlSec }
    return
  }

  if ($method -eq "POST" -and $urlPath -eq "/signal/join") {
    $obj = $null
    try { $obj = $bodyText | ConvertFrom-Json } catch {}
    $code = "$($obj.code)".Trim()
    $room = $null
    if (-not $code -or -not $rooms.TryGetValue($code, [ref]$room)) {
      Send-Json $stream 404 "Not Found" @{ ok = $false; error = "room_not_found" }
      return
    }
    [System.Threading.Monitor]::Enter($room.gate)
    try {
      if ($room.guest) {
        Send-Json $stream 409 "Conflict" @{ ok = $false; error = "room_full" }
        return
      }
      $room.guest = $true
      $room.t = [DateTime]::UtcNow
    } finally {
      [System.Threading.Monitor]::Exit($room.gate)
    }
    Send-Json $stream 200 "OK" @{ ok = $true }
    return
  }

  if ($method -eq "POST" -and $urlPath -eq "/signal/send") {
    $obj = $null
    try { $obj = $bodyText | ConvertFrom-Json } catch {}
    $code = "$($obj.code)".Trim()
    $who  = "$($obj.who)".Trim()
    $room = $null
    if (-not $code -or -not $rooms.TryGetValue($code, [ref]$room) -or
        ($who -ne "host" -and $who -ne "guest")) {
      Send-Json $stream 400 "Bad Request" @{ ok = $false; error = "bad_request" }
      return
    }
    $msg = "$($obj.msg)"
    if ($who -eq "host") { $room.guestQ.Enqueue($msg) }
    else { $room.hostQ.Enqueue($msg) }
    $room.t = [DateTime]::UtcNow
    Send-Json $stream 200 "OK" @{ ok = $true }
    return
  }

  if ($method -eq "GET" -and $urlPath -eq "/signal/poll") {
    $code = "$($query['code'])".Trim()
    $who  = "$($query['who'])".Trim()
    $room = $null
    if (-not $code -or -not $rooms.TryGetValue($code, [ref]$room) -or
        ($who -ne "host" -and $who -ne "guest")) {
      Send-Json $stream 400 "Bad Request" @{ ok = $false; error = "bad_request" }
      return
    }
    # Each side drains the queue addressed TO it. ConcurrentQueue makes the
    # drain atomic with respect to concurrent sends.
    if ($who -eq "host") { $q = $room.hostQ } else { $q = $room.guestQ }
    $msgs = New-Object System.Collections.Generic.List[string]
    $item = $null
    while ($q.TryDequeue([ref]$item)) { [void]$msgs.Add($item) }
    $room.t = [DateTime]::UtcNow
    Send-Json $stream 200 "OK" @{ ok = $true; msgs = $msgs.ToArray() }
    return
  }

  Send-Json $stream 404 "Not Found" @{ ok = $false; error = "unknown_signal" }
}

# ---------------- Cloud save handlers ----------------

function Get-PwHash($code, $pw) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($code + ":" + $pw)
    $hash = $sha.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Read-SaveRecord($file) {
  try {
    $dictType = [System.Collections.Generic.Dictionary[string,object]]
    $txt = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
    return $jsonSer.Deserialize($txt, $dictType)
  } catch { return $null }
}

function Now-Ms {
  return [int64]([DateTime]::UtcNow.Subtract($epoch).TotalMilliseconds)
}

function Handle-Save($stream, $method, $urlPath, $query, $bodyText) {
  $saveDir = $S.SaveDir
  # GET /api/save/info?code=123 -> existence / locked flag, never returns data
  if ($method -eq "GET" -and $urlPath -eq "/api/save/info") {
    $code = "$($query['code'])".Trim()
    if ($code -notmatch '^\d{3,8}$') {
      Send-Json $stream 400 "Bad Request" @{ ok = $false; error = "bad_code" }
      return
    }
    $file = Join-Path $saveDir ($code + ".json")
    $rec = $null
    if (Test-Path $file -PathType Leaf) { $rec = Read-SaveRecord $file }
    if ($rec) {
      Send-Json $stream 200 "OK" @{ ok = $true; exists = $true;
        locked = [bool]$rec["locked"]; ts = [int64]$rec["ts"] }
    } else {
      Send-Json $stream 200 "OK" @{ ok = $true; exists = $false; locked = $false; ts = 0 }
    }
    return
  }

  if ($method -eq "POST" -and ($urlPath -eq "/api/save/get" -or $urlPath -eq "/api/save/put")) {
    $obj = $null
    try { $obj = $jsonSer.Deserialize($bodyText, [System.Collections.Generic.Dictionary[string,object]]) } catch {}
    if (-not $obj) {
      Send-Json $stream 400 "Bad Request" @{ ok = $false; error = "bad_request" }
      return
    }
    $code = "$($obj['code'])".Trim()
    if ($code -notmatch '^\d{3,8}$') {
      Send-Json $stream 400 "Bad Request" @{ ok = $false; error = "bad_code" }
      return
    }
    $pw = "$($obj['password'])"
    $file = Join-Path $saveDir ($code + ".json")

    # POST /api/save/get {code,password} -> full snapshot data
    if ($urlPath -eq "/api/save/get") {
      if (-not (Test-Path $file -PathType Leaf)) {
        Send-Json $stream 404 "Not Found" @{ ok = $false; error = "save_not_found" }
        return
      }
      $rec = Read-SaveRecord $file
      if (-not $rec) {
        Send-Json $stream 500 "Server Error" @{ ok = $false; error = "bad_record" }
        return
      }
      if ([bool]$rec["locked"] -and (Get-PwHash $code $pw) -ne [string]$rec["ph"]) {
        Send-Json $stream 403 "Forbidden" @{ ok = $false; error = "bad_password" }
        return
      }
      Send-Json $stream 200 "OK" @{ ok = $true; ts = [int64]$rec["ts"]; data = [string]$rec["data"] }
      return
    }

    # POST /api/save/put {code,password,data}: create new slot or overwrite existing
    $data = $obj["data"]
    if (-not ($data -is [string]) -or $data.Length -lt 2) {
      Send-Json $stream 400 "Bad Request" @{ ok = $false; error = "bad_request" }
      return
    }
    $locked = $false
    $ph = ""
    if (Test-Path $file -PathType Leaf) {
      $old = Read-SaveRecord $file
      if (-not $old) {
        Send-Json $stream 500 "Server Error" @{ ok = $false; error = "bad_record" }
        return
      }
      if ([bool]$old["locked"]) {
        if ((Get-PwHash $code $pw) -ne [string]$old["ph"]) {
          Send-Json $stream 403 "Forbidden" @{ ok = $false; error = "bad_password" }
          return
        }
        $locked = $true
        $ph = [string]$old["ph"]
      }
    } elseif ($pw.Length -gt 0) {
      $locked = $true
      $ph = Get-PwHash $code $pw
    }
    $ts = Now-Ms
    $out = @{ code = $code; ts = $ts; locked = $locked; ph = $ph; data = [string]$data }
    $jsonText = $jsonSer.Serialize($out)
    # GUID temp name: concurrent uploads to the same slot never collide on the
    # temp file, and the final swap is atomic (Move when absent, Replace when present).
    $tmp = Join-Path $saveDir ($code + "." + [System.Guid]::NewGuid().ToString("N") + ".tmp")
    try {
      [System.IO.File]::WriteAllText($tmp, $jsonText, $utf8NoBom)
      try {
        [System.IO.File]::Move($tmp, $file)
      } catch {
        # Destination exists: ReplaceFile swaps atomically. Its backup path
        # must be a real path -- PowerShell passes $null as "" which Win32
        # rejects ("path is not of a legal form").
        $bak = $tmp + ".bak"
        [System.IO.File]::Replace($tmp, $file, $bak)
        try { if (Test-Path $bak) { Remove-Item $bak -Force } } catch {}
      }
      Send-Json $stream 200 "OK" @{ ok = $true; ts = $ts }
    } catch {
      try { if (Test-Path $tmp) { Remove-Item $tmp -Force } } catch {}
      Send-Json $stream 500 "Server Error" @{ ok = $false; error = "write_failed" }
    }
    return
  }

  Send-Json $stream 404 "Not Found" @{ ok = $false; error = "unknown_api" }
}

function Process-Client($client) {
  $client.NoDelay = $true
  $client.ReceiveTimeout = 5000
  $client.SendTimeout = 10000
  $stream = $client.GetStream()

  # Read request headers (body bytes, if any, are kept in reqBytes too)
  $reqBytes = New-Object System.Collections.Generic.List[byte]
  $buf = New-Object byte[] 4096
  $headerText = $null
  $headerSepIndex = -1
  for ($i = 0; $i -lt 20; $i++) {
    $read = $stream.Read($buf, 0, $buf.Length)
    if ($read -le 0) { break }
    for ($k = 0; $k -lt $read; $k++) { [void]$reqBytes.Add($buf[$k]) }
    $headerText = [System.Text.Encoding]::ASCII.GetString($reqBytes.ToArray())
    $sep = $headerText.IndexOf("`r`n`r`n")
    if ($sep -ge 0) { $headerSepIndex = $sep; break }
  }
  if (-not $headerText -or $headerSepIndex -lt 0) { return }

  $headerPart = $headerText.Substring(0, $headerSepIndex)
  $lines = $headerPart.Split("`r`n")
  $parts = $lines[0].Split(" ")
  if ($parts.Length -lt 2) {
    Send-Response $stream 400 "Bad Request" "text/plain; charset=utf-8" `
      ([System.Text.Encoding]::UTF8.GetBytes("Bad request")) $null
    return
  }
  $method = $parts[0]
  $rawTarget = ($parts[1].Split("?"))[0]
  $urlPath = [System.Uri]::UnescapeDataString($rawTarget)

  # Parse Content-Length
  $bodyLen = 0
  foreach ($ln in $lines) {
    if ($ln.ToLower().StartsWith("content-length:")) {
      [int]::TryParse($ln.Substring(15).Trim(), [ref]$bodyLen) | Out-Null
    }
  }

  # Signaling endpoints (POST with small JSON body, or GET poll)
  if ($urlPath.StartsWith("/signal/")) {
    if ($bodyLen -gt $S.SigMaxBody) {
      Send-Json $stream 413 "Payload Too Large" @{ ok = $false; error = "too_large" }
      return
    }
    $headerByteLen = [System.Text.Encoding]::ASCII.GetByteCount($headerPart) + 4
    $bodyText = ""
    if ($method -eq "POST" -and $bodyLen -gt 0) {
      $bodyText = Read-RequestBody $stream $reqBytes $headerByteLen $bodyLen
    }
    Handle-Signal $stream $method $urlPath (Parse-Query $parts[1]) $bodyText
    return
  }

  # Cloud save endpoints (POST with multi-MB JSON body, or GET info)
  if ($urlPath.StartsWith("/api/save/")) {
    if ($bodyLen -gt $S.SaveMaxBody) {
      Send-Json $stream 413 "Payload Too Large" @{ ok = $false; error = "too_large" }
      return
    }
    $headerByteLen = [System.Text.Encoding]::ASCII.GetByteCount($headerPart) + 4
    $saveBody = ""
    if ($method -eq "POST" -and $bodyLen -gt 0) {
      $saveBody = Read-RequestBody $stream $reqBytes $headerByteLen $bodyLen
    }
    Handle-Save $stream $method $urlPath (Parse-Query $parts[1]) $saveBody
    return
  }

  if ($method -ne "GET") {
    Send-Response $stream 405 "Method Not Allowed" "text/plain; charset=utf-8" `
      ([System.Text.Encoding]::UTF8.GetBytes("Only GET supported")) $null
    return
  }
  if ($urlPath -eq "/") { $urlPath = "/index.html" }

  # Conditional header
  $ims = $null
  foreach ($ln in $lines) {
    if ($ln.ToLower().StartsWith("if-modified-since:")) {
      $ims = $ln.Substring(18).Trim()
    }
  }

  $relFile = $urlPath -replace "^/", "" -replace "/", "\"
  $file = Join-Path $S.Root $relFile
  # Block path traversal
  if (-not (Test-Path $file -PathType Leaf) -or
      -not ((Resolve-Path $file).Path.StartsWith($S.FullRoot))) {
    Send-Response $stream 404 "Not Found" "text/plain; charset=utf-8" `
      ([System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")) $null
    return
  }

  $ext = [System.IO.Path]::GetExtension($file).ToLower()
  $lastWrite = (Get-Item $file).LastWriteTimeUtc
  $needRevalidate = ($S.RevalidateExt -contains $ext)

  if ($needRevalidate -and $ims) {
    try {
      $imsTime = [DateTime]::ParseExact($ims, "R", [Globalization.CultureInfo]::InvariantCulture)
      if ($lastWrite -le $imsTime.AddSeconds(1)) {
        Send-Response $stream 304 "Not Modified" "text/plain; charset=utf-8" $null `
          ("Cache-Control: no-cache`r`nLast-Modified: " + $lastWrite.ToString("R") + "`r`n")
        return
      }
    } catch {}
  }

  $bytes = [System.IO.File]::ReadAllBytes($file)
  if ($S.Mime.ContainsKey($ext)) { $ct = $S.Mime[$ext] }
  else { $ct = "application/octet-stream" }
  if ($needRevalidate) { $cc = "Cache-Control: no-cache`r`n" }
  else { $cc = "Cache-Control: public, max-age=3600`r`n" }
  $extra = $cc + "Last-Modified: " + $lastWrite.ToString("R") + "`r`n" +
           "Accept-Ranges: none`r`n"
  Send-Response $stream 200 "OK" $ct $bytes $extra
}

try {
  Process-Client $Client
} catch {
  Log-Worker ("[ERR] " + $_.Exception.Message)
} finally {
  try { $Client.Close() } catch {}
}
'@

# Announce every LAN URL the phone can use
Write-Host "Blockworld server starting on port $Port ..."
Write-Host "  Local:   http://localhost:$Port/"
try {
  $lanIps = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq "Up" -and $_.NetworkInterfaceType -ne "Loopback" } |
    ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
    Where-Object { [int]$_.Address.AddressFamily -eq 2 -and $_.Address.IPAddressToString -notlike "169.254.*" } |
    ForEach-Object { $_.Address.IPAddressToString }
  foreach ($ip in $lanIps) { Write-Host "  Phone:   http://$ip`:$Port/  (same Wi-Fi)" }
} catch {}

# Dual-mode listener on [::]:port accepts both IPv6 (localhost -> ::1) and
# IPv4 (127.0.0.1 / LAN IPs) without admin (HttpListener would need urlacl).
$endpoint = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::IPv6Any, $Port)
$server = New-Object System.Net.Sockets.TcpListener($endpoint)
try { $server.Server.DualMode = $true } catch {}
$server.Start()

# Runspace pool: every accepted connection runs the worker script on one of
# these runspaces, so the accept loop never blocks on a slow connection.
Add-Type -AssemblyName System.Web.Extensions   # load into the AppDomain up front
$iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault2()
$pool = [runspacefactory]::CreateRunspacePool(8, 32, $iss, $Host)
$pool.Open()
# Prewarm now: runspace creation + first Add-Type/JIT + the first real worker
# path (static file response) costs ~10s on a cold machine. Pay all of it at
# startup via loopback requests so neither player ever sees that first-hit lag.
$warm = @'
param($port)
Add-Type -AssemblyName System.Web.Extensions
try {
  $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/index.html")
  $req.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
  $req.Timeout = 30000
  $resp = $req.GetResponse()
  $resp.Close()
} catch {}
'@
$pre = @()
for ($i = 0; $i -lt 4; $i++) {
  $wp = [powershell]::Create()
  $wp.RunspacePool = $pool
  [void]$wp.AddScript($warm).AddArgument($Port)
  $pre += [pscustomobject]@{ h = $wp.BeginInvoke(); p = $wp }
}
foreach ($w in $pre) { try { $w.p.EndInvoke($w.h) | Out-Null } catch {}; $w.p.Dispose() }
$pending = [System.Collections.Generic.Dictionary[object,object]]::new()

function Receive-Workers {
  foreach ($h in @($pending.Keys)) {
    if ($h.IsCompleted) {
      $p = $pending[$h]
      try { $p.EndInvoke($h) | Out-Null } catch {}
      try {
        foreach ($rec in $p.Streams.Error) {
          try { $logQ.Enqueue("[ERR] " + $rec.ToString()) } catch {}
        }
      } catch {}
      try { $p.Dispose() } catch {}
      [void]$pending.Remove($h)
    }
  }
  $line = $null
  while ($logQ.TryDequeue([ref]$line)) { Write-Host $line }
}

Write-Host "Ready (concurrency pool). Press Ctrl+C to stop."

while ($true) {
  Receive-Workers
  # Backstop: never let queued clients grow without bound under a slow-client flood
  if ($pending.Count -ge 192) { Start-Sleep -Milliseconds 30; continue }

  $client = $null
  try {
    $client = $server.AcceptTcpClient()
    $client.NoDelay = $true
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 10000

    $ps = [powershell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($WorkerScript).AddArgument($client).AddArgument($shared)
    $iar = $ps.BeginInvoke()
    $pending[$iar] = $ps
  } catch {
    Write-Host ("[ERR] accept: " + $_.Exception.Message)
    try { if ($client) { $client.Close() } } catch {}
  }
}
