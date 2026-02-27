# TLS és Proxy beállítások
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[System.Net.WebRequest]::DefaultWebProxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials

$mappa = $PSScriptRoot
if ([string]::IsNullOrEmpty($mappa)) { $mappa = Get-Location }
$jsonFajl = Join-Path $mappa "mnb_EUR.json"
$jsFajl = Join-Path $mappa "mnb_EUR.js"
$csvFajl = Join-Path $mappa "mnb_EUR.csv"

function Get-MnbFullHistory {
    param(
        [string]$start = "2021-01-01",
        [string]$curr = "EUR"
    )
    
    $today = Get-Date -Format "yyyy-MM-dd"
    $url = "http://www.mnb.hu/arfolyamok.asmx"
    
    $ca = @"
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://www.mnb.hu/webservices/">
   <soapenv:Header/><soapenv:Body>
      <web:GetExchangeRates>
         <web:startDate>$start</web:startDate>
         <web:endDate>$today</web:endDate>
         <web:currencyNames>$curr</web:currencyNames>
      </web:GetExchangeRates>
   </soapenv:Body>
</soapenv:Envelope>
"@

    try {
        $webClient = New-Object System.Net.WebClient
        $webClient.Proxy = [System.Net.WebRequest]::DefaultWebProxy
        $webClient.Proxy.Credentials = [System.Net.CredentialCache]::DefaultCredentials
        $webClient.UseDefaultCredentials = $true
        $webClient.Headers.Add("Content-Type", "text/xml; charset=utf-8")
        $webClient.Encoding = [System.Text.Encoding]::UTF8

        Write-Host "Adatok letoltese..." -NoNewline
        $response = $webClient.UploadString($url, $ca)
        Write-Host " OK" -ForegroundColor Green

        [xml]$xmlRes = $response
        [xml]$dataXml = $xmlRes.Envelope.Body.GetExchangeRatesResponse.GetExchangeRatesResult
        $nodes = $dataXml.SelectNodes("//Day")

        # Adatok beolvasása map-be
        $rateMap = @{}
        foreach ($node in $nodes) {
            $val = [double]($node.SelectSingleNode("Rate")."#text".Replace(",", "."))
            $unit = [int]$node.SelectSingleNode("Rate").unit
            $rateMap[$node.date] = $val / $unit
        }

        # Feldolgozás és hiánypótlás
        $fullHistory = @()
        $currentDate = Get-Date $start
        $lastRate = 0.0
        $endDate = Get-Date

        while ($currentDate -le $endDate) {
            $key = $currentDate.ToString("yyyy-MM-dd")
            $isGenerated = 1
            
            if ($rateMap.ContainsKey($key)) {
                $lastRate = $rateMap[$key]
                $isGenerated = 0
            }
            
            if ($lastRate -gt 0) {
                $fullHistory += [PSCustomObject]@{
                    d = $key          # datum
                    e = $lastRate      # ertek
                    g = $isGenerated   # generált-e (0: eredeti, 1: másolt)
                }
            }
            $currentDate = $currentDate.AddDays(1)
        }

        # Metaadatok és inline JSON generálás
        $output = [PSCustomObject]@{
            ts = Get-Date -Format "yyyyMMddHHmmss" # timestamp rövidítve
            cur = $curr
            data = $fullHistory
        }

        # JSON fájl mentése
        #$jsonString = $output | ConvertTo-Json -Depth 10 -Compress
        #$jsonString | Out-File -FilePath $jsonFajl -Encoding utf8
        #Write-Host "JSON fajl letrehozva: $jsonFajl" -ForegroundColor Green

        # JavaScript fájl mentése const változóval
        $jsContent = "const MNB_RATES = $jsonString;"
        $jsContent | Out-File -FilePath $jsFajl -Encoding utf8
        Write-Host "JavaScript fajl letrehozva: $jsFajl" -ForegroundColor Green

        # CSV fájl mentése
        $csvHeader = "Datum;Ertek;Generalt_HETVEGE"
        $csvRows = $fullHistory | ForEach-Object {
            "$($_.d);$($_.e);$($_.g)"
        }
        $csvContent = @($csvHeader) + $csvRows
        $csvContent | Out-File -FilePath $csvFajl -Encoding utf8
        Write-Host "CSV fajl letrehozva: $csvFajl" -ForegroundColor Green

        Write-Host "Osszes bejegyzés szama: $($fullHistory.Count)"
    }
    catch {
        Write-Host " HIBA: $($_.Exception.Message)" -ForegroundColor Red
    }
}

Get-MnbFullHistory
Write-Host "`nBezarashoz nyomj meg egy gombot..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")