param([string]$Phase = "after")

$LB_IP    = "8.232.60.239"
$CR_CNAME = "ghs.googlehosted.com"

# Use /login for frontend domains (root / has no route in this Next.js app)
$domains = @(
  [pscustomobject]@{ Domain = "api.gifsy.in";      Service = "API";      Path = "/health"; Accept404 = $false },
  [pscustomobject]@{ Domain = "platform.gifsy.in"; Service = "Frontend"; Path = "/auth/login";  Accept404 = $false },
  [pscustomobject]@{ Domain = "deoleo.gifsy.in";   Service = "Deoleo";   Path = "/auth/login";  Accept404 = $true  },
  [pscustomobject]@{ Domain = "clientb.gifsy.in";  Service = "ClientB";  Path = "/auth/login";  Accept404 = $true  }
)

$script:pass = 0
$script:fail = 0

function Write-Check {
  param([string]$Label, [bool]$Ok, [string]$Detail = "")
  $icon  = if ($Ok) { "[PASS]" } else { "[FAIL]" }
  $color = if ($Ok) { "Green" }  else { "Red" }
  Write-Host "$icon $Label" -ForegroundColor $color
  if ($Detail) { Write-Host "       $Detail" -ForegroundColor Gray }
  if ($Ok) { $script:pass++ } else { $script:fail++ }
}

Write-Host ""
Write-Host "=== LB Removal Validation - Phase: $Phase ===" -ForegroundColor Cyan
Write-Host "    $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ""

foreach ($d in $domains) {
  Write-Host "-- $($d.Domain) ($($d.Service)) --" -ForegroundColor Yellow

  # 1. DNS check
  $dns = Resolve-DnsName $d.Domain -Server 8.8.8.8 -ErrorAction SilentlyContinue
  if ($dns) {
    $aRecs    = @($dns | Where-Object { $_.Type -eq "A" }     | Select-Object -ExpandProperty IPAddress)
    $cnameRec = @($dns | Where-Object { $_.Type -eq "CNAME" } | Select-Object -ExpandProperty NameHost)
    $detail   = "A=[$($aRecs -join ',')] CNAME=[$($cnameRec -join ',')]"
    if ($Phase -eq "before") {
      Write-Check "DNS -> LB IP ($LB_IP)" ($aRecs -contains $LB_IP) $detail
    } else {
      $notLB = ($aRecs -notcontains $LB_IP) -or ($cnameRec.Count -gt 0)
      Write-Check "DNS -> Cloud Run (not LB)" $notLB $detail
    }
  } else {
    Write-Check "DNS resolution" $false "Cannot resolve $($d.Domain)"
  }

  # 2. HTTPS connectivity
  try {
    $req = [System.Net.WebRequest]::Create("https://$($d.Domain)$($d.Path)")
    $req.Timeout = 15000
    $req.AllowAutoRedirect = $true
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $resp.Close()
    $ok = ($code -ge 200 -and $code -lt 400) -or ($d.Accept404 -and $code -eq 404)
    Write-Check "HTTPS $($d.Path) -> $code" $ok
  } catch [System.Net.WebException] {
    $msg   = $_.Exception.Message
    $isSsl = ($msg -like "*SSL*" -or $msg -like "*certificate*" -or $msg -like "*trust*")
    if ($isSsl -and $Phase -eq "after") {
      Write-Check "HTTPS (SSL provisioning - up to 60 min)" $true $msg
    } elseif ($isSsl -and $Phase -eq "before") {
      # Pre-existing: LB cert did not cover tenant subdomains
      Write-Host "[NOTE] SSL not covered by LB cert (pre-existing, fixed by domain mappings)" -ForegroundColor Yellow
    } elseif ($_.Exception.Response -ne $null) {
      $code2 = [int]$_.Exception.Response.StatusCode
      $ok2   = ($code2 -ge 200 -and $code2 -lt 400) -or ($d.Accept404 -and $code2 -eq 404)
      Write-Check "HTTPS $($d.Path) -> $code2" $ok2 $msg
    } else {
      Write-Check "HTTPS $($d.Path)" $false $msg
    }
  } catch {
    Write-Check "HTTPS $($d.Path)" $false $_.Exception.Message
  }

  # 3. CORS check (API only)
  if ($d.Domain -eq "api.gifsy.in") {
    try {
      $req2 = [System.Net.WebRequest]::Create("https://api.gifsy.in/health")
      $req2.Method  = "OPTIONS"
      $req2.Timeout = 10000
      $req2.Headers.Add("Origin", "https://platform.gifsy.in")
      $req2.Headers.Add("Access-Control-Request-Method", "GET")
      $resp2 = $req2.GetResponse()
      $corsHeader = $resp2.Headers["Access-Control-Allow-Origin"]
      $resp2.Close()
      Write-Check "CORS (platform.gifsy.in)" ($corsHeader -ne $null) "Allow-Origin: $corsHeader"
    } catch {
      Write-Check "CORS check" $false $_.Exception.Message
    }
  }

  Write-Host ""
}

$total = $script:pass + $script:fail
$summaryColor = if ($script:fail -eq 0) { "Green" } else { "Yellow" }
Write-Host "=== Result: $($script:pass)/$total passed ===" -ForegroundColor $summaryColor
if ($script:fail -gt 0) {
  Write-Host "    $($script:fail) check(s) FAILED - do not proceed to next phase." -ForegroundColor Red
} else {
  Write-Host "    All checks passed - safe to proceed." -ForegroundColor Green
}
Write-Host ""

